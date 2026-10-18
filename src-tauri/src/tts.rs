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
/// Активный токен отмены: держится через Arc, чтобы tts_stop или новый speak
/// гарантированно гасил предыдущий PowerShell-процесс через kill_tree
static CURRENT_CANCEL: Mutex<Option<std::sync::Arc<AtomicBool>>> = Mutex::new(None);
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
    if let Some(cancel) = CURRENT_CANCEL.lock().unwrap_or_else(|p| p.into_inner()).take() {
        cancel.store(true, Ordering::Relaxed);
    }
    if let Some(sink) = SINK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        sink.stop();
    }
}

/// Потолок на общий размер синтезируемого текста: защита от сотен процессов
#[cfg(windows)]
const MAX_TTS_TEXT_BYTES: usize = 64 * 1024;
/// Максимальное число кусков в одном сеансе речи
#[cfg(windows)]
const MAX_TTS_CHUNKS: usize = 16;
/// Кусок текста, безопасный для -EncodedCommand: лимит в БАЙТАХ UTF-8.
#[cfg(any(windows, test))]
const MAX_TTS_CHUNK_BYTES: usize = 8000;

#[cfg(windows)]
async fn speak_impl(text: String, output: Option<String>) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    if text.len() > MAX_TTS_TEXT_BYTES {
        return Err(format!(
            "TTS text exceeds limit of {} KB",
            MAX_TTS_TEXT_BYTES / 1024
        ));
    }
    kill_active();
    let gen = GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel_token = std::sync::Arc::new(AtomicBool::new(false));
    *CURRENT_CANCEL.lock().unwrap_or_else(|p| p.into_inner()) = Some(cancel_token.clone());

    let mut chunks = split_tts_text(&text);
    if chunks.is_empty() {
        return Ok(());
    }
    if chunks.len() > MAX_TTS_CHUNKS {
        chunks.truncate(MAX_TTS_CHUNKS);
    }
    let total_chunks = chunks.len();

    // Конвейер: рендер кусков идёт параллельно в blocking-пуле,
    // а воспроизведение начинается сразу по готовности первого куска
    let (tx, rx) = std::sync::mpsc::channel();
    for (idx, chunk) in chunks.into_iter().enumerate() {
        let tx = tx.clone();
        let cancel = cancel_token.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if cancel.load(Ordering::Relaxed) || gen != GEN.load(Ordering::Relaxed) {
                return;
            }
            let res = render_wav(&chunk, &cancel).map(|p| (idx, p));
            let _ = tx.send(res);
        });
    }
    drop(tx);

    let play_cancel = cancel_token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        play_stream(rx, total_chunks, output, gen, play_cancel)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Режет текст на куски ≤ MAX_TTS_CHUNK_BYTES по границам предложений;
/// жёсткий разрез — только когда предложение само длиннее лимита
#[cfg(any(windows, test))]
fn split_tts_text(text: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        if text.len() - start <= MAX_TTS_CHUNK_BYTES {
            let tail = text[start..].trim();
            if !tail.is_empty() {
                chunks.push(tail.to_string());
            }
            break;
        }
        let mut probe = start + MAX_TTS_CHUNK_BYTES;
        while probe > start && !text.is_char_boundary(probe) {
            probe -= 1;
        }
        let window = &text[start..probe];
        let mut cut = probe;
        let sign_re = |c: char| matches!(c, '.' | '!' | '?' | '…') || c == '\n';
        if let Some(pos) = window.rfind(sign_re) {
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
            cut = probe;
        }
        let piece = text[start..cut].trim();
        if !piece.is_empty() {
            chunks.push(piece.to_string());
        }
        start = cut;
    }
    chunks
}

/// SAPI: текст → WAV-файл. Скрипт статический: текст и путь приходят через
/// переменные окружения, в скрипте их литералов нет вообще
#[cfg(windows)]
fn render_wav(text: &str, cancel: &std::sync::Arc<AtomicBool>) -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join(format!(
        "nocturn-tts-{}.wav",
        crate::fsutil::rand_hex8()
    ));

    struct TmpCleanup(Option<std::path::PathBuf>);
    impl Drop for TmpCleanup {
        fn drop(&mut self) {
            if let Some(ref p) = self.0 {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    let mut cleanup = TmpCleanup(Some(path.clone()));

    let script = "Add-Type -AssemblyName System.Speech; \
         $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $s.SetOutputToWaveFile($env:NOCTURN_TTS_WAV, [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)); \
         $s.Speak($env:NOCTURN_TTS_TEXT); \
         $s.Dispose()";
    use base64::Engine;
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .env("NOCTURN_TTS_TEXT", text)
        .env("NOCTURN_TTS_WAV", &path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // CREATE_NO_WINDOW: консольное окно из GUI-процесса иначе мигает
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = crate::proc::run_command_opts(
        &mut cmd,
        std::time::Duration::from_secs(60),
        None,
        Some(cancel.as_ref()),
    )?;
    if out.aborted || cancel.load(Ordering::Relaxed) {
        return Err("tts render canceled".into());
    }
    if out.timed_out {
        return Err("tts render timed out".into());
    }
    if let Some(code) = out.status {
        if code != 0 {
            let err = out.stderr.trim();
            if err.is_empty() {
                return Err(format!("tts render exited with {code}"));
            } else {
                return Err(format!("tts render exited with {code}: {err}"));
            }
        }
    }
    if !path.exists() {
        return Err("tts render produced no wav".into());
    }
    cleanup.0 = None;
    Ok(path)
}

/// rodio: конвейерное воспроизведение полученных WAV-файлов в выбранное устройство.
/// Воспроизведение начинается сразу с первого готового куска, пока остальные
/// рендерятся в фоне
#[cfg(windows)]
fn play_stream(
    rx: std::sync::mpsc::Receiver<Result<(usize, std::path::PathBuf), String>>,
    total_chunks: usize,
    output: Option<String>,
    gen: u64,
    cancel: std::sync::Arc<AtomicBool>,
) -> Result<(), String> {
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

    if GEN.load(Ordering::Relaxed) != gen || cancel.load(Ordering::Relaxed) {
        sink.stop();
        return Ok(());
    }
    *SINK.lock().unwrap_or_else(|p| p.into_inner()) = Some(sink.clone());

    struct CleanupGuard(Vec<std::path::PathBuf>);
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            for p in &self.0 {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    let mut cleanup = CleanupGuard(Vec::new());

    let mut next_expected = 0usize;
    let mut ready_chunks: std::collections::HashMap<usize, std::path::PathBuf> =
        std::collections::HashMap::new();

    while next_expected < total_chunks {
        if cancel.load(Ordering::Relaxed) || GEN.load(Ordering::Relaxed) != gen {
            sink.stop();
            break;
        }

        if let Some(path) = ready_chunks.remove(&next_expected) {
            let file = std::fs::File::open(&path).map_err(|e| format!("tts wav: {e}"))?;
            let source = rodio::Decoder::new_wav(std::io::BufReader::new(file))
                .map_err(|e| format!("tts wav decode: {e}"))?;
            sink.append(source);
            next_expected += 1;
            continue;
        }

        match rx.recv() {
            Ok(Ok((idx, path))) => {
                cleanup.0.push(path.clone());
                if idx == next_expected {
                    let file = std::fs::File::open(&path).map_err(|e| format!("tts wav: {e}"))?;
                    let source = rodio::Decoder::new_wav(std::io::BufReader::new(file))
                        .map_err(|e| format!("tts wav decode: {e}"))?;
                    sink.append(source);
                    next_expected += 1;
                } else {
                    ready_chunks.insert(idx, path);
                }
            }
            Ok(Err(e)) => {
                sink.stop();
                if cancel.load(Ordering::Relaxed) || GEN.load(Ordering::Relaxed) != gen {
                    return Ok(());
                }
                return Err(e);
            }
            Err(_) => {
                sink.stop();
                if cancel.load(Ordering::Relaxed) || GEN.load(Ordering::Relaxed) != gen {
                    return Ok(());
                }
                return Err("tts render worker disconnected unexpectedly".into());
            }
        }
    }

    if GEN.load(Ordering::Relaxed) == gen && !cancel.load(Ordering::Relaxed) {
        sink.sleep_until_end();
    } else {
        sink.stop();
    }

    if GEN.load(Ordering::Relaxed) == gen {
        *SINK.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
    drop(sink);
    drop(device);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_tts_text_keeps_every_sentence_within_limit() {
        let text = "Первое предложение. ".repeat(1500);
        let chunks = split_tts_text(&text);
        assert!(chunks.len() >= 2);
        let total: usize = chunks.iter().map(|c| c.matches("Первое предложение.").count()).sum();
        assert_eq!(total, 1500, "split lost content");
        assert!(chunks.iter().all(|c| !c.trim().is_empty()));
    }

    #[test]
    fn split_tts_text_short_and_empty() {
        assert_eq!(split_tts_text("Привет"), vec!["Привет"]);
        assert!(split_tts_text("   ").is_empty());
    }

    #[test]
    fn split_tts_text_hard_split_respects_char_boundary() {
        let text = "ё".repeat(MAX_TTS_CHUNK_BYTES + 10);
        let chunks = split_tts_text(&text);
        assert!(chunks.len() >= 2);
        assert_eq!(
            chunks.concat().chars().count(),
            MAX_TTS_CHUNK_BYTES + 10,
            "hard split lost characters"
        );
    }
}
