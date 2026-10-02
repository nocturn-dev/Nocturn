//! Импорт библиотеки джейлбрейков: чтение файла и скачивание по URL.
//! Гардалы переиспользуют существующие поверхности: sensitive-path для
//! чтения (как settings_import_read) и SSRF-фильтр браузера для URL —
//! обе операции запускаются ТОЛЬКО явным кликом пользователя из UI.

use crate::browser::url_is_public_http;
use crate::settings::rejects_sensitive_path;
use std::time::Duration;

const MAX_BODY: usize = 32 * 1024 * 1024;

/// Синхронное ядро чтения: guards + канонизация + кап. Выделено из команды,
/// чтобы регресс-тесты гоняли гардалы без tokio-рантайма.
pub(crate) fn import_text_read_blocking(path: &str) -> Result<String, String> {
    rejects_sensitive_path(path)?;
    // Канонизация + ревалидация здесь же: симлинк не должен обходить
    // блок-лист, а metadata на сетевом пути блокирующ (паттерн
    // settings_import_read — сам вызов живёт в spawn_blocking)
    let canon = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    rejects_sensitive_path(&canon)?;
    crate::fsutil::read_capped_string(std::path::Path::new(path), 0)
}

/// Синхронный гардал URL: только публичный http/https (SSRF-фильтр browser.rs).
pub(crate) fn validate_import_url(url: &str) -> Result<(), String> {
    if url_is_public_http(url) {
        Ok(())
    } else {
        Err("URL rejected: only public http/https URLs are allowed (private networks are blocked)"
            .into())
    }
}

/// Прочитать текстовый файл импорта (CSV/JSON/TXT/MD) целиком.
/// Лимит 32 МБ общий с settings_import_read: больше в библиотеку всё равно
/// не влезет, а поверх лимита read_capped_string сам вернёт понятную ошибку.
#[tauri::command(async)]
pub async fn import_text_read(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || import_text_read_blocking(&path))
        .await
        .map_err(|e| format!("import read task failed: {e}"))?
}

/// Скачать текст (CSV/MD) по URL для импорта. Редиректы — ssrf-aware
/// политика из network.rs; тело капится по ходу чтения чанков, чтобы
/// не буферизовать чужой гигабайт целиком.
#[tauri::command(async)]
pub async fn import_fetch_url(url: String) -> Result<String, String> {
    validate_import_url(&url)?;
    let client = crate::network::shared_client(Duration::from_secs(10))?;
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("fetch failed: HTTP {status}"));
    }
    let mut body: Vec<u8> = Vec::new();
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(format!("body too large (limit {MAX_BODY} bytes)"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_url_guard_rejects_private_and_loopback_without_network() {
        // гардал синхронный и стоит до reqwest: приватные адреса и не-HTTP
        // схемы не доходят до сети
        for url in [
            "http://127.0.0.1/jb.csv",
            "http://[::1]/jb.csv",
            "http://169.254.169.254/latest/meta-data",
            "http://localhost/x.csv",
            "http://2130706433/x", // целочисленный IPv4-алиас loopback
            "file:///etc/passwd",
            "ftp://example.com/x",
            "not a url",
        ] {
            assert!(validate_import_url(url).is_err(), "must reject: {url}");
        }
    }

    #[test]
    fn fetch_url_guard_accepts_public_https() {
        assert!(validate_import_url("https://raw.githubusercontent.com/x/y/main/a.csv").is_ok());
    }

    #[test]
    fn text_read_rejects_sensitive_paths() {
        for p in ["/etc/passwd", "../settings-export.json", "export/file.csv"] {
            assert!(import_text_read_blocking(p).is_err(), "must reject: {p}");
        }
    }

    #[test]
    fn text_read_roundtrip_temp_file() {
        let dir = std::env::temp_dir().join(format!("jb-import-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.csv");
        std::fs::write(&file, "name,text\na,\"b,c\"\n").unwrap();
        let got = import_text_read_blocking(file.to_str().unwrap()).unwrap();
        assert!(got.contains("\"b,c\""));
        std::fs::remove_dir_all(&dir).ok();
    }
}
