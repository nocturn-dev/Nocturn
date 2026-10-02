//! Диктовка (Whisper): push-to-talk в композере. Аудио ловит вебвью
//! (getUserMedia → PCM 16 кГц моно → base64), транскрибирует внешний
//! whisper-cli через proc::run_command_opts — процессная изоляция, C++
//! не входит в сборку, производительность приложения не затрагивается:
//! модель живёт в памяти только на время транскрипции.

use base64::Engine;
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Мультиязычная base-модель в квантовании (автоопределение языка):
/// ~57 МБ, на CPU транскрибирует быстрее реального времени
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin";
const MODEL_FILE: &str = "ggml-base-q5_1.bin";
/// ~6,5 минуты звука 16 кГц int16 (12 МБ / 2 байта / 16000 Гц) — потолок
/// на один запрос диктовки
const MAX_AUDIO_BYTES: usize = 12 * 1024 * 1024;
const CLI_TIMEOUT: Duration = Duration::from_secs(180);

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct DictationConfig {
    /// Путь к whisper-cli (whisper.cpp). None — ищем в PATH
    pub cli_path: Option<String>,
    /// Своя модель .bin; None — скачанная из appdata/whisper
    pub model_path: Option<String>,
}

fn config(app: &tauri::AppHandle) -> DictationConfig {
    crate::settings::read_json_config(app, "dictation.json")
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// whisper-cli: заданный в конфиге путь (если существует) либо поиск в PATH.
/// None — CLI нет: фронт покажет подсказку по установке. Автодетект кэшируется
/// по значению конфига: status дергается из UI при каждом открытии настроек,
/// а where/which — запуск процесса на каждый опрос
static CLI_PROBE: std::sync::Mutex<Option<(Option<String>, Option<String>)>> =
    std::sync::Mutex::new(None);

fn detect_cli(configured: Option<&str>) -> Option<String> {
    if let Some(p) = configured {
        // Задан явно: не существует — не подменяем другим (паттерн browser.rs)
        return std::path::Path::new(p)
            .exists()
            .then(|| p.to_string());
    }
    let key = configured.map(str::to_string);
    let mut probe_cache = CLI_PROBE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((cached_key, hit)) = probe_cache.as_ref() {
        if *cached_key == key {
            return hit.clone();
        }
    }
    let mut probe = std::process::Command::new(if cfg!(windows) { "where" } else { "which" });
    probe.arg("whisper-cli");
    let found = crate::proc::run_command_opts(&mut probe, Duration::from_secs(5), None, None)
        .ok()
        .and_then(|out| {
            out.stdout
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(str::to_string)
        });
    *probe_cache = Some((key, found.clone()));
    found
}

fn model_file(app: &tauri::AppHandle, configured: Option<&str>) -> PathBuf {
    match configured {
        Some(p) => PathBuf::from(p),
        None => app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("whisper")
            .join(MODEL_FILE),
    }
}

/// camelCase обязателен: Tauri отдаёт payload как есть (serde), а фронт
/// типизирован под cliFound/modelExists — без rename_all поля приходили
/// snake_case, UI вечно показывал «whisper-cli не найден», даже когда путь
/// был корректно указан через диалог (фидбек 29.09)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub cli_found: bool,
    pub cli_path: Option<String>,
    pub model_exists: bool,
    pub model_bytes: u64,
    pub downloading: bool,
}

#[tauri::command(async)]
pub async fn dictation_status(app: tauri::AppHandle) -> DictationStatus {
    // Запуск пробы where/which (до 5 с таймаут) + метаданные модели —
    // в blocking-пул, а не на воркер tokio со стримами (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || dictation_status_impl(app))
        .await
        .unwrap_or_else(|_| DictationStatus {
            cli_found: false,
            cli_path: None,
            model_exists: false,
            model_bytes: 0,
            downloading: DOWNLOADING.load(Ordering::Relaxed),
        })
}

fn dictation_status_impl(app: tauri::AppHandle) -> DictationStatus {
    let cfg = config(&app);
    let model = model_file(&app, cfg.model_path.as_deref());
    let (exists, bytes) = std::fs::metadata(&model)
        .map(|m| (true, m.len()))
        .unwrap_or((false, 0));
    let cli_path = detect_cli(cfg.cli_path.as_deref());
    DictationStatus {
        cli_found: cli_path.is_some(),
        cli_path,
        model_exists: exists,
        model_bytes: bytes,
        downloading: DOWNLOADING.load(Ordering::Relaxed),
    }
}

/// Сохранить конфиг (путь к CLI). Отдельная команда вместо settings_write_all:
/// dictation.json меняется из своей строки настроек, без общего импорта.
/// Мержим в текущий конфиг, а не перезаписываем: `json!({"cli_path"})` стирал
/// model_path импортированного конфига при первом же сохранении из UI
#[tauri::command(async)]
pub fn dictation_set_config(
    app: tauri::AppHandle,
    cli_path: Option<String>,
) -> Result<(), String> {
    let mut cur = crate::settings::read_json_config(&app, "dictation.json")
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    cur.insert("cli_path".into(), json!(cli_path));
    crate::settings::save_json_config(&app, "dictation.json", &serde_json::Value::Object(cur))
}

/// Скачать модель (~57 МБ) с Hugging Face: стрим в temp + rename, прогресс —
/// событием dictation-progress. Один активный скачивающий (AtomicBool-гейт)
#[tauri::command(async)]
pub async fn dictation_download_model(app: tauri::AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::Relaxed) {
        return Err("model download already in progress".into());
    }
    let result = match tokio::time::timeout(std::time::Duration::from_secs(600), do_download(&app))
        .await
    {
        Ok(r) => r,
        // Total-таймаут: shared_client ставит только connect_timeout —
        // stalled-соединение висело вечно, а DOWNLOADING сбрасывался только
        // по возврату do_download, т.е. флаг залипал до рестарта приложения
        Err(_) => Err("model download timed out after 600s".into()),
    };
    DOWNLOADING.store(false, Ordering::Relaxed);
    result
}

async fn do_download(app: &tauri::AppHandle) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let final_path = dir.join(MODEL_FILE);
    if final_path.exists() {
        return Ok(()); // уже скачана — повторный клик безвреден
    }
    let tmp = dir.join(format!("{MODEL_FILE}.tmp"));
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;
    let resp = client
        .get(MODEL_URL)
        .send()
        .await
        .map_err(|e| format!("model download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("model download: HTTP {}", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| e.to_string())?;
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = resp;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("model download interrupted: {e}"))?
    {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        // Прогресс не чаще ~1 МБ — IPC-канал не спамим
        if received - last_emit >= 1024 * 1024 {
            last_emit = received;
            let _ = app.emit(
                "dictation-progress",
                json!({ "received": received, "total": total }),
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if received == 0 {
        let _ = std::fs::remove_file(&tmp);
        return Err("model download: empty response".into());
    }
    std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "dictation-progress",
        json!({ "received": received, "total": received }),
    );
    Ok(())
}

/// Транскрипция: base64(int16 LE PCM 16 кГц моно) → wav в temp → whisper-cli
/// → текст. Файл удаляется сразу после запуска CLI.
#[tauri::command(async)]
pub async fn dictation_transcribe(
    app: tauri::AppHandle,
    audio_base64: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe_impl(&app, audio_base64))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn transcribe_impl(app: &tauri::AppHandle, audio_base64: String) -> Result<String, String> {
    let cfg = config(app);
    let cli = detect_cli(cfg.cli_path.as_deref())
        .ok_or("whisper-cli not found — install whisper.cpp and add it to PATH, or set the path in settings")?;
    let model = model_file(app, cfg.model_path.as_deref());
    if !model.exists() {
        return Err("whisper model not downloaded yet — use the download button in settings".into());
    }
    if audio_base64.len() > MAX_AUDIO_BYTES / 3 * 4 {
        return Err("recording too long (max ~3 minutes)".into());
    }
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("bad audio payload: {e}"))?;
    if pcm.len() < 3200 {
        return Err("recording is too short".into());
    }
    // WAV: RIFF-заголовок + int16 LE PCM (16 кГц, моно) — руками, без зависимостей
    let mut wav = Vec::with_capacity(pcm.len() + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&((pcm.len() + 36) as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // моно
    wav.extend_from_slice(&16000u32.to_le_bytes()); // sample rate
    wav.extend_from_slice(&32000u32.to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(&pcm);

    let wav_path = std::env::temp_dir().join(format!("nocturn-dictation-{}.wav", crate::fsutil::rand_hex8()));
    // 600 с момента создания: голый fs::write на общем /tmp оставлял
    // world-readable окно с голосовой записью до конца транскрипции
    crate::fsutil::write_private(&wav_path, &wav)?;

    let mut cmd = std::process::Command::new(&cli);
    cmd.arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&wav_path)
        // -np: без логов; -nt: без таймстампов — в stdout только текст
        .args(["-np", "-nt"]);
    let out = crate::proc::run_command_opts(&mut cmd, CLI_TIMEOUT, None, None);
    let _ = fs::remove_file(&wav_path); // временный wav не переживает транскрипцию
    let out = out?;
    if out.timed_out {
        return Err(format!("whisper-cli timed out after {}s", CLI_TIMEOUT.as_secs()));
    }
    if let Some(code) = out.status {
        if code != 0 {
            let err = out.stderr.trim().to_string();
            return Err(if err.is_empty() {
                format!("whisper-cli exited with {code}")
            } else {
                err
            });
        }
    }
    // Страховка от таймстампов (если у CLI нет -nt): строки с [.. --> ..] срезаем
    let text: String = out
        .stdout
        .lines()
        .map(|l| {
            // "[00:00:00.000 --> 00:00:05.000]  текст" → текст
            l.find("] ")
                .and_then(|i| l.strip_prefix('[').map(|_| &l[i + 2..]))
                .unwrap_or(l)
        })
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(text.trim().to_string())
}
