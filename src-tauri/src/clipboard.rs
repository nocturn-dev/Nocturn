use std::sync::Mutex;
use std::time::Instant;

static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);
static LAST_WRITE: Mutex<Option<Instant>> = Mutex::new(None);

/// Запись текста в системный буфер обмена.
#[tauri::command(async)]
pub async fn clipboard_write(text: String) -> Result<(), String> {
    const MAX_CLIPBOARD_BYTES: usize = 8 * 1024 * 1024;
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err(format!(
            "clipboard payload too large: {} bytes (limit {})",
            text.len(),
            MAX_CLIPBOARD_BYTES
        ));
    }
    if text.is_empty() {
        return Ok(());
    }

    // Ограничение частоты записи: защищает от фонового спама и подмены данных клипперами
    {
        let mut last = LAST_WRITE.lock().map_err(|e| e.to_string())?;
        let now = Instant::now();
        if let Some(prev) = *last {
            if now.duration_since(prev).as_millis() < 100 {
                return Err("clipboard write rate limit exceeded".into());
            }
        }
        *last = Some(now);
    }

    // Сохраняем постоянный инстанс Clipboard под мьютексом:
    // на Linux X11/Wayland уничтожение объекта Clipboard отзывает владение буфером
    // у процесса, и текст пропадал при отсутствии системного менеджера буфера
    tokio::task::spawn_blocking(move || {
        let mut guard = CLIPBOARD.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        if let Some(ref mut c) = *guard {
            if let Err(e) = c.set_text(&text) {
                // Если дескриптор или соединение буфера сброшены системой, переинициализируем
                *guard = None;
                let mut retry = arboard::Clipboard::new().map_err(|e2| e2.to_string())?;
                retry
                    .set_text(&text)
                    .map_err(|e2| format!("{e}; retry failed: {e2}"))?;
                *guard = Some(retry);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("clipboard task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clipboard_payload_cap() {
        let huge = "a".repeat(8 * 1024 * 1024 + 1);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(clipboard_write(huge));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("payload too large"));
    }
}
