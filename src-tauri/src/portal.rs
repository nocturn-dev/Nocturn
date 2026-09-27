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

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use ashpd::desktop::global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut};
use ashpd::desktop::CreateSessionOptions;
use ashpd::desktop::Session;
use futures_util::StreamExt;
use tauri::AppHandle;

/// Активная портал-сессия. Хранится, чтобы при ремапе закрыть прежнюю:
/// иначе старое комбо продолжало бы срабатывать вместе с новым.
static PORTAL_SESSION: Mutex<Option<Session<GlobalShortcuts>>> = Mutex::new(None);

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

/// tauri-комбо ("ctrl+alt+space") → строка для портала. Формат портала —
/// клавиатурный акселератор; верхний регистр понимают и KDE, и GNOME.
pub fn portal_trigger(combo: &str) -> String {
    combo.to_ascii_uppercase()
}

/// Попытка зарегистрировать комбо через портал. Асинхронно: диалог
/// подтверждения показывает композитор, итог (одобрил/отменил) отражается в
/// QUICKENTRY_REGISTERED; Activated-сигналы дергают toggle_quickentry.
/// Вызывать только когда плагин не смог и wayland_session().
pub fn start(app: AppHandle, combo: String) {
    let trigger = portal_trigger(&combo);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app, &trigger).await {
            eprintln!("quickentry portal unavailable: {e}");
            crate::QUICKENTRY_REGISTERED.store(false, Ordering::Relaxed);
            if let Ok(mut guard) = PORTAL_SESSION.lock() {
                // Полумёртвая сессия не должна блокировать будущие попытки
                *guard = None;
            }
        }
    });
}

async fn run(app: AppHandle, trigger: &str) -> Result<(), String> {
    // Ремап: закрыть прежнюю портал-сессию, иначе старое комбо оставалось бы
    // активным вместе с новым. Guard снимается ДО await: std MutexGuard не
    // Send, и future в spawn стал бы !Send
    let old_session = PORTAL_SESSION.lock().ok().and_then(|mut g| g.take());
    if let Some(old) = old_session {
        let _ = old.close().await;
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
    let request = shortcuts
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
        .map_err(|e| format!("portal bind: {e}"))?;
    request
        .response()
        .map_err(|e| format!("portal bind rejected: {e}"))?;
    crate::QUICKENTRY_REGISTERED.store(true, Ordering::Relaxed);

    // Фильтр по shortcut_id: сигнал прилетает на общий объект портала, но
    // наш id специфичен для приложения
    let mut stream = shortcuts
        .receive_activated()
        .await
        .map_err(|e| format!("portal stream: {e}"))?;
    while let Some(activated) = stream.next().await {
        if activated.shortcut_id() == "quickentry" {
            crate::toggle_quickentry(&app);
        }
    }

    // Стрим закрылся — сессия умерла (Close/отключение портала)
    crate::QUICKENTRY_REGISTERED.store(false, Ordering::Relaxed);
    if let Ok(mut guard) = PORTAL_SESSION.lock() {
        *guard = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::portal_trigger;

    #[test]
    fn trigger_is_uppercased() {
        assert_eq!(portal_trigger("ctrl+alt+space"), "CTRL+ALT+SPACE");
        assert_eq!(portal_trigger("Ctrl+Shift+P"), "CTRL+SHIFT+P");
    }
}
