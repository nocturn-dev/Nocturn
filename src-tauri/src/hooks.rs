//! Пользовательские хуки: shell-команды, запускаемые на событиях агента.
//!
//! События: PreToolUse / PostToolUse (врезка в run_tool, lib.rs),
//! UserPromptSubmit / Stop / SessionStart (из фронтенда через hooks_run_event).
//!
//! Контекст события передаётся процессу на stdin как JSON:
//!   { "event": "...", "tool": "fs_write", "arguments": {...}, "result": "..." }
//! Ответ процесса: stdout. Если это JSON вида
//!   { "decision": "block", "reason": "..." }  — PreToolUse блокирует вызов;
//!   { "additionalContext": "..." }            — текст добавляется к результату.
//! Блокирует ТОЛЬКО явный decision=block: ненулевой exit/сбой spawn/мусор в
//! stdout записываются в outcome, но не замыкают вызовы (один сломанный хук
//! раньше блокировал все инструменты). timeout=0 — хук отключён.
//!
//! Хранилище: hooks.json в app_config_dir. Матчер — подстрока имени
//! инструмента (регистронезависимо), пустая строка = все инструменты
//! (для событий без инструмента матчер всегда считается совпавшим).

use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

pub const EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
    "SessionStart",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    pub id: String,
    pub event: String,
    /// Подстрока имени инструмента; пусто = все
    #[serde(default)]
    pub matcher: String,
    pub command: String,
    /// Секунды; 0 = без ожидания (убить по таймауту всё равно нужно)
    #[serde(default = "default_timeout")]
    pub timeout: u64,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_timeout() -> u64 {
    30
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HookFile {
    #[serde(default)]
    pub hooks: Vec<Hook>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HookOutcome {
    pub id: String,
    /// Хук совпал и был запущен
    pub ran: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub blocked: bool,
    pub reason: String,
    pub additional_context: String,
}

impl HookOutcome {
    fn skipped(id: &str) -> Self {
        Self {
            id: id.to_string(),
            ran: false,
            exit_code: None,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            blocked: false,
            reason: String::new(),
            additional_context: String::new(),
        }
    }
}

pub fn hooks_path(dir: &std::path::Path) -> PathBuf {
    dir.join("hooks.json")
}

/// Кэш hooks.json: load() вызывается дважды на каждый тулл-колл (PreToolUse
/// и PostToolUse) — чтение и парсинг с диска на горячем пути давали
/// постоянный оверхед.
///
/// Ключ — (mtime, len): правка файла моментально инвалидирует кэш.
type HookCacheEntry = (PathBuf, std::time::SystemTime, u64);
static LOAD_CACHE: std::sync::Mutex<Option<(HookCacheEntry, HookFile)>> =
    std::sync::Mutex::new(None);

pub fn load(dir: &std::path::Path) -> HookFile {
    let path = hooks_path(dir);
    let Ok(md) = std::fs::metadata(&path) else {
        return HookFile::default();
    };
    let Ok(mtime) = md.modified() else {
        return HookFile::default();
    };
    let key = (path.clone(), mtime, md.len());
    if let Ok(guard) = LOAD_CACHE.lock() {
        if let Some((cached_key, cached)) = guard.as_ref() {
            if cached_key == &key {
                return cached.clone();
            }
        }
    }
    // Битый JSON не должен молча отключать ВСЕ хуки: владелец остаётся без
    // гардалов/обогащения и не видит причины — громкая строка в stderr
    let parsed = match std::fs::read_to_string(&path) {
        Ok(d) => match serde_json::from_str::<HookFile>(&d) {
            Ok(f) => f,
            Err(e) => {
                eprintln!(
                    "hooks: broken {} ({e}) — hooks are disabled until the file is fixed or removed",
                    path.display()
                );
                HookFile::default()
            }
        },
        // Файла ещё нет — норма (хуки не настроены), без шума
        Err(_) => HookFile::default(),
    };
    if let Ok(mut guard) = LOAD_CACHE.lock() {
        *guard = Some((key, parsed.clone()));
    }
    parsed
}

pub fn save(dir: &std::path::Path, file: &HookFile) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&hooks_path(dir), json.as_bytes())?;
    // Кэш мог остаться с прежним (mtime, len) — сбрасываем принудительно
    if let Ok(mut guard) = LOAD_CACHE.lock() {
        *guard = None;
    }
    Ok(())
}

/// Совпадает ли хук с событием/инструментом
pub fn matches(hook: &Hook, event: &str, tool: &str) -> bool {
    if !hook.enabled || hook.event != event {
        return false;
    }
    if hook.matcher.is_empty() || tool.is_empty() {
        return true;
    }
    tool.to_lowercase()
        .contains(&hook.matcher.to_lowercase())
}

/// Подготовить payload к запуску хуков: одна глубокая копия с усечением
/// длинных строк на ВСЁ событие. Раньше копия делалась в exec_with_abort —
/// заново под каждый совпавший хук.
fn prepare_payload(payload: &serde_json::Value) -> serde_json::Value {
    let mut prepared = payload.clone();
    truncate_long_strings(&mut prepared);
    prepared
}

/// Запустить один хук: stdin = payload JSON (уже усечённый), stdout/stderr
/// собираются.
fn exec_with_abort(
    hook: &Hook,
    payload: &serde_json::Value,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> HookOutcome {
    let mut out = HookOutcome::skipped(&hook.id);
    // timeout 0 — хук отключён: раньше «без ожидания» маппилось в 3600 с,
    // и зависший хук держал весь шаг агента до часа на каждом тулл-колле
    if hook.timeout == 0 {
        return out;
    }
    out.ran = true;

    let timeout = Duration::from_secs(hook.timeout.clamp(1, 600));

    let (shell, flag) = if cfg!(windows) {
        ("cmd", "/C")
    } else {
        // POSIX sh: на Debian/Ubuntu /bin/sh — dash, bash-измы (массивы, [[ ]])
        // в хуках пользователя упадут. Документированный контракт — «POSIX sh only»
        ("sh", "-c")
    };
    let mut cmd = Command::new(shell);
    // raw_arg: не экранировать команду — иначе кавычки внутри
    // (пути "Program Files", JSON в echo) ломаются на Windows
    #[cfg(windows)]
    {
        cmd.raw_arg(flag).raw_arg(&hook.command);
    }
    #[cfg(not(windows))]
    {
        cmd.arg(flag).arg(&hook.command);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: без чёрного окна

    // Payload приходит уже усечённым (prepare_payload у вызывающего): хук не
    // должен получать мегабайты результата fs_read — иначе write_all может
    // блокироваться на заполненном пайпе
    let payload_bytes = payload.to_string().into_bytes();

    // Запуск, stdin-писатель, параллельное чтение пайпов и таймаут с kill —
    // единый примитив proc. stdin-писатель внутри отсоединённый: если хук не
    // читает stdin (типичный `echo ok`), write_all заблокируется до смерти
    // процесса и получит broken pipe — дедлок невозможен.
    let proc_out =
        match crate::proc::run_command_opts(&mut cmd, timeout, Some(payload_bytes), abort) {
            Ok(o) => o,
            Err(e) => {
                // Сбой spawn больше НЕ блокирует вызов: один опечатанный хук
                // раньше блокировал ВСЕ инструменты с невнятной ошибкой.
                // Хук — удобство, а не граница безопасности (это perm-слой)
                out.stderr = e;
                return out;
            }
        };

    out.exit_code = proc_out.status;
    out.timed_out = proc_out.timed_out;
    out.stdout = proc_out.stdout;
    out.stderr = proc_out.stderr;
    if out.timed_out {
        out.stderr = format!("hook timed out after {}s", timeout.as_secs());
    }

    // Разбор ответа: блокировка — ТОЛЬКО явный JSON { "decision": "block" }.
    // Ненулевой exit-код и мусор в stdout раньше тоже считались блокировкой:
    // пустой/опечатанный хук (cmd /C "" → exit 1) замыкал все вызовы
    // инструментов с сообщением «blocked by hook»
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(out.stdout.trim()) {
        if v.get("decision").and_then(|d| d.as_str()) == Some("block") {
            out.blocked = true;
            out.reason = v
                .get("reason")
                .and_then(|r| r.as_str())
                .unwrap_or("blocked by hook")
                .to_string();
        }
        if let Some(ctx) = v.get("additionalContext").and_then(|c| c.as_str()) {
            out.additional_context = ctx.to_string();
        }
    }
    out
}

/// Максимальная длина строки внутри payload, передаваемого хуку.
const HOOK_STRING_LIMIT: usize = 64 * 1024;

/// Рекурсивно обрезает строки длиннее HOOK_STRING_LIMIT в JSON-значении,
/// добавляя суффикс "\n...[truncated]". Хук не должен получать мегабайты.
fn truncate_long_strings(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => {
            if s.len() > HOOK_STRING_LIMIT {
                crate::truncate_at_char_boundary(s, HOOK_STRING_LIMIT);
                s.push_str("\n...[truncated]");
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                truncate_long_strings(item);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, val) in map.iter_mut() {
                truncate_long_strings(val);
            }
        }
        _ => {}
    }
}

/// Запустить конкретный хук без учёта enabled/матчера (кнопка «Тест»)
pub fn run_event_on(hook: &Hook, payload: &serde_json::Value) -> HookOutcome {
    exec_with_abort(hook, &prepare_payload(payload), None)
}

/// Прогнать все хуки события. Возвращает исходы только совпавших хуков.
pub fn run_event(
    dir: &std::path::Path,
    event: &str,
    tool: &str,
    payload: &serde_json::Value,
) -> Vec<HookOutcome> {
    run_event_with_abort(dir, event, tool, payload, None)
}

/// Как run_event, но с abort-флагом прогона: Stop убивает запущенный хук
pub fn run_event_with_abort(
    dir: &std::path::Path,
    event: &str,
    tool: &str,
    payload: &serde_json::Value,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> Vec<HookOutcome> {
    let file = load(dir);
    // Одна копия с усечением на всё событие: мегабайтный результат fs_read
    // раньше клонировался заново под каждый совпавший хук
    let prepared = prepare_payload(payload);
    file.hooks
        .iter()
        .filter(|h| matches(h, event, tool))
        .map(|h| exec_with_abort(h, &prepared, abort))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nocturn-hooks-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn matcher_substring_case_insensitive() {
        let hook = Hook {
            id: "a".into(),
            event: "PreToolUse".into(),
            matcher: "FS_".into(),
            command: "echo".into(),
            timeout: 5,
            enabled: true,
        };
        assert!(matches(&hook, "PreToolUse", "fs_write"));
        assert!(!matches(&hook, "PostToolUse", "fs_write"));
        assert!(!matches(&hook, "PreToolUse", "shell_run"));
    }

    #[test]
    fn disabled_hook_never_matches() {
        let hook = Hook {
            id: "b".into(),
            event: "Stop".into(),
            matcher: String::new(),
            command: String::new(),
            timeout: 5,
            enabled: false,
        };
        // Отключённый хук не совпадает никогда
        assert!(!matches(&hook, "Stop", ""));
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tmpdir("roundtrip");
        let file = HookFile {
            hooks: vec![Hook {
                id: "h1".into(),
                event: "PostToolUse".into(),
                matcher: "fs_write".into(),
                command: "echo done".into(),
                timeout: 10,
                enabled: true,
            }],
        };
        save(&dir, &file).unwrap();
        let back = load(&dir);
        assert_eq!(back.hooks.len(), 1);
        assert_eq!(back.hooks[0].command, "echo done");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn block_decision_json() {
        let dir = tmpdir("block");
        save(
            &dir,
            &HookFile {
                hooks: vec![Hook {
                    id: "h2".into(),
                    event: "PreToolUse".into(),
                    matcher: "fs_delete".into(),
                    command: if cfg!(windows) {
                        "echo {\"decision\":\"block\",\"reason\":\"no\"}".to_string()
                    } else {
                        "echo '{\"decision\":\"block\",\"reason\":\"no\"}'".to_string()
                    },
                    timeout: 10,
                    enabled: true,
                }],
            },
        )
        .unwrap();
        let outs = run_event(&dir, "PreToolUse", "fs_delete", &serde_json::json!({}));
        assert_eq!(outs.len(), 1);
        assert!(outs[0].ran);
        assert!(outs[0].blocked);
        assert_eq!(outs[0].reason, "no");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timeout_kills_process() {
        let dir = tmpdir("timeout");
        save(
            &dir,
            &HookFile {
                hooks: vec![Hook {
                    id: "h3".into(),
                    event: "Stop".into(),
                    matcher: String::new(),
                    command: if cfg!(windows) {
                        "ping -n 60 127.0.0.1 > nul".to_string()
                    } else {
                        "sleep 60".to_string()
                    },
                    timeout: 1,
                    enabled: true,
                }],
            },
        )
        .unwrap();
        let start = std::time::Instant::now();
        let outs = run_event(&dir, "Stop", "", &serde_json::json!({}));
        assert!(outs[0].timed_out);
        assert!(start.elapsed() < Duration::from_secs(10));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_long_strings_multibyte_boundary_no_panic() {
        // 3-байтовые символы: байтовый лимит 64 КБ режет символ посередине —
        // String::truncate паниковал бы; граница сдвигается назад до целого символа.
        let mut v = serde_json::json!({ "result": "\u{65e5}".repeat(100 * 1024) });
        truncate_long_strings(&mut v);
        let s = v["result"].as_str().unwrap();
        assert!(s.len() <= 64 * 1024 + 32, "len={}", s.len());
        assert!(s.ends_with("\n...[truncated]"));
    }

    #[test]
    fn hook_with_large_payload_and_stdinless_command_does_not_deadlock() {
        // Регресс: хук не читает stdin, а payload больше буфера пайпа.
        // Раньше write_all блокировался, а join() стоял до цикла ожидания —
        // весь хук зависал без таймаута. Теперь поток-писатель отсоединён
        // и завершается по broken pipe после смерти процесса.
        let dir = tmpdir("stdin");
        let big = "x".repeat(200 * 1024);
        save(
            &dir,
            &HookFile {
                hooks: vec![Hook {
                    id: "h4".into(),
                    event: "PostToolUse".into(),
                    matcher: String::new(),
                    command: if cfg!(windows) {
                        "ping -n 2 127.0.0.1 > nul".to_string()
                    } else {
                        "sleep 2".to_string()
                    },
                    timeout: 10,
                    enabled: true,
                }],
            },
        )
        .unwrap();
        let start = std::time::Instant::now();
        let outs = run_event(
            &dir,
            "PostToolUse",
            "fs_read",
            &serde_json::json!({ "result": big }),
        );
        assert_eq!(outs.len(), 1);
        assert!(outs[0].ran, "hook should have run");
        assert!(!outs[0].timed_out, "stderr: {}", outs[0].stderr);
        assert!(
            start.elapsed() < Duration::from_secs(9),
            "hook took too long: {:?}",
            start.elapsed()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
