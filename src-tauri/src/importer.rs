//! Живой поиск библиотеки джейлбрейков: скачивание файлов источников по URL.
//! Текстовый импорт из локального файла убран (живой поиск заменил) — здесь
//! остался единственный сетевой примитив: одиночный GET по явному клику.
//! SSRF-фильтр браузера режет приватные/loopback/метаданные хосты, редиректы
//! — ssrf-aware политика network.rs, тело капится по чанкам.

use crate::browser::url_is_public_http;
use std::time::Duration;

const MAX_BODY: usize = 32 * 1024 * 1024;

/// Синхронный гардал URL: только публичный http/https (SSRF-фильтр browser.rs).
pub(crate) fn validate_import_url(url: &str) -> Result<(), String> {
    if url_is_public_http(url) {
        Ok(())
    } else {
        Err("URL rejected: only public http/https URLs are allowed (private networks are blocked)"
            .into())
    }
}

/// Скачать текст (файл источника / trees-JSON GitHub) для живого поиска.
/// Вызывается ТОЛЬКО явным кликом пользователя; тело капится по ходу
/// чтения чанков, чтобы не буферизовать чужой гигабайт целиком.
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
}
