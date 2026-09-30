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
    // Фаза 1: SAPI рендерит текст во временный WAV (без воспроизведения).
    // Рендер короткий (сотни мс), но это fs+процесс — в blocking-пул
    let wav_path = tauri::async_runtime::spawn_blocking(move || render_wav(&text))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    if CANCELED.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(&wav_path);
        return Ok(());
    }
    // Фаза 2: воспроизведение в выбранное устройство; sleep_until_end
    // блокирующий — тоже в blocking-пул, команда разрешится в конце речи
    let result = tauri::async_runtime::spawn_blocking(move || play_wav(wav_path, output, gen))
        .await
        .map_err(|e| format!("join error: {e}"))?;
    result
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

/// rodio: WAV → выбранное устройство; temp-WAV удаляет сам по завершении.
/// Разрешается по концу воспроизведения; tts_stop/новый speak гасят Sink
/// из любого потока
#[cfg(windows)]
fn play_wav(path: std::path::PathBuf, output: Option<String>, gen: u64) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let file = std::fs::File::open(&path).map_err(|e| format!("tts wav: {e}"))?;
        let source = rodio::Decoder::new_wav(std::io::BufReader::new(file))
            .map_err(|e| format!("tts wav decode: {e}"))?;
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
        sink.append(source);
        *SINK.lock().unwrap_or_else(|p| p.into_inner()) = Some(sink.clone());
        // sleep_until_end вернётся сразу после sink.stop() из tts_stop
        sink.sleep_until_end();
        Ok(())
    })();
    // Temp-wav не переживает воспроизведение в любом исходе
    let _ = std::fs::remove_file(path);
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
