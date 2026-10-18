//! Windows-тосты с честной атрибуцией и активацией по клику.
//!
//! tauri-plugin-notification на Windows шлёт тосты от AUMID PowerShell
//! («Windows PowerShell» в Центре уведомлений) и не
//! даёт обработчик клика. Здесь свой тост: AUMID com.haloui.app, имя и
//! иконка берутся из HKCU-регистрации (работает и без инсталлятора), клик
//! по тосту разворачивает и фокусирует главное окно.

/// Совпадает с identifier в tauri.conf.json
#[cfg(windows)]
pub const APP_ID: &str = "com.haloui.app";

/// Зарегистрировать AUMID в HKCU: без записи в реестре Центр уведомлений
/// показывает тост без имени и иконки. Идемпотентно, ошибки не критичны —
/// тост всё равно уйдёт (без подписи).
#[cfg(windows)]
fn register_aumid() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let Ok(hive) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(format!(r"Software\Classes\AppUserModelId\{APP_ID}"))
    else {
        return;
    };
    let (key, _) = hive;
    let _ = key.set_value("DisplayName", &"Nocturn");
    // file:/// URI: IconUri тоста принимает только URL-схему
    let icon = format!("file:///{}", exe.to_string_lossy().replace('\\', "/"));
    let _ = key.set_value("IconUri", &icon);
}

/// Санитизация и ограничение длины текста тостов, чтобы приватные детали,
/// пути и токены не всплывали на экране блокировки Windows
pub fn sanitize_toast_text(mut title: String, body: &str) -> (String, String) {
    if title.trim().is_empty() {
        title = "Nocturn".to_string();
    }
    crate::truncate_at_char_boundary(&mut title, 64);

    let mut clean_body = crate::telegram::sanitize_outgoing_text(body);
    crate::truncate_at_char_boundary(&mut clean_body, 200);

    (title, clean_body)
}

/// Тост «Задача завершена / Agent is waiting…»: клик — показать окно.
/// Звук не дублируем: WebAudio-мелодия уже играет на фронте.
#[cfg(windows)]
#[tauri::command]
pub async fn notify_toast(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    register_aumid();
    let (safe_title, safe_body) = sanitize_toast_text(title, &body);
    let handler = app.clone();
    let toast = tauri_winrt_notification::Toast::new(APP_ID)
        .title(&safe_title)
        .text1(&safe_body)
        .sound(None)
        .on_activated(move |_| {
            // Вызывается на WinRT-потоке: window-API Tauri потокобезопасны
            use tauri::Manager;
            if let Some(w) = handler.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            Ok(())
        });
    toast.show().map_err(|e| format!("toast failed: {e}"))
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn notify_toast(title: String, body: String) -> Result<(), String> {
    let (_safe_title, _safe_body) = sanitize_toast_text(title, &body);
    // macOS/Linux — штатный плагин (notify.ts вызывает его напрямую)
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_toast_text() {
        let (title, body) = sanitize_toast_text(
            "".into(),
            "Task complete at C:\\Users\\secret\\project with key sk-ant-api03-abcdefghijklmnop",
        );
        assert_eq!(title, "Nocturn");
        assert!(!body.contains("C:\\Users\\secret\\project"));
        assert!(!body.contains("sk-ant-api03"));
        assert!(body.contains("[REDACTED_SECRET]"));

        // Проверяем ограничение длины
        let long_title = "A".repeat(100);
        let long_body = "B".repeat(300);
        let (t_capped, b_capped) = sanitize_toast_text(long_title, &long_body);
        assert_eq!(t_capped.chars().count(), 64);
        assert_eq!(b_capped.chars().count(), 200);
    }
}
