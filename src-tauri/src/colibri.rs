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

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Default)]
pub struct ColibriRegistry {
    proc: Mutex<Option<Child>>,
}

#[derive(serde::Serialize)]
pub struct ColibriStatus {
    pub running: bool,
    pub pid: Option<u32>,
}

#[derive(serde::Deserialize)]
pub struct ColibriLaunch {
    pub exe: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub args: Option<String>,
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

/// Живость процесса с подчисткой завершившегося: статус не должен
/// показывать «запущен» по зомби
fn status(proc: &mut Option<Child>) -> ColibriStatus {
    let running = matches!(proc.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
    if !running {
        *proc = None;
    }
    ColibriStatus {
        running,
        pid: proc.as_ref().map(|c| c.id()),
    }
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
    // Модель доверия: путь exe задаёт сам пользователь в настройках Colibri
    // (по умолчанию «coli» из PATH), он приходит не от модели — поэтому
    // perm::decide и rejects_sensitive_path здесь, в отличие от агентных
    // инструментов, не применяются. Осознанный дисбаланс зафиксирован
    // в SECURITY.md (Executable configs)
    let mut guard = registry.proc.lock().map_err(|e| e.to_string())?;
    let st = status(&mut guard);
    if st.running {
        return Ok(st);
    }
    let exe = launch.exe.trim();
    if exe.is_empty() {
        return Err("coli executable path is empty".into());
    }

    let mut cmd = Command::new(exe);
    cmd.arg("serve").env(
        "COLI_API_KEY",
        launch
            .api_key
            .filter(|k| !k.trim().is_empty())
            .unwrap_or_else(|| "nocturn-local".into()),
    );
    if let Some(m) = launch.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        cmd.env("COLI_MODEL", m);
    }
    for a in split_args(launch.args.as_deref().unwrap_or("")) {
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
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app2.emit_to("main", "colibri-log", line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app2.emit("colibri-log", format!("[err] {line}"));
            }
        });
    }

    *guard = Some(child);
    Ok(status(&mut guard))
}

#[tauri::command(async)]
pub fn colibri_stop(registry: tauri::State<'_, ColibriRegistry>) -> Result<ColibriStatus, String> {
    let mut guard = registry.proc.lock().map_err(|e| e.to_string())?;
    if let Some(c) = guard.take() {
        kill_tree(c.id());
        let mut c = c;
        // Страховка: kill_tree бьёт по группе и может промахнуться (гонка
        // старта, унаследованная группа) — прямой kill гарантирует, что
        // wait() ниже не зависнет навсегда
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(ColibriStatus {
        running: false,
        pid: None,
    })
}

#[tauri::command(async)]
pub fn colibri_status(
    registry: tauri::State<'_, ColibriRegistry>,
) -> Result<ColibriStatus, String> {
    let mut guard = registry.proc.lock().map_err(|e| e.to_string())?;
    Ok(status(&mut guard))
}

/// Гасит coli serve при выходе приложения
pub fn kill_on_exit(registry: &ColibriRegistry) {
    if let Ok(mut guard) = registry.proc.lock() {
        if let Some(c) = guard.take() {
            kill_tree(c.id());
            let mut c = c;
            // Страховка от вечного wait(): см. colibri_stop
            let _ = c.kill();
            let _ = c.wait();
        }
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
}
