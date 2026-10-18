//! Глобальные хоткеи через xdg-desktop-portal GlobalShortcuts (linux-only).
//!
//! Зачем: tauri-plugin-global-shortcut на Linux работает через X11 (XGrabKey),
//! а в нативной Wayland-сессии глобальные захват клавиш невозможен в принципе.
//! Портал — единственный легитимный путь: композитор сам показывает диалог
//! подтверждения, сам помнит одобрение и сам присылает сигнал Activated
//! (GNOME 45+, KDE 6+, свежие wlroots; на старых композиторах интерфейса нет —
//! тогда остаётся честный тост «хоткей недоступен» из quickentry_status).
//!
//! ashpd — unix-only крейс (file_path тянет os::unix::ffi), потому зависимость
//! и модуль под cfg(target_os = "linux"); компиляцию проверяет ubuntu-джоба CI
//! (cargo test линкует). В рантайме активируется только когда плагин не смог
//! И сессия Wayland — Windows/macOS/X11 живут через плагин.
//!
//! Ограничения: описание в системном диалоге — английское (бэкенд не знает
//! локаль); триггер отдаётся как есть, композитор может его нормализовать.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use ashpd::desktop::global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut};
use ashpd::desktop::CreateSessionOptions;
use ashpd::desktop::Session;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

/// Активная портал-сессия. Хранится, чтобы при ремапе закрыть прежнюю:
/// иначе старое комбо продолжало бы срабатывать вместе с новым.
static PORTAL_SESSION: Mutex<Option<Session<GlobalShortcuts>>> = Mutex::new(None);

/// Счётчик поколений регистрации портала для защиты от гонок между параллельными start()
static PORTAL_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Wayland-сессия? Портал-путь имеет смысл только там, где XGrabKey недоступен.
pub fn wayland_session() -> bool {
    match std::env::var("XDG_SESSION_TYPE").ok().as_deref() {
        Some("wayland") => true,
        Some(_) => false,
        // XDG_SESSION_TYPE не выставлен (нестандартное окружение): косвенный
        // признак — переменная WAYLAND_DISPLAY, которую задаёт композитор
        None => std::env::var("WAYLAND_DISPLAY")
            .map(|v| !v.is_empty())
            .unwrap_or(false),
    }
}

/// tauri-комбо ("ctrl+alt+space") → строка XDG акселератора для портала ("<Control><Alt>Space").
/// Формат акселераторов XDG / GTK: модификаторы в угловых скобках (<Control>, <Alt>, <Shift>, <Super>),
/// затем имя базовой клавиши.
pub fn portal_trigger(combo: &str) -> String {
    let mut mods = Vec::new();
    let mut key = String::new();

    for part in combo.split('+') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        match trimmed.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods.push("<Control>"),
            "alt" => mods.push("<Alt>"),
            "shift" => mods.push("<Shift>"),
            "super" | "meta" | "cmd" | "command" => mods.push("<Super>"),
            "space" => key = "Space".to_string(),
            other => {
                // Если это одна буква, делаем заглавной, если слово (F1-F12 и т.п.) — капитализируем первую букву
                if other.len() == 1 {
                    key = other.to_ascii_uppercase();
                } else {
                    let mut c = other.chars();
                    key = match c.next() {
                        None => String::new(),
                        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    };
                }
            }
        }
    }

    if key.is_empty() {
        combo.to_ascii_uppercase()
    } else {
        format!("{}{}", mods.join(""), key)
    }
}

/// Попытка зарегистрировать комбо через портал. Асинхронно: диалог
/// подтверждения показывает композитор, итог (одобрил/отменил) отражается в
/// QUICKENTRY_REGISTERED; Activated-сигналы дергают toggle_quickentry.
/// Вызывать только когда плагин не смог и wayland_session().
pub fn start(app: AppHandle, combo: String) {
    let trigger = portal_trigger(&combo);
    let gen = PORTAL_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app.clone(), &trigger, gen).await {
            crate::app_log::log_warn(&format!("quickentry portal unavailable: {e}"));
            if PORTAL_GENERATION.load(Ordering::SeqCst) == gen {
                crate::QUICKENTRY_REGISTERED.store(false, Ordering::Relaxed);
                let _ = app.emit("quickentry-status-changed", false);
                if let Ok(mut guard) = PORTAL_SESSION.lock() {
                    // Полумёртвая сессия не должна блокировать будущие попытки
                    *guard = None;
                }
            }
        }
    });
}

async fn run(app: AppHandle, trigger: &str, gen: u64) -> Result<(), String> {
    // Ремап: закрыть прежнюю портал-сессию, иначе старое комбо оставалось бы
    // активным вместе с новым. Guard снимается ДО await: std MutexGuard не
    // Send, и future в spawn стал бы !Send
    let old_session = PORTAL_SESSION.lock().ok().and_then(|mut g| g.take());
    if let Some(old) = old_session {
        let _ = old.close().await;
    }

    if PORTAL_GENERATION.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let shortcuts = GlobalShortcuts::new()
        .await
        .map_err(|e| format!("portal proxy: {e}"))?;
    let session = shortcuts
        .create_session(CreateSessionOptions::default())
        .await
        .map_err(|e| format!("portal session: {e}"))?;

    // bind_shortcuts резолвится ПОСЛЕ ответа композитора: Ok — пользователь
    // одобрил (или одобрение закэшировано), Err — отменил диалог/нет интерфейса
    let request = match shortcuts
        .bind_shortcuts(
            &session,
            &[NewShortcut::new(
                "quickentry",
                "Show Nocturn Quick Entry",
            )
            .preferred_trigger(Some(trigger))],
            None,
            BindShortcutsOptions::default(),
        )
        .await
    {
        Ok(req) => req,
        Err(e) => {
            let _ = session.close().await;
            return Err(format!("portal bind: {e}"));
        }
    };

    if let Err(e) = request.response() {
        let _ = session.close().await;
        return Err(format!("portal bind rejected: {e}"));
    }

    if PORTAL_GENERATION.load(Ordering::SeqCst) != gen {
        let _ = session.close().await;
        return Ok(());
    }

    // Запоминаем сессию: без этого ремап закрывал None, а прежний поток run()
    // продолжал слушать receive_activated — каждое нажатие дёргало
    // toggle_quickentry дважды, и старое комбо оставалось живым
    if let Ok(mut guard) = PORTAL_SESSION.lock() {
        *guard = Some(session);
    }

    // Фильтр по shortcut_id: сигнал прилетает на общий объект портала, но
    // наш id специфичен для приложения
    let stream_res = shortcuts.receive_activated().await;
    let mut stream = match stream_res {
        Ok(s) => s,
        Err(e) => {
            let session_to_close = PORTAL_SESSION.lock().ok().and_then(|mut g| g.take());
            if let Some(s) = session_to_close {
                let _ = s.close().await;
            }
            return Err(format!("portal stream: {e}"));
        }
    };

    // Флаг «зарегистрировано» ставится ПОСЛЕ успешного создания стрима
    crate::QUICKENTRY_REGISTERED.store(true, Ordering::Relaxed);
    let _ = app.emit("quickentry-status-changed", true);

    while let Some(activated) = stream.next().await {
        if activated.shortcut_id() == "quickentry" {
            crate::toggle_quickentry(&app);
        }
    }

    // Стрим закрылся — сессия умерла (Close/отключение портала).
    // Сбрасываем только если поколение не сменилось новым вызовом run()
    if PORTAL_GENERATION.load(Ordering::SeqCst) == gen {
        crate::QUICKENTRY_REGISTERED.store(false, Ordering::Relaxed);
        let _ = app.emit("quickentry-status-changed", false);
        let session_to_close = PORTAL_SESSION.lock().ok().and_then(|mut g| g.take());
        if let Some(s) = session_to_close {
            let _ = s.close().await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::portal_trigger;

    #[test]
    fn trigger_is_formatted_for_xdg() {
        assert_eq!(portal_trigger("ctrl+alt+space"), "<Control><Alt>Space");
        assert_eq!(portal_trigger("Ctrl+Shift+P"), "<Control><Shift>P");
        assert_eq!(portal_trigger("ctrl+shift+space"), "<Control><Shift>Space");
        assert_eq!(portal_trigger("super+alt+f1"), "<Super><Alt>F1");
    }
}
