//! M6.1: интерактивный PTY-терминал (portable-pty).
//! Сессия ConPTY: PowerShell под управлением пользователя.
//! Вывод читается фоновым потоком и уходит наружу через callback
//! (в команде — Tauri-событие), с посимвольной сборкой UTF-8 на границах чанков.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

/// Ручки живой PTY-сессии.
/// FIX [дедлок]: child вынесен в ОТДЕЛЬНЫЙ мьютекс от writer/master. Раньше
/// pty_write держал общий мьютекс сессии на блокирующем write_all (шелл не
/// читает пайп — write стоит вечно), и pty_kill/kill_all ждали тот же лок —
/// зависший процесс было невозможно убить.
pub struct PtySession {
    /// writer + master: сериализуются одним локом (запись и resize)
    pub io: Mutex<PtyIo>,
    /// Процесс шелла — убивается без ожидания io-лока
    pub child: Mutex<Box<dyn Child + Send + Sync>>,
}

/// Писатель и master-PTY одной сессии
pub struct PtyIo {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
}

/// Реестр сессий: id → сессия (по образцу AbortRegistry).
/// Сессия — Arc<PtySession>: блокировки внутри PtySession (io/child),
/// внешний мьютекс не нужен и не должен участвовать в дедлок-сценариях.
pub struct PtyRegistry(pub Mutex<HashMap<String, Arc<PtySession>>>);

impl PtyRegistry {
    /// Гасим все сессии при выходе приложения — иначе возможен осиротевший PowerShell
    pub fn kill_all(&self) {
        let map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for s in map.values() {
            // FIX: убиваем через отдельный child-лок — без ожидания io
            if let Ok(mut c) = s.child.lock() {
                let _ = c.kill();
            }
        }
    }
}

const PTY_OUTPUT_LIMIT: usize = 1024 * 1024; // предохранитель на накопитель декодера

/// Команда шелла по выбору пользователя.
/// Windows: None/auto — PowerShell, "cmd" — cmd.exe, "gitbash" — Git Bash.
/// macOS/Linux: None/auto — $SHELL (fallback bash → zsh → sh); "cmd" и
/// "gitbash" — Windows-специфичные, трактуются как auto. Без ветки для Unix
/// дефолтный `powershell` не находился и весь терминал был неработоспособен.
/// Ветви строго #[cfg] compile-time: внутри Windows-ветки зовётся
/// find_git_bash(), существующий только на Windows (cfg!() — рантайм-макрос,
/// обе его ветки обязаны компилироваться на всех ОС).
fn build_shell_command(shell: Option<&str>, cwd: Option<&str>) -> Result<CommandBuilder, String> {
    let picked = shell.map(str::to_ascii_lowercase);
    #[cfg(windows)]
    let mut cmd = match picked.as_deref() {
        Some("cmd") => CommandBuilder::new("cmd.exe"),
        Some("gitbash") => {
            let bash = find_git_bash()
                .ok_or("Git Bash not found: install Git for Windows or pick another shell")?;
            let mut c = CommandBuilder::new(bash);
            c.args(["--login", "-i"]);
            c
        }
        _ => {
            let mut c = CommandBuilder::new("powershell");
            c.args(["-NoLogo", "-NoProfile"]);
            c
        }
    };
    #[cfg(not(windows))]
    let mut cmd = {
        // "cmd"/"gitbash" на Unix трактуются как auto
        let s =
            unix_shell().ok_or("no shell found: set $SHELL or install bash/zsh/sh")?;
        CommandBuilder::new(s)
    };
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    Ok(cmd)
}

/// Shell по умолчанию для macOS/Linux: $SHELL пользователя, затем
/// стандартные места установки bash/zsh/sh
#[cfg(not(windows))]
fn unix_shell() -> Option<String> {
    if let Ok(s) = std::env::var("SHELL") {
        if std::path::Path::new(&s).exists() {
            return Some(s);
        }
    }
    let candidates = [
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/sh",
        "/usr/bin/sh",
    ];
    candidates
        .into_iter()
        .find(|c| std::path::Path::new(c).exists())
        .map(str::to_string)
}

/// Поиск bash.exe из Git for Windows в стандартных местах установки
#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let pf86 =
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
    let mut candidates = vec![
        format!("{pf}\\Git\\bin\\bash.exe"),
        format!("{pf86}\\Git\\bin\\bash.exe"),
    ];
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!("{la}\\Programs\\Git\\bin\\bash.exe"));
    }
    candidates
        .into_iter()
        .find(|c| std::path::Path::new(c).exists())
}

/// Рождение PTY: выбранный шелл в cwd, читатель в отдельном потоке.
/// `on_output` вызывается из потока-читателя с корректно декодированным UTF-8.
pub fn spawn_pty(
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_output: impl Fn(String) + Send + 'static,
    on_exit: impl Fn() + Send + 'static,
) -> Result<Arc<PtySession>, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let cmd = build_shell_command(shell.as_deref(), cwd.as_deref())?;
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;
    drop(pair.slave); // иначе EOF по master не придёт после выхода шелла

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    if pending.len() > PTY_OUTPUT_LIMIT {
                        // Аномалия: не собирается валидный UTF-8 — сбрасываем
                        pending.clear();
                        continue;
                    }
                    match std::str::from_utf8(&pending) {
                        Ok(s) => {
                            on_output(s.to_string());
                            pending.clear();
                        }
                        Err(e) if e.error_len().is_none() => {
                            // Мультибайт разрезан посередине — ждём остаток
                            let valid = e.valid_up_to();
                            if valid > 0 {
                                on_output(
                                    String::from_utf8_lossy(&pending[..valid]).to_string(),
                                );
                                pending.drain(..valid);
                            }
                        }
                        Err(_) => {
                            // Битые байты — отдаём с заменой, не зависаем
                            on_output(String::from_utf8_lossy(&pending).to_string());
                            pending.clear();
                        }
                    }
                }
                Err(_) => break,
            }
        }
        on_exit();
    });

    Ok(Arc::new(PtySession {
        io: Mutex::new(PtyIo {
            writer,
            master: pair.master,
        }),
        child: Mutex::new(child),
    }))
}

#[tauri::command(async)]
pub async fn pty_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyRegistry>,
    id: String,
    cwd: Option<String>,
    // "cmd" | "gitbash" | None/auto (PowerShell); применяется к новым сессиям
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    {
        let reg = state.0.lock().map_err(|e| e.to_string())?;
        if reg.contains_key(&id) {
            return Ok(()); // уже запущена — переиспользуем
        }
    }
    let app_out = app.clone();
    let out_id = id.clone();
    let exit_id = id.clone();
    // openpty + spawn PowerShell — блокирующие вызовы: уводим из команды,
    // чтобы не замораживать вызвавший поток
    let session = tauri::async_runtime::spawn_blocking(move || {
        spawn_pty(
            cwd,
            shell,
            cols.clamp(20, 500),
            rows.clamp(5, 200),
            move |s| {
                use tauri::Emitter;
                let _ = app_out.emit("pty-output", PtyEvent { id: out_id.clone(), data: s });
            },
            move || {
                use tauri::Emitter;
                let _ = app.emit("pty-exit", exit_id.clone());
            },
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    // TOCTOU: между первоначальной проверкой и insert параллельный pty_create
    // с тем же id мог вставить свою сессию. Повторная проверка под локом.
    let mut reg = state.0.lock().map_err(|e| e.to_string())?;
    if reg.contains_key(&id) {
        // Слот уже занят — убиваем только что созданную сессию, чтобы не
        // оставить живой PowerShell-процесс и поток чтения; семантика
        // «уже существует — ок» сохраняется.
        drop(reg);
        // FIX: отдельный child-лок — kill больше не соревнуется с io
        if let Ok(mut c) = session.child.lock() {
            let _ = c.kill();
        }
        return Ok(());
    }
    reg.insert(id, session);
    Ok(())
}

#[derive(serde::Serialize, Clone)]
pub struct PtyEvent {
    pub id: String,
    pub data: String,
}

#[tauri::command(async)]
pub async fn pty_write(
    state: tauri::State<'_, PtyRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    let session = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no pty session: {id}"))?;
    // write_all блокируется, если зависший шелл не читает пайп, —
    // держим его вне потока UI. Лочим только io: kill остаётся доступным
    // (child в отдельном мьютексе), даже пока write стоит навсегда.
    tauri::async_runtime::spawn_blocking(move || {
        let mut io = session.io.lock().map_err(|e| e.to_string())?;
        io.writer
            .write_all(data.as_bytes())
            .and_then(|_| io.writer.flush())
            .map_err(|e| format!("pty write failed: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub async fn pty_resize(
    state: tauri::State<'_, PtyRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no pty session: {id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let io = session.io.lock().map_err(|e| e.to_string())?;
        io.master
            .resize(PtySize {
                rows: rows.clamp(5, 200),
                cols: cols.clamp(20, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize failed: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub async fn pty_kill(state: tauri::State<'_, PtyRegistry>, id: String) -> Result<(), String> {
    let session = state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(s) = session {
        tauri::async_runtime::spawn_blocking(move || {
            // FIX: отдельный child-лок — kill срабатывает, даже если
            // pty_write застрял в write_all на io-локе
            if let Ok(mut c) = s.child.lock() {
                let _ = c.kill();
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn pty_echo_roundtrip() {
        let (tx, rx) = mpsc::channel::<String>();
        let session = spawn_pty(None, None, 100, 30, move |s| tx.send(s).unwrap(), || {})
            .expect("spawn pty");

        // Даём PowerShell подняться и присылаем команду
        std::thread::sleep(Duration::from_millis(1500));
        {
            let mut io = session.io.lock().unwrap();
            io.writer.write_all(b"echo haloui-pty\r\n").unwrap();
            io.writer.flush().unwrap();
        }

        // Собираем вывод до появления эха. Важно: PSReadLine на старте шлёт
        // DSR (ESC[6n — запрос позиции курсора) и ждёт ответа; без ответа
        // шелл молчит. Отвечаем как настоящий терминал: ESC[row;col R.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut acc = String::new();
        let mut responded = false;
        loop {
            if std::time::Instant::now() > deadline {
                panic!("echo not received in time, got: {acc:?}");
            }
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(s) => acc.push_str(&s),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
            if !responded {
                if let Some(pos) = acc.find("\u{1b}[6n") {
                    responded = true;
                    let mut io = session.io.lock().unwrap();
                    io.writer.write_all(b"\x1b[1;1R").unwrap();
                    io.writer.flush().unwrap();
                    acc.replace_range(pos..pos + 4, "");
                }
            }
            if acc.contains("haloui-pty") {
                break;
            }
        }
        assert!(acc.contains("haloui-pty"), "got: {acc:?}");

        session.child.lock().unwrap().kill().ok();
    }
}
