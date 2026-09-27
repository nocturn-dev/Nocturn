//! Озвучка ответов (TTS): встроенный в Windows SAPI-синтез через PowerShell
//! System.Speech. Принцип Nocturn — ноль сети: голоса локальные, текст
//! уходит во временный файл, скрипт передаётся EncodedCommand (base64
//! UTF-16LE) — ни экранирования, ни поверхности для инъекций.

#[cfg(windows)]
use std::io::Write;
#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::sync::Mutex;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// PID говорящего процесса: новый speak и tts_stop гасят его деревом
/// (внуков PowerShell не бывает, но дерево — конвенция проекта)
#[cfg(windows)]
static TTS_PID: Mutex<Option<u32>> = Mutex::new(None);

#[cfg(windows)]
fn kill_active() {
    if let Some(pid) = TTS_PID
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        crate::proc::kill_tree(pid);
    }
}

/// Озвучить текст. Команда async и разрешается ПО ЗАВЕРШЕНИИ речи —
/// фронтовый индикатор «озвучивается» гаснет сам, без опроса статуса
#[tauri::command(async)]
pub async fn tts_speak(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        speak_impl(text).await
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("TTS реализован для Windows (встроенный SAPI)".into())
    }
}

/// Остановить текущую озвучку (idempotent: не говорит — нечего убивать)
#[tauri::command(async)]
pub fn tts_stop() {
    #[cfg(windows)]
    kill_active();
}

#[cfg(windows)]
async fn speak_impl(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    // Подготовка (temp-файл + скрипт) — fs-работа в blocking-пуле; spawn
    // быстрый, но держим всё в одном блоке для атомарности замены говорящего
    let mut child = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        kill_active();

        // Текст — во временный файл (UTF-8 с BOM: однозначное чтение):
        // лимита длины командной строки нет, экранировать нечего
        let path = std::env::temp_dir().join(format!(
            "nocturn-tts-{}.txt",
            crate::fsutil::uuid_v4_short()
        ));
        {
            let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
            f.write_all(&[0xEF, 0xBB, 0xBF])
                .map_err(|e| e.to_string())?;
            f.write_all(text.as_bytes())
                .map_err(|e| e.to_string())?;
        }

        // Голос под язык текста выбирается в самом скрипте: кириллица →
        // ru-голос из установленных, латиница/прочее → en/дефолт. Скрипт
        // статический, наружу подставляется только наш же путь файла
        // (апостроф в пути удваивается — правило PS-литерала)
        let path_lit = path.display().to_string().replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Speech; \
             $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
             $t = [IO.File]::ReadAllText('{path}', [Text.Encoding]::UTF8); \
             $ru = $t -match '[А-Яа-яЁё]'; \
             $v = $null; \
             foreach ($x in $s.GetInstalledVoices()) {{ \
               $c = $x.VoiceInfo.Culture.Name; \
               if (($ru -and $c -like 'ru*') -or (-not $ru -and $c -like 'en*')) {{ $v = $x.VoiceInfo.Name; break }} \
             }}; \
             if ($v -ne $null) {{ $s.SelectVoice($v) }}; \
             $s.Speak($t); \
             Remove-Item -LiteralPath '{path}' -ErrorAction SilentlyContinue",
            path = path_lit
        );

        // EncodedCommand: base64(UTF-16LE) — PowerShell исполняет строку
        // как есть, кавычки/метасимволы внутри не парсит шелл-ом
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
        cmd.spawn().map_err(|e| format!("cannot start SAPI host: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    let pid = child.id();
    *TTS_PID
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(pid);

    // wait() блокирующий — в spawn_blocking: живой воркер tokio не занимаем
    let status = tauri::async_runtime::spawn_blocking(move || child.wait())
        .await
        .map_err(|e| format!("join error: {e}"))?;

    // Слот чистим только если это всё ещё наш говорящий (новый speak мог
    // уже перезаписать его своим pid)
    let mut slot = TTS_PID.lock().unwrap_or_else(|p| p.into_inner());
    if *slot == Some(pid) {
        *slot = None;
    }
    drop(slot);
    match status {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("tts process: {e}")),
    }
}

/// Выход приложения: не оставляем говорящий процесс сиротой
#[cfg(windows)]
pub fn kill_on_exit() {
    kill_active();
}

#[cfg(not(windows))]
pub fn kill_on_exit() {}
