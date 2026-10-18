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

#[derive(Clone, Default)]
struct NetworkState {
    config: NetworkConfig,
    ca_pem: Option<Result<Vec<u8>, String>>,
}

/// Атомарное состояние сетевой конфигурации и предзагруженного сертификата:
/// синхронное чтение и обновление под одним мьютексом гарантируют целостность,
/// исключая окно рассинхронизации между конфигом и PEM-данными
static STATE: Mutex<Option<NetworkState>> = Mutex::new(None);

pub fn config() -> NetworkConfig {
    STATE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|s| s.config.clone())
        .unwrap_or_default()
}

/// Потолок чтения CA-файла: PEM-бандл из сотен корней — сотни КБ; больше —
/// не сертификат, а случайный/враждебный файл, который не уйдёт в память
const CA_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Чтение корневого сертификата по пользовательскому пути. Смена якоря
/// доверия TLS ВСЕХ исходящих вызовов приложения: путь с
/// фронтенда проходит общий sensitive-гардал и канонизацию через dunce
/// (симлинк не уводит чтение в защищённую локацию, вербатим-префиксы убираются).
/// Читаем строго по проверенному каноническому пути без опасных фолбэков.
fn read_ca_file(path: &str) -> Result<Vec<u8>, String> {
    crate::settings::rejects_sensitive_path(path)?;
    let canon = dunce::canonicalize(path).map_err(|e| format!("cannot resolve CA path: {e}"))?;
    crate::settings::rejects_sensitive_path(&canon.to_string_lossy())?;
    let meta = std::fs::metadata(&canon).map_err(|e| format!("cannot read CA file: {e}"))?;
    if !meta.is_file() {
        return Err("CA path is not a regular file".into());
    }
    if meta.len() > CA_MAX_BYTES {
        return Err(format!(
            "CA file too large: {} bytes (limit {CA_MAX_BYTES})",
            meta.len()
        ));
    }
    std::fs::read(&canon).map_err(|e| format!("cannot read CA file: {e}"))
}

pub fn set_config(cfg: NetworkConfig) {
    let ca = if cfg.ca_path.trim().is_empty() {
        None
    } else {
        Some(read_ca_file(cfg.ca_path.trim()))
    };
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some(NetworkState {
        config: cfg,
        ca_pem: ca,
    });
}

/// Относится ли IPv4 к приватным, loopback, link-local, benchmark или зарезервированным адресам
pub fn is_private_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 127
        || o[0] == 10
        || o[0] == 0
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 169 && o[1] == 254)
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        // 192.0.0.0/24 (IETF protocol assignments)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        // 198.18.0.0/15 (benchmark-сети)
        || (o[0] == 198 && (18..=19).contains(&o[1]))
        // 240.0.0.0/4 (reserved; включает 255.255.255.255)
        || o[0] >= 240
}

/// Относится ли IPv6 к loopback, unspecified, ULA, link-local или трансляционным диапазонам с приватным IPv4
pub fn is_private_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_ipv4(v4);
    }
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    let seg = ip.segments();
    // fc00::/7 (ULA), fe80::/10 (link-local)
    if (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // 64:ff9b::/96 (NAT64): последние 32 бита — вложенный IPv4
    if seg[0] == 0x0064 && seg[1] == 0xff9b {
        // 64:ff9b:1::/48 — локальный NAT64 (RFC 8215)
        if seg[2] == 0x0001 {
            return true;
        }
        let v4 = std::net::Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            seg[6] as u8,
            (seg[7] >> 8) as u8,
            seg[7] as u8,
        );
        return is_private_ipv4(v4);
    }
    // 2002::/16 (6to4): первые 32 бита после префикса — вложенный IPv4
    if seg[0] == 0x2002 {
        let v4 = std::net::Ipv4Addr::new(
            (seg[1] >> 8) as u8,
            seg[1] as u8,
            (seg[2] >> 8) as u8,
            seg[2] as u8,
        );
        return is_private_ipv4(v4);
    }
    false
}

/// Относится ли IP-адрес к приватным (IPv4 или IPv6)
pub fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_private_ipv4(v4),
        std::net::IpAddr::V6(v6) => is_private_ipv6(v6),
    }
}

/// Проверка URL на отсутствие приватных, локальных и внутренних IP-адресов (SSRF-фильтрация).
/// Включает разбор схемы (строго http/https), литеральных IP и DNS-резолв доменных имён.
pub fn rejects_private_url(url_str: &str) -> Result<(), String> {
    use std::net::ToSocketAddrs;

    let parsed = url::Url::parse(url_str).map_err(|e| format!("invalid URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("unsupported URL scheme '{scheme}', only http and https are allowed"));
    }

    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => {
            if is_private_ipv4(ip) {
                return Err(format!("private IPv4 address {ip} is rejected"));
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if is_private_ipv6(ip) {
                return Err(format!("private IPv6 address {ip} is rejected"));
            }
        }
        Some(url::Host::Domain(domain)) => {
            let d = domain.to_ascii_lowercase();
            if matches!(d.as_str(), "localhost" | "localhost.localdomain" | "ip6-localhost")
                || d.ends_with(".localhost")
                || d.ends_with(".local")
                || d.ends_with(".internal")
                || d.ends_with(".lan")
            {
                return Err(format!("internal domain '{domain}' is rejected"));
            }

            let port = parsed.port_or_known_default().unwrap_or(80);
            if let Ok(addrs) = (domain, port).to_socket_addrs() {
                for addr in addrs {
                    if is_private_ip(addr.ip()) {
                        return Err(format!(
                            "domain '{domain}' resolves to private IP {} and is rejected",
                            addr.ip()
                        ));
                    }
                }
            }
        }
        None => return Err("URL has no host".into()),
    }
    Ok(())
}

/// Чтение тела HTTP-ответа с потолком размера в байтах для защиты от исчерпания памяти (OOM)
/// и stall-таймаутом на чанки, чтобы зависший сервер не держал поток вечно
pub async fn read_body_capped(
    mut resp: reqwest::Response,
    limit: u64,
) -> Result<Vec<u8>, String> {
    const CHUNK_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
    if let Some(len) = resp.content_length() {
        if len > limit {
            return Err(format!("response too large: {len} bytes (limit {limit})"));
        }
    }
    let mut out: Vec<u8> = Vec::new();
    loop {
        let chunk_res = tokio::time::timeout(CHUNK_STALL_TIMEOUT, resp.chunk()).await;
        let chunk_opt = match chunk_res {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => return Err(format!("download failed: {e}")),
            Err(_) => return Err("download stalled: no data received for 30s".to_string()),
        };
        match chunk_opt {
            Some(chunk) => {
                if out.len() as u64 + chunk.len() as u64 > limit {
                    return Err(format!("response too large (limit {limit} bytes)"));
                }
                out.extend_from_slice(&chunk);
            }
            None => break,
        }
    }
    Ok(out)
}

/// Строгая политика редиректов:
/// 1. Не более 5 переходов.
/// 2. Запрет перехода с HTTPS на HTTP (защита от downgrade-атак и раскрытия данных).
/// 3. Запрет смены хоста: reqwest не снимает x-api-key и пользовательские токены
///    при междоменном редиректе, поэтому сохраняем контекст внутри исходного хоста.
/// 4. Блокировка перехода с публичных адресов на приватные/loopback (SSRF).
fn ssrf_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many redirects");
        }
        let prev = attempt
            .previous()
            .last()
            .or_else(|| attempt.previous().first())
            .cloned();
        if let Some(prev_url) = prev {
            if prev_url.scheme() == "https" && attempt.url().scheme() == "http" {
                return attempt.error("redirect from HTTPS to HTTP is forbidden");
            }
            let prev_host = prev_url.host_str().unwrap_or("").to_string();
            let next_host = attempt.url().host_str().unwrap_or("").to_string();
            if next_host != prev_host {
                let msg = format!("redirect to different host blocked: {prev_host} -> {next_host}");
                return attempt.error(msg);
            }
        }
        let origin_public = attempt
            .previous()
            .first()
            .is_some_and(|u| crate::browser::url_is_public_http(u.as_str()));
        if origin_public && !crate::browser::url_is_public_http(attempt.url().as_str()) {
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
    let (cfg, ca) = {
        let guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
        let s = guard.clone().unwrap_or_default();
        (s.config, s.ca_pem)
    };
    let mut b = builder.redirect(ssrf_redirect_policy());
    if !cfg.proxy.trim().is_empty() {
        let mut proxy = reqwest::Proxy::all(cfg.proxy.trim())
            .map_err(|e| format!("invalid proxy URL: {e}"))?;
        // Локальные адреса должны обходить корпоративный прокси всегда:
        // даже если пользователь задал свой список исключений, loopback-адреса
        // обязаны присутствовать, чтобы не ломать локальные сервисы
        let default_no_proxy = "localhost,127.0.0.1,::1";
        let no_proxy = if cfg.no_proxy.trim().is_empty() {
            default_no_proxy.to_string()
        } else {
            format!("{default_no_proxy},{}", cfg.no_proxy.trim())
        };
        proxy = proxy.no_proxy(reqwest::NoProxy::from_string(&no_proxy));
        b = b.proxy(proxy);
    } else {
        // При пустом cfg.proxy прямое соединение не должно неявно использовать
        // переменные окружения HTTP_PROXY/HTTPS_PROXY хоста
        b = b.no_proxy();
    }
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
    let (cfg, ca_fp) = {
        let guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
        let s = guard.clone().unwrap_or_default();
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        match &s.ca_pem {
            Some(Ok(pem)) => pem.hash(&mut h),
            Some(Err(e)) => e.hash(&mut h),
            None => 0u64.hash(&mut h),
        }
        (s.config, h.finish())
    };
    let fp = format!(
        "{connect_timeout:?}|{}|{}|{ca_fp:x}",
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
    // TCP keepalive и idle таймаут пула: выявляем обрывы соединений на уровне ОС
    // и очищаем неактивные сокеты без утечки дескрипторов
    let builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .tcp_keepalive(std::time::Duration::from_secs(60))
        .pool_idle_timeout(std::time::Duration::from_secs(90));
    let client = apply(builder)?
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
    // Предварительная валидация перед показом диалога и сохранением на диск:
    // если параметры некорректны, прерываем сразу, не затрагивая конфиг
    if !config.proxy.trim().is_empty() {
        reqwest::Proxy::all(config.proxy.trim()).map_err(|e| format!("invalid proxy URL: {e}"))?;
    }
    if !config.ca_path.trim().is_empty() {
        read_ca_file(config.ca_path.trim())?;
    }

    let old = self::config();
    let proxy_changed = old.proxy.trim() != config.proxy.trim();
    let ca_changed = old.ca_path.trim() != config.ca_path.trim();

    // Смена прокси или корневого CA позволяет перехватывать сетевой трафик и ключи:
    // требуем явного подтверждения пользователя через нативный диалог
    if (proxy_changed && !config.proxy.trim().is_empty()) || (ca_changed && !config.ca_path.trim().is_empty()) {
        let mut details = Vec::new();
        if proxy_changed {
            details.push(format!("Proxy: {}", config.proxy.trim()));
        }
        if ca_changed {
            details.push(format!("Custom CA: {}", config.ca_path.trim()));
        }
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let confirmed = app
            .dialog()
            .message(format!(
                "Change network configuration?\n\n{}\n\nProxy and root CA certificates affect all outgoing requests of the application.",
                details.join("\n")
            ))
            .title("Confirm Network Configuration")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Allow".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        if !confirmed {
            return Err("network configuration update cancelled by user".to_string());
        }
    }

    // set_config читает CA-файл по пользовательскому пути — тот может быть
    // сетевым (UNC): запись конфига + чтение CA в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        // Проверяем чтение CA-файла до записи на диск, чтобы не портить сохранённый
        // конфиг при битом или недоступном файле
        if !config.ca_path.trim().is_empty() {
            read_ca_file(config.ca_path.trim())?;
        }
        set_config(config.clone());
        crate::settings::save_json_config(&app, "network.json", &config)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("network config task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// Глобал CONFIG общий на процесс, а cargo test крутит тесты параллельно:
    /// без этой сериализации apply_without_proxy_is_ok мог затереть конфиг
    /// посреди apply_rejects_invalid_proxy_url (флак, всплывший при росте
    /// числа тестов бинарника). Каждый тест, трогающий set_config, держит
    /// локуз на всё тело
    fn config_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Старые network.json без новых полей читаются дефолтами (serde default
    /// на каждом поле) — миграции конфига не нужны
    #[test]
    fn config_deserializes_from_empty_object() {
        let cfg: NetworkConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(cfg.proxy.is_empty());
        assert!(cfg.no_proxy.is_empty());
        assert!(cfg.ca_path.is_empty());
    }

    /// Кривой proxy URL не пропускает запрос молча: apply() отдаёт ошибку
    /// наружу (контракт doc-комментария apply — «запрос не уйдёт в обход
    /// настройки»). Глобал CONFIG сохраняем и восстанавливаем: тесты
    /// крутятся в одном процессе
    #[test]
    fn apply_rejects_invalid_proxy_url() {
        let _guard = config_lock();
        let saved = config();
        set_config(NetworkConfig {
            proxy: "not a url".into(),
            ..Default::default()
        });
        let res = apply(reqwest::ClientBuilder::new());
        set_config(saved);
        let err = res.expect_err("invalid proxy must fail");
        assert!(err.contains("invalid proxy URL"), "неожиданная ошибка: {err}");
    }

    /// Пустой конфиг — прямое соединение, builder переводится в no_proxy
    #[test]
    fn apply_without_proxy_is_ok() {
        let _guard = config_lock();
        let saved = config();
        set_config(NetworkConfig::default());
        let res = apply(reqwest::ClientBuilder::new());
        set_config(saved);
        assert!(res.is_ok());
    }

    /// Пользовательский no_proxy дополняет, а не затирает дефолтные loopback-адреса
    #[test]
    fn apply_with_custom_no_proxy_preserves_loopback() {
        let _guard = config_lock();
        let saved = config();
        set_config(NetworkConfig {
            proxy: "http://proxy.corp.example:8080".into(),
            no_proxy: "corp.internal,example.com".into(),
            ..Default::default()
        });
        let res = apply(reqwest::ClientBuilder::new());
        set_config(saved);
        assert!(res.is_ok());
    }

    /// shared_client успешно создаётся с keepalive и кэшируется
    #[test]
    fn shared_client_caches_and_builds() {
        let _guard = config_lock();
        let client1 = shared_client(std::time::Duration::from_secs(10)).unwrap();
        let client2 = shared_client(std::time::Duration::from_secs(10)).unwrap();
        // Тот же фингерпринт возвращает клон
        assert_eq!(std::mem::size_of_val(&client1), std::mem::size_of_val(&client2));
    }

    /// Проверка чтения CA-файла: несуществующий файл или sensitive-путь отклоняются
    #[test]
    fn read_ca_file_validation() {
        assert!(read_ca_file("C:\\nonexistent_ca_file_12345.pem").is_err());
        // Чувствительные пути (например .ssh) отклоняются
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
        if !home.is_empty() {
            let sensitive = format!("{home}/.ssh/id_rsa");
            assert!(read_ca_file(&sensitive).is_err());
        }
    }

    /// Валидное чтение временного сертификата
    #[test]
    fn read_ca_file_success() {
        let dir = std::env::temp_dir().join(format!("nocturn_ca_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test_ca.pem");
        let sample = b"-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n";
        std::fs::write(&path, sample).unwrap();

        let read = read_ca_file(&path.to_string_lossy()).unwrap();
        assert_eq!(read, sample);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_private_url_filters_private_and_local() {
        assert!(rejects_private_url("http://127.0.0.1/test.png").is_err());
        assert!(rejects_private_url("https://192.168.1.50/pic.jpg").is_err());
        assert!(rejects_private_url("http://10.0.0.1/foo").is_err());
        assert!(rejects_private_url("http://169.254.169.254/latest").is_err());
        assert!(rejects_private_url("http://localhost:8080/image").is_err());
        assert!(rejects_private_url("http://myhost.local/a.png").is_err());
        assert!(rejects_private_url("file:///etc/passwd").is_err());
        assert!(rejects_private_url("data:image/png;base64,QQ==").is_err());
        assert!(rejects_private_url("javascript:alert(1)").is_err());
        // Публичные домены разрешены
        assert!(rejects_private_url("https://images.unsplash.com/photo-1").is_ok());
    }
}

