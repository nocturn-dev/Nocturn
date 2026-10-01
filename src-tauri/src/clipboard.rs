//! Буфер обмена через нативный слой. navigator.clipboard.writeText из JS —
//! перехватываемая поверхность (клиппер-малварь монтирует свой обработчик
//! и подменяет копируемый текст); здесь запись выполняет Rust через arboard:
//! в буфер попадает ровно то, что зашито в бинарнике, JS-инъекция исключена.
//! Фронтовый фолбэк на navigator/execCommand остаётся только для браузерного
//! превью вне Tauri.

/// Запись текста в системный буфер обмена.
#[tauri::command(async)]
pub async fn clipboard_write(text: String) -> Result<(), String> {
    // arboard синхронный и может блокироваться на очереди буфера Win32 —
    // не морозим tokio-воркер (паттерн *_blocking)
    tokio::task::spawn_blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut c| c.set_text(text))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("clipboard task failed: {e}"))?
}
