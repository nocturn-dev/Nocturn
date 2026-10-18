//! Управление локальным сервером Colibri (coli serve) из приложения.
//!
//! Не более одного дочернего экземпляра: старт/стоп/статус из раздела API,
//! логи стримятся событием "colibri-log" в вебвью. На выходе приложения
//! процесс гасится вместе с деревом потомков (RunEvent::Exit → kill_on_exit).
//!
//! Порт и CLI-флаги шлюза у Colibri не зафиксированы в документации,
//! поэтому передаются через конфиг пользователя (порт — для base_url,
//! остальное — «доп. аргументы»); модель и ключ идут через переменные
//! окружения COLI_MODEL / COLI_API_KEY, у шлюза они документированы.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Default)]
pub struct ColibriRegistry {
    proc: Mutex<Option<Child>>,
    api_key: Mutex<Option<String>>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColibriStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub api_key: Option<String>,
}

#[derive(serde::Deserialize)]
// rename_all обязателен: фронт шлёт apiKey (api.ts ColibriLaunch), а без
// camelCase serde молча отбрасывал ключ — шлюз всегда стартовал с
// nocturn-local
#[serde(rename_all = "camelCase")]
pub struct ColibriLaunch {
    pub exe: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub args: Option<String>,
}

/// Строки с потолком: BufReader::lines() без '\n' в потоке рос без границы —
/// сбойный coli поглощал память (в mcp.rs тот же класс закрыт LINE_CAP).
/// Строка длиннее 1 МиБ отдаётся обрезанной с меткой, хвост до '\n' глотается
fn read_capped_lines<R: std::io::Read>(mut r: R, mut emit: impl FnMut(String)) {
    const LINE_CAP: usize = 1024 * 1024;
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                for &b in &chunk[..n] {
                    if b == b'\n' {
                        if truncated {
                            truncated = false;
                        } else {
                            emit(String::from_utf8_lossy(&buf).into_owned());
                        }
                        buf.clear();
                    } else if buf.len() < LINE_CAP {
                        buf.push(b);
                    } else if !truncated {
                        truncated = true;
                        let mut head = std::mem::take(&mut buf);
                        // b"..." литералы не держат не-ASCII (грабля проекта)
                        head.extend_from_slice("…[line truncated]".as_bytes());
                        emit(String::from_utf8_lossy(&head).into_owned());
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !buf.is_empty() && !truncated {
        emit(String::from_utf8_lossy(&buf).into_owned());
    }
}

/// Разбивка строки аргументов по пробелам; одинарные/двойные кавычки
/// группируют. Escape внутри кавычек не поддерживается — для
/// «--port 8100 --flag "значение с пробелом"» этого достаточно.
fn split_args(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quoted: Option<char> = None;
    for ch in s.chars() {
        match quoted {
            // Вне кавычек пробел завершает токен; подряд идущие — просто пропускаются
            None if ch == ' ' || ch == '\t' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None if ch == '\'' || ch == '"' => quoted = Some(ch),
            Some(q) if ch == q => quoted = None,
            _ => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Проверяем аргументы coli по белому списку флагов и значений:
/// запрещаем привязку к внешним интерфейсам (0.0.0.0), произвольные пути к конфигам/логам
/// и посторонние флаги
fn validate_coli_args(args: &[String]) -> Result<(), String> {
    const ALLOWED_FLAGS_WITH_VALUE: &[&str] = &[
        "--port", "-p",
        "--host", "-h",
        "--threads", "-t",
        "--workers", "-w",
        "--ctx", "--ctx-size", "-c",
        "--batch", "-b",
        "--n-gpu-layers", "-ngl",
        "--model", "-m",
        "--device",
        "--temp",
        "--top-p",
        "--log-level",
    ];
    const ALLOWED_BOOLEAN_FLAGS: &[&str] = &[
        "--verbose", "-v",
        "--quiet", "-q",
    ];

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg.starts_with('-') {
            if ALLOWED_BOOLEAN_FLAGS.contains(&arg.as_str()) {
                i += 1;
                continue;
            }
            if ALLOWED_FLAGS_WITH_VALUE.contains(&arg.as_str()) {
                i += 1;
                if i >= args.len() {
                    return Err(format!("flag {arg} requires a value"));
                }
                let val = &args[i];
                // Валидация хоста: только loopback (не 0.0.0.0)
                if (arg == "--host" || arg == "-h")
                    && val != "127.0.0.1"
                    && val != "localhost"
                    && val != "::1"
                {
                    return Err(format!("host {val} rejected: only loopback is permitted (127.0.0.1, localhost, ::1)"));
                }
                // Валидация порта: число от 1 до 65535
                if arg == "--port" || arg == "-p" {
                    let port: u16 = val.parse().map_err(|_| format!("invalid port: {val}"))?;
                    if port == 0 {
                        return Err("port must be > 0".into());
                    }
                }
                i += 1;
                continue;
            }
            return Err(format!("unrecognized or disallowed coli flag: {arg}"));
        } else {
            return Err(format!("unexpected positional argument: {arg}"));
        }
    }
    Ok(())
}

/// Живость процесса с подчисткой завершившегося: статус не должен
/// показывать «запущен» по зомби
fn status(registry: &ColibriRegistry) -> Result<ColibriStatus, String> {
    let mut guard = registry.proc.lock().map_err(|e| e.to_string())?;
    let running = matches!(guard.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
    let pid = if running {
        guard.as_ref().map(|c| c.id())
    } else {
        *guard = None;
        let mut key_guard = registry.api_key.lock().map_err(|e| e.to_string())?;
        *key_guard = None;
        None
    };
    let api_key = if running {
        registry.api_key.lock().map_err(|e| e.to_string())?.clone()
    } else {
        None
    };
    Ok(ColibriStatus {
        running,
        pid,
        api_key,
    })
}

/// Убить дерево процессов (coli может порождать потомков; на Windows
/// Child::kill гасит только сам процесс)
fn kill_tree(pid: u32) {
    // Единый примитив: taskkill /T /F на Windows, kill -pgid на Unix
    // (ребёнок pty/proc стартует в своей процесс-группе)
    crate::proc::kill_tree(pid)
}

#[tauri::command(async)]
pub fn colibri_start(
    app: tauri::AppHandle,
    registry: tauri::State<'_, ColibriRegistry>,
    launch: ColibriLaunch,
) -> Result<ColibriStatus, String> {
    let st = status(&registry)?;
    if st.running {
        return Ok(st);
    }
    let exe = launch.exe.trim();
    if exe.is_empty() {
        return Err("coli executable path is empty".into());
    }

    let parsed_args = split_args(launch.args.as_deref().unwrap_or(""));
    validate_coli_args(&parsed_args)?;

    let mut guard = registry.proc.lock().map_err(|e| e.to_string())?;

    // Генерируем криптографически стойкий 128-битный ключ через OsRng,
    // если пользователь не задал свой
    let key = launch
        .api_key
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| {
            let mut bytes = [0u8; 16];
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
            let mut s = String::with_capacity(32);
            for b in bytes {
                use std::fmt::Write;
                let _ = write!(s, "{:02x}", b);
            }
            s
        });

    let mut cmd = Command::new(exe);
    cmd.arg("serve").env("COLI_API_KEY", &key);
    if let Some(m) = launch.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        cmd.env("COLI_MODEL", m);
    }
    for a in parsed_args {
        cmd.arg(a);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // coli serve — консольная утилита: без флага из GUI-процесса на весь
        // срок работы сервера висит видимое консольное окно
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Своя процесс-группа: proc::kill_tree на Unix бьёт kill(-pgid).
        // Без этого coli сидел в группе приложения, kill_tree промахивался
        // (ESRCH) — colibri_stop и выход приложения висели на wait() навсегда
        cmd.process_group(0);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start \"{exe}\": {e}"))?;

    // Логи в вебвью: stdout как есть, stderr с префиксом — один канал.
    // emit_to, не broadcast: слушает только главное окно (настройки Colibri)
    if let Some(out) = child.stdout.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            read_capped_lines(out, |line| {
                let _ = app2.emit_to("main", "colibri-log", line);
            });
        });
    }
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            read_capped_lines(err, |line| {
                let _ = app2.emit_to("main", "colibri-log", format!("[err] {line}"));
            });
        });
    }

    *guard = Some(child);
    *registry.api_key.lock().map_err(|e| e.to_string())? = Some(key);
    drop(guard);
    status(&registry)
}

#[tauri::command(async)]
pub async fn colibri_stop(app: tauri::AppHandle) -> Result<ColibriStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager as _;
        let registry = app.state::<ColibriRegistry>();
        let mut guard = registry.proc.lock().map_err(|e| e.to_string())?;
        if let Some(c) = guard.take() {
            kill_tree(c.id());
            let mut c = c;
            let _ = c.kill();
            let _ = c.wait();
        }
        let mut key_guard = registry.api_key.lock().map_err(|e| e.to_string())?;
        *key_guard = None;
        Ok(ColibriStatus {
            running: false,
            pid: None,
            api_key: None,
        })
    })
    .await
    .map_err(|e| format!("colibri stop task failed: {e}"))?
}

#[tauri::command(async)]
pub fn colibri_status(
    registry: tauri::State<'_, ColibriRegistry>,
) -> Result<ColibriStatus, String> {
    status(&registry)
}

/// Гасит coli serve при выходе приложения
pub fn kill_on_exit(registry: &ColibriRegistry) {
    if let Ok(mut guard) = registry.proc.lock() {
        if let Some(c) = guard.take() {
            kill_tree(c.id());
            let mut c = c;
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    if let Ok(mut key) = registry.api_key.lock() {
        *key = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_args_basic_and_quotes() {
        assert!(split_args("").is_empty());
        assert!(split_args("   ").is_empty());
        assert_eq!(split_args("--port 8100"), vec!["--port", "8100"]);
        assert_eq!(
            split_args("--flag \"значение с пробелом\""),
            vec!["--flag", "значение с пробелом"]
        );
        assert_eq!(split_args("a 'b c' d"), vec!["a", "b c", "d"]);
        // Подряд идущие пробелы не порождают пустых токенов
        assert_eq!(split_args("a   b"), vec!["a", "b"]);
        // Незакрытая кавычка — хвост остаётся одним аргументом
        assert_eq!(split_args("a \"bc"), vec!["a", "bc"]);
    }

    /// Стык с фронтом (api.ts ColibriLaunch.apiKey): serde-контракт
 /// camelCase. без rename_all ключ молча отбрасывался и
    /// COLI_API_KEY всегда был «nocturn-local»
    #[test]
    fn colibri_launch_accepts_camel_case_api_key() {
        let launch: ColibriLaunch = serde_json::from_value(serde_json::json!({
            "exe": "coli",
            "model": "m",
            "apiKey": "sk-contract-test",
            "args": "--port 8100"
        }))
        .unwrap();
        assert_eq!(launch.api_key.as_deref(), Some("sk-contract-test"));
        assert_eq!(launch.model.as_deref(), Some("m"));
    }

    #[test]
    fn validate_coli_args_allowlist() {
        // Допустимые флаги и порт
        let ok_args = vec!["--port".into(), "8080".into(), "--verbose".into(), "--threads".into(), "4".into()];
        assert!(validate_coli_args(&ok_args).is_ok());

        // Привязка к внешнему адресу запрещена
        let bad_host = vec!["--host".into(), "0.0.0.0".into()];
        assert!(validate_coli_args(&bad_host).is_err());

        // Разрешён loopback
        let loopback = vec!["--host".into(), "127.0.0.1".into()];
        assert!(validate_coli_args(&loopback).is_ok());

        // Неизвестный флаг отклонён
        let unknown = vec!["--arbitrary-flag".into(), "value".into()];
        assert!(validate_coli_args(&unknown).is_err());

        // Позиционный аргумент без флага отклонён
        let positional = vec!["rm".into(), "-rf".into()];
        assert!(validate_coli_args(&positional).is_err());
    }
}
