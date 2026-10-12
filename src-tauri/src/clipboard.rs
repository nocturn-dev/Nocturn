//! Буфер обмена через нативный слой. navigator.clipboard.writeText из JS —
//! перехватываемая поверхность (клиппер-малварь монтирует свой обработчик
//! и подменяет копируемый текст); здесь запись выполняет Rust через arboard:
//! в буфер попадает ровно то, что зашито в бинарнике, JS-инъекция исключена.
//! Фронтовый фолбэк на navigator/execCommand остаётся только для браузерного
//! превью вне Tauri.
//!
//! Аудит clipboard 87: защита работает только против ПОДМЕНЫ
//! navigator.clipboard на стороне страницы. Любой скрипт вебвью (в т.ч.
//! после XSS) может вызвать clipboard_write напрямую — команда НЕ является
//! границей безопасности.

/// Запись текста в системный буфер обмена.
#[tauri::command(async)]
pub async fn clipboard_write(text: String) -> Result<(), String> {
    // Аудит clipboard 88: безлимитная строка целиком копировалась в память
    // и в буфер ОС
    const MAX_CLIPBOARD_BYTES: usize = 8 * 1024 * 1024;
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err(format!(
            "clipboard payload too large: {} bytes (limit {})",
            text.len(),
            MAX_CLIPBOARD_BYTES
        ));
    }
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
