//! Windows-тосты с честной атрибуцией и активацией по клику.
//!
//! tauri-plugin-notification на Windows шлёт тосты от AUMID PowerShell
//! («Windows PowerShell» в Центре уведомлений — багрепорт владельца) и не
//! даёт обработчик клика. Здесь свой тост: AUMID com.haloui.app, имя и
//! иконка берутся из HKCU-регистрации (работает и без инсталлятора), клик
//! по тосту разворачивает и фокусирует главное окно.

/// Совпадает с identifier в tauri.conf.json
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
    let handler = app.clone();
    let toast = tauri_winrt_notification::Toast::new(APP_ID)
        .title(&title)
        .text1(&body)
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
pub async fn notify_toast(_title: String, _body: String) -> Result<(), String> {
    // macOS/Linux — штатный плагин (notify.ts вызывает его напрямую)
    Ok(())
}
