//! Сетевые настройки: HTTP-прокси, исключения (no-proxy), свой корневой
//! сертификат. Накладываются на все исходящие HTTP-клиенты (чат, тест
//! соединения, Ollama, генерация изображений) при их построении; встроенный
//! браузер ходит по системным настройкам. Настройки читаются из network.json.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

/// PEM, прочитанный при set_config: apply() вызывается на КАЖДЫЙ запрос
/// (chat_stream/test_connection/detect_ollama) — синхронный fs::read там
/// висел на UNC-пути/отвалившемся диске до SMB-таймаута и стоял целый
/// tokio-воркер со всеми стримами. Читаем один раз при смене конфига.
static CA_PEM: Mutex<Option<Result<Vec<u8>, String>>> = Mutex::new(None);

pub fn config() -> NetworkConfig {
    CONFIG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_default()
}

pub fn set_config(cfg: NetworkConfig) {
    let ca = if cfg.ca_path.trim().is_empty() {
        None
    } else {
        Some(
            std::fs::read(cfg.ca_path.trim())
                .map_err(|e| format!("cannot read CA file: {e}")),
        )
    };
    let mut slot = CA_PEM.lock().unwrap_or_else(|p| p.into_inner());
    *slot = ca;
    drop(slot);
    *CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg);
}

/// SSRF-aware редиректы: дефолт reqwest следует до 10 редиректов, проверяя
/// только исходный URL — публичная ссылка, редиректящая на loopback или
/// метадату (169.254.169.254), пробивала SSRF-фильтры imagegen/browser,
/// которые смотрят только на первый адрес. Правило: смена хоста с публичного
/// на приватный запрещена; локальный сервер (Ollama/LM Studio), редиректящий
/// внутри себя или на другой локальный адрес, не считается эскалацией —
/// исходный base_url уже настроен пользователем.
fn ssrf_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many redirects");
        }
        let origin_public = attempt
            .previous()
            .first()
            .is_some_and(|u| crate::browser::url_is_public_http(u.as_str()));
        if origin_public && !crate::browser::url_is_public_http(attempt.url().as_str()) {
            // error() забирает attempt по значению — сообщение собираем заранее
            let msg = format!("redirect to non-public address blocked: {}", attempt.url());
            return attempt.error(msg);
        }
        attempt.follow()
    })
}

/// Наложить сетевые настройки на построитель HTTP-клиента.
/// Ошибки конфигурации (кривой URL, нечитаемый/невалидный PEM) отдаются
/// наружу — запрос не уйдёт молча в обход настройки.
pub fn apply(builder: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder, String> {
    let cfg = config();
    let mut b = builder.redirect(ssrf_redirect_policy());
    if !cfg.proxy.trim().is_empty() {
        let mut proxy = reqwest::Proxy::all(cfg.proxy.trim())
            .map_err(|e| format!("invalid proxy URL: {e}"))?;
        if !cfg.no_proxy.trim().is_empty() {
            proxy = proxy.no_proxy(reqwest::NoProxy::from_string(cfg.no_proxy.trim()));
        }
        b = b.proxy(proxy);
    }
    let ca = CA_PEM
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(pem) = ca {
        let pem = pem?;
        let cert = reqwest::Certificate::from_pem(&pem)
            .map_err(|e| format!("invalid CA certificate: {e}"))?;
        b = b.add_root_certificate(cert);
    }
    Ok(b)
}

/// Разделяемые HTTP-клиенты: reqwest::Client спроектирован переиспользуемым
/// (keep-alive, пул соединений, TLS-сессии), а строился на каждый запрос —
/// каждый ход чата и каждый tools/call remote-MCP платил TCP+TLS-handshake
/// заново. Кэш — карта по фингерпринту сетевого конфига (прокси/no_proxy/CA +
/// connect-таймаут): однослотовый кэш в смешанном прогоне (чат 30 с против
/// remote-MCP/imagegen 15 с) промахивался на каждый вызов и пересобирал
/// клиента — handshake вместо keep-alive, от чего кэш и спасает. Смена
/// настроек через set_config автоматически даёт новый клиент на следующем
/// запросе, явной инвалидации не нужно. Потолок мал: фингерпринтов реально
/// пара (два таймаута × текущий сетевой конфиг), свип при переполнении —
/// страховка от гипотетического разрастания.
static CLIENT_CACHE: Mutex<Option<HashMap<String, reqwest::Client>>> = Mutex::new(None);
const CLIENT_CACHE_CAP: usize = 8;

pub fn shared_client(connect_timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    let cfg = config();
    // Фингерпринт содержимого CA — хэш, а не длина: замена сертификата
    // файлом того же размера обязана пересобрать клиент
    let ca_fp = CA_PEM
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|r| {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            match r.as_ref() {
                Ok(pem) => pem.hash(&mut h),
                Err(e) => e.hash(&mut h),
            }
            h.finish()
        });
    let fp = format!(
        "{connect_timeout:?}|{}|{}|{ca_fp:?}",
        cfg.proxy, cfg.no_proxy
    );
    if let Some(client) = CLIENT_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|cache| cache.get(&fp))
    {
        return Ok(client.clone());
    }
    let client = apply(reqwest::Client::builder().connect_timeout(connect_timeout))?
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;
    let mut guard = CLIENT_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    if cache.len() >= CLIENT_CACHE_CAP {
        cache.clear();
    }
    cache.insert(fp, client.clone());
    Ok(client)
}

#[tauri::command(async)]
pub fn network_get_config() -> NetworkConfig {
    config()
}

#[tauri::command(async)]
pub async fn network_set_config(
    app: tauri::AppHandle,
    config: NetworkConfig,
) -> Result<(), String> {
    // set_config читает CA-файл по пользовательскому пути — тот может быть
    // сетевым (UNC): запись конфига + чтение CA в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        crate::settings::save_json_config(&app, "network.json", &config)?;
        set_config(config);
        Ok(())
    })
    .await
    .map_err(|e| format!("network config task failed: {e}"))?
}
