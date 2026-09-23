//! Сетевые настройки: HTTP-прокси, исключения (no-proxy), свой корневой
//! сертификат. Накладываются на все исходящие HTTP-клиенты (чат, тест
//! соединения, Ollama, генерация изображений) при их построении; встроенный
//! браузер ходит по системным настройкам. Настройки читаются из network.json.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetworkConfig {
    /// URL прокси (http(s)://host:port); пусто — прямое соединение
    #[serde(default)]
    pub proxy: String,
    /// Хосты в обход прокси, через запятую (host, *.corp.com)
    #[serde(default)]
    pub no_proxy: String,
    /// Путь к PEM-файлу корневого сертификата
    #[serde(default)]
    pub ca_path: String,
}

pub static CONFIG: Mutex<Option<NetworkConfig>> = Mutex::new(None);

pub fn config() -> NetworkConfig {
    CONFIG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_default()
}

pub fn set_config(cfg: NetworkConfig) {
    *CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg);
}

/// Наложить сетевые настройки на построитель HTTP-клиента.
/// Ошибки конфигурации (кривой URL, нечитаемый/невалидный PEM) отдаются
/// наружу — запрос не уйдёт молча в обход настройки.
pub fn apply(builder: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder, String> {
    let cfg = config();
    let mut b = builder;
    if !cfg.proxy.trim().is_empty() {
        let mut proxy = reqwest::Proxy::all(cfg.proxy.trim())
            .map_err(|e| format!("invalid proxy URL: {e}"))?;
        if !cfg.no_proxy.trim().is_empty() {
            proxy = proxy.no_proxy(reqwest::NoProxy::from_string(cfg.no_proxy.trim()));
        }
        b = b.proxy(proxy);
    }
    if !cfg.ca_path.trim().is_empty() {
        let pem = std::fs::read(cfg.ca_path.trim())
            .map_err(|e| format!("cannot read CA file: {e}"))?;
        let cert = reqwest::Certificate::from_pem(&pem)
            .map_err(|e| format!("invalid CA certificate: {e}"))?;
        b = b.add_root_certificate(cert);
    }
    Ok(b)
}

#[tauri::command(async)]
pub fn network_get_config() -> NetworkConfig {
    config()
}

#[tauri::command(async)]
pub fn network_set_config(
    app: tauri::AppHandle,
    config: NetworkConfig,
) -> Result<(), String> {
    crate::settings::save_json_config(&app, "network.json", &config)?;
    set_config(config);
    Ok(())
}
