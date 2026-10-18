//! Voice Wake («Jarvis-режим»): локальный детектор активационной фразы.
//! Инференс — в вебвью (openWakeWord ONNX через onnxruntime-web, WASM,
//! полностью офлайн), Rust отвечает только за скачивание моделей в
//! app_data/voice и выдачу их байтов фронту. Паттерн — dictation.rs:
//! стрим в temp + rename, прогресс событием, один активный скачивающий.

use base64::Engine;
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

const MODEL_BASE: &str =
    "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
/// Фичевые модели (общие для всех фраз) + wake-модели по ключу выбора.
/// Размеры ~1 МБ каждая: весь набор — единицы мегабайт, не whisper-овские 57
const FEATURE_FILES: &[&str] = &["melspectrogram.onnx", "embedding_model.onnx"];
const WAKE_FILES: &[(&str, &str)] = &[
    ("hey_jarvis", "hey_jarvis_v0.1.onnx"),
    ("hey_mycroft", "hey_mycroft_v0.1.onnx"),
];
/// SHA-256 эталонных файлов (релиз v0.5.1, хэши сняты с самих ассетов).
/// GitHub не отдаёт digest для старых релизов, поэтому сверка локальная:
/// без неё обрезанный/подменённый ответ переименовывался в «модель»
const MODEL_SHA256: &[(&str, &str)] = &[
    (
        "melspectrogram.onnx",
        "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    ),
    (
        "embedding_model.onnx",
        "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
    ),
    (
        "hey_jarvis_v0.1.onnx",
        "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
    ),
    (
        "hey_mycroft_v0.1.onnx",
        "c2a311e8fa1338de89c31b3b46dc4dffd4af2f9a8d6ddead48893c2d301b1f18",
    ),
];

fn expected_sha256(name: &str) -> Option<&'static str> {
    MODEL_SHA256
        .iter()
        .find(|(file, _)| *file == name)
        .map(|(_, hash)| *hash)
}

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

fn wake_file(wake_model: &str) -> Option<&'static str> {
    WAKE_FILES
        .iter()
        .find(|(key, _)| *key == wake_model)
        .map(|(_, file)| *file)
}

/// Белый список имён для voice_read_model: вебвью запрашивает файл по имени,
/// путь строится только из констант — traversal исключён по построению
fn is_known_model_file(name: &str) -> bool {
    FEATURE_FILES.contains(&name)
        || WAKE_FILES.iter().any(|(_, file)| *file == name)
}

fn voice_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voice"))
}

#[derive(Serialize)]
pub struct VoiceFileStatus {
    pub name: String,
    pub exists: bool,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct VoiceStatus {
    pub files: Vec<VoiceFileStatus>,
    pub downloading: bool,
}

/// Статус моделей: какие файлы уже на диске. wake_model — выбранный на
/// фронте ключ («hey_jarvis»), его файл проверяется вместе с фичевыми
#[tauri::command(async)]
pub async fn voice_status(app: tauri::AppHandle, wake_model: String) -> Result<VoiceStatus, String> {
    // metadata-опрос файлов моделей — sync-диск, в blocking-пул:
    // на сетевом AppData морозил tokio-воркер под SSE
    tauri::async_runtime::spawn_blocking(move || voice_status_impl(&app, &wake_model))
        .await
        .map_err(|e| format!("voice status task failed: {e}"))?
}

fn voice_status_impl(app: &tauri::AppHandle, wake_model: &str) -> Result<VoiceStatus, String> {
    let dir = voice_dir(app)?;
    let mut names: Vec<&str> = FEATURE_FILES.to_vec();
    if let Some(w) = wake_file(wake_model) {
        names.push(w);
    }
    let files = names
        .iter()
        .map(|name| {
            let (exists, bytes) = std::fs::metadata(dir.join(name))
                .map(|m| (true, m.len()))
                .unwrap_or((false, 0));
            VoiceFileStatus {
                name: (*name).to_string(),
                exists,
                bytes,
            }
        })
        .collect();
    Ok(VoiceStatus {
        files,
        downloading: DOWNLOADING.load(Ordering::Relaxed),
    })
}

/// Скачать недостающие модели (фичевые + выбранная wake): стрим в temp +
/// rename, прогресс — событием voice-progress {file, received, total}
#[tauri::command(async)]
pub async fn voice_download_models(
    app: tauri::AppHandle,
    wake_model: String,
) -> Result<(), String> {
    if wake_file(&wake_model).is_none() {
        return Err(format!("unknown wake model: {wake_model}"));
    }
    if DOWNLOADING.swap(true, Ordering::Relaxed) {
        return Err("model download already in progress".into());
    }
    // store(false) обычным кодом после await — паника
    // внутри do_download оставляла флаг взведённым до рестарта. RAII
    struct FlagGuard;
    impl Drop for FlagGuard {
        fn drop(&mut self) {
            DOWNLOADING.store(false, Ordering::Relaxed);
        }
    }
    let _guard = FlagGuard;
    do_download(&app, &wake_model).await
}

async fn do_download(app: &tauri::AppHandle, wake_model: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let dir = voice_dir(app)?;
    let mut names: Vec<&str> = FEATURE_FILES.to_vec();
    if let Some(w) = wake_file(wake_model) {
        names.push(w);
    }
    // create_dir_all + exists-опрос недостающих моделей — sync-диск на
    // async-пути, в blocking-пул: в цикле остаются только
    // реально недостающие имена
    let names = tauri::async_runtime::spawn_blocking({
        let dir = dir.clone();
        move || -> Result<Vec<&'static str>, String> {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut needed = Vec::new();
            for name in names {
                let p = dir.join(name);
                if !p.exists() {
                    needed.push(name);
                    continue;
                }
                // Нулевой файл после сбоя питания удаляем и перекачиваем
                if let Ok(m) = std::fs::metadata(&p) {
                    if m.len() == 0 {
                        let _ = std::fs::remove_file(&p);
                        needed.push(name);
                        continue;
                    }
                }
            }
            Ok(needed)
        }
    })
    .await
    .map_err(|e| format!("voice download task failed: {e}"))??;
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;
    for name in names {
        let final_path = dir.join(name);
        if final_path.exists() {
            continue; // уже скачана — повторное включение безвредно
        }
        let url = format!("{MODEL_BASE}/{name}");
        // Total-таймаут на файл: connect_timeout не спасает от stalled-
        // соединения (молчащий прокси, NAT без RST) — включение wake
        // висело вечно
        let dl = async {
            let resp = client
                .get(&url)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| format!("model download failed: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("model download {name}: HTTP {}", resp.status().as_u16()));
            }
            let total = resp.content_length().unwrap_or(0);
            let tmp = dir.join(format!("{name}.tmp"));
            let mut file = tokio::fs::File::create(&tmp)
                .await
                .map_err(|e| e.to_string())?;
            // Guard удаляет временный файл при любом исходе до успешного rename
            struct TmpGuard<'a>(&'a std::path::Path);
            impl Drop for TmpGuard<'_> {
                fn drop(&mut self) {
                    let _ = std::fs::remove_file(self.0);
                }
            }
            let tmp_guard = TmpGuard(&tmp);
            let mut received: u64 = 0;
            let mut last_emit: u64 = 0;
            let mut stream = resp;
            const CHUNK_STALL: std::time::Duration = std::time::Duration::from_secs(30);
            while let Some(chunk) = match tokio::time::timeout(CHUNK_STALL, stream.chunk()).await {
                Ok(Ok(c)) => c,
                Ok(Err(e)) => return Err(format!("model download interrupted: {e}")),
                Err(_) => return Err("model download stalled: no data for 30s".to_string()),
            } {
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                received += chunk.len() as u64;
                // Файлы ~1 МБ: прогресс шлём дважды — начало и конец
                if received - last_emit >= 512 * 1024 {
                    last_emit = received;
                    let _ = app.emit_to(
                        "main",
                        "voice-progress",
                        json!({ "file": name, "received": received, "total": total }),
                    );
                }
            }
            file.flush().await.map_err(|e| e.to_string())?;
            file.sync_all().await.map_err(|e| e.to_string())?;
            drop(file);
            if received == 0 {
                return Err(format!("model download {name}: empty response"));
            }
            if total > 0 && received != total {
                return Err(format!(
                    "model download {name} incomplete: {received} of {total} bytes"
                ));
            }
            // Дайджест сверяется ДО rename: битый файл остаётся .tmp-мусором
            let digest = tauri::async_runtime::spawn_blocking({
                let tmp = tmp.clone();
                move || crate::fsutil::sha256_file_hex(&tmp)
            })
            .await
            .map_err(|e| format!("voice download task failed: {e}"))??;
            match expected_sha256(name) {
                Some(expected) if !digest.eq_ignore_ascii_case(expected) => {
                    return Err(format!(
                        "model download {name}: sha256 mismatch (got {digest}, expected {expected})"
                    ));
                }
                Some(_) => {}
                None => {
                    return Err(format!("model download {name}: no pinned sha256"));
                }
            }
            std::mem::forget(tmp_guard); // успех: tmp переименован, guard не удаляет
            std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
            let _ = app.emit_to(
                "main",
                "voice-progress",
                json!({ "file": name, "received": received, "total": received }),
            );
            Ok::<(), String>(())
        };
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(120), dl)
            .await
            .unwrap_or_else(|_| Err(format!("model download {name}: timed out after 120s")));
        if let Err(e) = &outcome {
            // Окно прогресса слышит только события: без этого рапорта оно
            // молча исчезает или висит на последнем проценте при срыве
            let _ = app.emit_to(
                "main",
                "voice-progress",
                json!({ "file": name, "received": 0u64, "total": 0u64, "error": e }),
            );
        }
        outcome?;
    }
    Ok(())
}

/// Байты модели для вебвью (base64): ort-web создаёт сессию из ArrayBuffer.
/// Имя строго из белого списка — путь конструируется только из констант.
/// ~1 МБ на файл через IPC один раз при старте слушателя — приемлемо
#[tauri::command(async)]
pub async fn voice_read_model(app: tauri::AppHandle, name: String) -> Result<String, String> {
    // ~1 МБ чтения + base64: blocking-пул (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        if !is_known_model_file(&name) {
            return Err(format!("unknown model file: {name}"));
        }
        let dir = voice_dir(&app)?;
        let data = std::fs::read(dir.join(&name))
            .map_err(|e| format!("model file {name} is not downloaded yet: {e}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(data))
    })
    .await
    .map_err(|e| format!("voice model read task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Регресс: voice_read_model — единственная команда, принимающая имя
    /// файла от вебвью; белый список обязан отсекать пути
    #[test]
    fn model_file_whitelist_rejects_traversal() {
        assert!(is_known_model_file("melspectrogram.onnx"));
        assert!(is_known_model_file("embedding_model.onnx"));
        assert!(is_known_model_file("hey_jarvis_v0.1.onnx"));
        assert!(is_known_model_file("hey_mycroft_v0.1.onnx"));
        assert!(!is_known_model_file("../settings.json"));
        assert!(!is_known_model_file("settings.json"));
        assert!(!is_known_model_file("c:\\windows\\system32\\cmd.exe"));
        assert!(!is_known_model_file(""));
        assert!(!is_known_model_file("melspectrogram.onnx.tmp"));
    }

    #[test]
    fn wake_model_keys_resolve_to_files() {
        assert_eq!(wake_file("hey_jarvis"), Some("hey_jarvis_v0.1.onnx"));
        assert_eq!(wake_file("hey_mycroft"), Some("hey_mycroft_v0.1.onnx"));
        assert_eq!(wake_file("alexa"), None);
    }

    /// Каждый скачиваемый файл обязан иметь эталонный дайджест: появление
    /// нового файла без хэша в таблице — провал сборки, а не тихая загрузка
    #[test]
    fn every_downloaded_model_has_pinned_sha256() {
        for f in FEATURE_FILES {
            assert!(expected_sha256(f).is_some(), "{f} has no pinned sha256");
        }
        for (_, f) in WAKE_FILES {
            assert!(expected_sha256(f).is_some(), "{f} has no pinned sha256");
        }
    }

    #[test]
    fn pinned_sha256_format_valid() {
        for (name, hash) in MODEL_SHA256 {
            assert_eq!(hash.len(), 64, "hash for {name} must be 64 hex chars");
            assert!(
                hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "hash for {name} must be lowercase hex"
            );
        }
    }
}
