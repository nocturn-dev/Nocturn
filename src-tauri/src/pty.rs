//! M6.1: интерактивный PTY-терминал (portable-pty).
//! Сессия ConPTY: PowerShell под управлением пользователя.
//! Вывод читается фоновым потоком и уходит наружу через callback
//! (в команде — Tauri-событие), с посимвольной сборкой UTF-8 на границах чанков.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

/// Ручки живой PTY-сессии
pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

/// Реестр сессий: id → сессия (по образцу AbortRegistry)
pub struct PtyRegistry(pub Mutex<HashMap<String, Arc<Mutex<PtySession>>>>);

impl PtyRegistry {
    /// Гасим все сессии при выходе приложения — иначе возможен осиротевший PowerShell
    pub fn kill_all(&self) {
        let map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for (_, s) in map.iter() {
            if let Ok(mut s) = s.lock() {
                let _ = s.child.kill();
            }
        }
    }
}

const PTY_OUTPUT_LIMIT: usize = 1024 * 1024; // предохранитель на накопитель декодера

/// Команда шелла по выбору пользователя: None/auto — PowerShell (как было),
/// "cmd" — cmd.exe, "gitbash" — Git Bash (--login -i; путь ищется стандартно)
fn build_shell_command(shell: Option<&str>, cwd: Option<&str>) -> Result<CommandBuilder, String> {
    let mut cmd = match shell.map(str::to_ascii_lowercase).as_deref() {
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
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    Ok(cmd)
}

/// Поиск bash.exe из Git for Windows в стандартных местах установки
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
) -> Result<Arc<Mutex<PtySession>>, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = build_shell_command(shell.as_deref(), cwd.as_deref())?;
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

    Ok(Arc::new(Mutex::new(PtySession {
        writer,
        master: pair.master,
        child,
    })))
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
            cols.max(20).min(500),
            rows.max(5).min(200),
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
        if let Ok(mut s) = session.lock() {
            let _ = s.child.kill();
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
    // держим его вне потока UI
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = session.lock().map_err(|e| e.to_string())?;
        s.writer
            .write_all(data.as_bytes())
            .and_then(|_| s.writer.flush())
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
        let s = session.lock().map_err(|e| e.to_string())?;
        s.master
            .resize(PtySize {
                rows: rows.max(5).min(200),
                cols: cols.max(20).min(500),
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
            if let Ok(mut s) = s.lock() {
                let _ = s.child.kill();
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
            let mut s = session.lock().unwrap();
            s.writer.write_all(b"echo haloui-pty\r\n").unwrap();
            s.writer.flush().unwrap();
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
                    let mut s = session.lock().unwrap();
                    s.writer.write_all(b"\x1b[1;1R").unwrap();
                    s.writer.flush().unwrap();
                    acc.replace_range(pos..pos + 4, "");
                }
            }
            if acc.contains("haloui-pty") {
                break;
            }
        }
        assert!(acc.contains("haloui-pty"), "got: {acc:?}");

        session.lock().unwrap().child.kill().ok();
    }
}
