//! Озвучка ответов (TTS): встроенный в Windows SAPI-синтез через PowerShell.
//! Принцип Nocturn — ноль сети: голоса локальные. Двухфазный конвейер:
//! SAPI рендерит текст во временный WAV, затем rodio играет его в
//! ВЫБРАННОЕ устройство вывода (SAPI сам умеет только дефолтное).
//! Команда разрешается по завершении речи — фронтовый индикатор гаснет сам.

#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::Mutex;

#[cfg(windows)]
/// Активный плеер: новый speak и tts_stop гасят его (Sink::stop)
static SINK: Mutex<Option<std::sync::Arc<rodio::Sink>>> = Mutex::new(None);
#[cfg(windows)]
/// Запрос отмены: ставится kill_active, проверяется между фазами
static CANCELED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
/// Поколение воспроизведения: очистка старого потока не должна затирать
/// Sink нового speak (гонка sleep_until_end ↔ новый запуск)
static GEN: AtomicU64 = AtomicU64::new(0);

/// Озвучить текст. Команда async и разрешается ПО ЗАВЕРШЕНИИ речи —
/// фронтовый индикатор «озвучивается» гаснет сам, без опроса статуса.
/// output — имя устройства вывода (audio_outputs); None/пусто — системное
#[tauri::command(async)]
pub async fn tts_speak(text: String, output: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        speak_impl(text, output).await
    }
    #[cfg(not(windows))]
    {
        let _ = (text, output);
        Err("TTS is implemented for Windows (built-in SAPI) only".into())
    }
}

/// Остановить текущую озвучку (idempotent: не говорит — нечего убивать)
#[tauri::command(async)]
pub fn tts_stop() {
    #[cfg(windows)]
    kill_active();
}

/// Список устройств вывода звука для селектора в настройках
#[tauri::command(async)]
pub fn audio_outputs() -> Vec<String> {
    #[cfg(windows)]
    {
        use rodio::cpal::traits::{DeviceTrait, HostTrait};
        let host = rodio::cpal::default_host();
        let Ok(devices) = host.output_devices() else {
            return Vec::new();
        };
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for d in devices {
            if let Ok(name) = d.name() {
                if seen.insert(name.clone()) {
                    out.push(name);
                }
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn kill_active() {
    CANCELED.store(true, Ordering::Relaxed);
    if let Some(sink) = SINK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        sink.stop();
    }
}

#[cfg(windows)]
async fn speak_impl(text: String, output: Option<String>) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    kill_active();
    CANCELED.store(false, Ordering::Relaxed);
    let gen = GEN.fetch_add(1, Ordering::Relaxed) + 1;
    // Фаза 1: SAPI рендерит текст во временные WAV (без воспроизведения).
    // Рендер короткий (сотни мс), но это fs+процесс — в blocking-пул.
    // Текст режется на куски: base64 -EncodedCommand упирается в лимит
    // командной строки Windows (~32767 симв.) уже на ~12 тыс. символов
    // текста — длинные ответы падали с невнятной ошибкой spawn
    let paths = tauri::async_runtime::spawn_blocking(move || render_wavs(&text))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    if CANCELED.load(Ordering::Relaxed) {
        for p in &paths {
            let _ = std::fs::remove_file(p);
        }
        return Ok(());
    }
    // Фаза 2: воспроизведение в выбранное устройство; sleep_until_end
    // блокирующий — тоже в blocking-пул, команда разрешится в конце речи
    let result = tauri::async_runtime::spawn_blocking(move || play_wavs(paths, output, gen))
        .await
        .map_err(|e| format!("join error: {e}"))?;
    result
}

/// Кусок текста, безопасный для -EncodedCommand: лимит в БАЙТАХ UTF-8.
/// Худший случай — ASCII: ×2 в юникодных байтах, т.е. ≤16 КБ UTF-16 на
/// кусок текста + оверхед скрипта → ~22 КБ base64 против потолка 32767
/// симв. командной строки. Кириллица/эмодзи дают МЕНЬШЕ юникодных байт
/// на байт UTF-8 — переполнения нет (подозрение аудита А2-7 не
/// подтвердилось: лимит байтовый, а не посимвольный)
#[cfg(windows)]
const MAX_TTS_CHUNK_CHARS: usize = 8000;

/// Режет текст на куски ≤ MAX_TTS_CHUNK_CHARS по границам предложений;
/// жёсткий разрез — только когда предложение само длиннее лимита
#[cfg(windows)]
fn split_tts_text(text: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        if text.len() - start <= MAX_TTS_CHUNK_CHARS {
            let tail = text[start..].trim();
            if !tail.is_empty() {
                chunks.push(tail.to_string());
            }
            break;
        }
        let mut probe = start + MAX_TTS_CHUNK_CHARS;
        while probe > start && !text.is_char_boundary(probe) {
            probe -= 1;
        }
        let window = &text[start..probe];
        let mut cut = probe;
        if let Some(pos) = window.rfind(['.', '!', '?', '…', '\n']) {
            // Режем после знака (+ хвостовые пробелы), не внутри многобайта
            let abs = start + pos;
            let mut after = abs + text[abs..].chars().next().map_or(1, |c| c.len_utf8());
            while after < text.len() && (text.as_bytes()[after] == b' ' || text.as_bytes()[after] == b'\r') {
                after += 1;
            }
            cut = after;
        } else if !text.is_char_boundary(cut) {
            while cut > start && !text.is_char_boundary(cut) {
                cut -= 1;
            }
        }
        if cut <= start {
            break;
        }
        let piece = text[start..cut].trim();
        if !piece.is_empty() {
            chunks.push(piece.to_string());
        }
        start = cut;
    }
    chunks
}

/// Рендер всех кусков в отдельные WAV; отмена между кусками не тратит
/// время на оставшиеся
#[cfg(windows)]
fn render_wavs(text: &str) -> Result<Vec<std::path::PathBuf>, String> {
    let chunks = split_tts_text(text);
    let mut paths = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if CANCELED.load(Ordering::Relaxed) {
            break;
        }
        paths.push(render_wav(&chunk)?);
    }
    Ok(paths)
}

/// SAPI: текст → WAV-файл. Скрипт статический, наружу подставляется только
/// наш путь (апостроф удваивается — правило PS-литерала); EncodedCommand —
/// ни кавычек, ни метасимволов шелла
#[cfg(windows)]
fn render_wav(text: &str) -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join(format!(
        "nocturn-tts-{}.wav",
        crate::fsutil::rand_hex8()
    ));
    let path_lit = path.display().to_string().replace('\'', "''");
    let text_lit = text.replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Speech; \
         $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $s.SetOutputToWaveFile('{path}', [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)); \
         $s.Speak('{text}'); \
         $s.Dispose()",
        path = path_lit,
        text = text_lit
    );
    use base64::Engine;
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // CREATE_NO_WINDOW: консольное окно из GUI-процесса иначе мигает
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = crate::proc::run_command_opts(&mut cmd, std::time::Duration::from_secs(60), None, None)?;
    if out.timed_out {
        return Err("tts render timed out".into());
    }
    if let Some(code) = out.status {
        if code != 0 {
            return Err(format!("tts render exited with {code}"));
        }
    }
    if !path.exists() {
        return Err("tts render produced no wav".into());
    }
    Ok(path)
}

/// rodio: WAV-файлы → выбранное устройство ПОСЛЕДОВАТЕЛЬНО (sink-очередь);
/// temp-WAV удаляет сам по завершении. Устройство открывается один раз на
/// все куски. Разрешается по концу воспроизведения; tts_stop/новый speak
/// гасят Sink из любого потока
#[cfg(windows)]
fn play_wavs(paths: Vec<std::path::PathBuf>, output: Option<String>, gen: u64) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let device = match output.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(want) => {
                use rodio::cpal::traits::{DeviceTrait, HostTrait};
                let host = rodio::cpal::default_host();
                let mut found = None;
                if let Ok(devices) = host.output_devices() {
                    for d in devices {
                        if d.name().map(|n| n == want).unwrap_or(false) {
                            found = Some(d);
                            break;
                        }
                    }
                }
                let dev = found.ok_or_else(|| format!("output device not found: {want}"))?;
                rodio::OutputStream::try_from_device(&dev)
                    .map_err(|e| format!("output device {want}: {e}"))?
            }
            None => rodio::OutputStream::try_default()
                .map_err(|e| format!("no default output device: {e}"))?,
        };
        let sink = std::sync::Arc::new(
            rodio::Sink::try_new(&device.1).map_err(|e| format!("tts sink: {e}"))?,
        );
        for path in &paths {
            let file = std::fs::File::open(path).map_err(|e| format!("tts wav: {e}"))?;
            let source = rodio::Decoder::new_wav(std::io::BufReader::new(file))
                .map_err(|e| format!("tts wav decode: {e}"))?;
            sink.append(source);
        }
        *SINK.lock().unwrap_or_else(|p| p.into_inner()) = Some(sink.clone());
        // sleep_until_end вернётся сразу после sink.stop() из tts_stop
        sink.sleep_until_end();
        Ok(())
    })();
    // Temp-wav не переживают воспроизведение в любом исходе
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
    // Слот чистим только если это всё ещё наше поколение: новый speak мог
    // уже положить туда свой Sink — его не затираем
    if GEN.load(Ordering::Relaxed) == gen {
        *SINK.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
    result
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Выход приложения: не оставляем играющий звук
#[cfg(windows)]
pub fn kill_on_exit() {
    kill_active();
}

#[cfg(not(windows))]
pub fn kill_on_exit() {}
