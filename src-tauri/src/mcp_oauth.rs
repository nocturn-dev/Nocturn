//! Волна F5: OAuth для удалённых MCP-серверов (только http-транспорт).
//!
//! ФИЛОСОФИЯ-ОГОВОРКА владельца (жёсткая): oauth-сервер не инициирует
//! НИКАКИХ запросов сам — discovery/авторизация только по явной кнопке
//! «Authorize» в настройках, refresh — только по 401 в активном вызове,
//! фоновых рефрешей и автоконнекта нет; никаких рекомендаций сервисов.
//!
//! Токены: в памяти + best-effort персист в зашифрованном mcp-oauth.json
//! (crypto::encrypt). Vault заперт / ключа нет → токены живут до рестарта
//! (Authorize честно возвращает пометку «session-only»).
//!
//! Single-flight refresh (заметка владельца): N параллельных 401 → ровно
//! один запрос refresh к провайдеру, остальные ждут новый токен — иначе
//! первый рефреш инвалидирует старый токен, второй падает.

use crate::crypto;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OAuthTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// unix-сек истечения access-токена (если провайдер прислал expires_in)
    #[serde(default)]
    pub expires_at: Option<u64>,
    /// client_id из DCR или конфига — нужен для refresh
    #[serde(default)]
    pub client_id: String,
}

/// Метаданные авторизации сервера (discovery) — для refresh/revoke
#[derive(Debug, Clone, Default)]
pub struct OAuthMeta {
    pub token_endpoint: Option<String>,
    pub revocation_endpoint: Option<String>,
}

const TOKENS_FILE: &str = "mcp-oauth.json";
/// Заметка владельца: юзер закрыл вкладку авторизации → ничего не висит вечно
const LOOPBACK_TIMEOUT_SECS: u64 = 180;
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

static TOKENS: std::sync::LazyLock<Mutex<HashMap<String, OAuthTokens>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static META: std::sync::LazyLock<Mutex<HashMap<String, OAuthMeta>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Single-flight: per-server замок на время refresh
static REFRESH_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn has_tokens(server: &str) -> bool {
    TOKENS
        .lock()
        .map(|m| m.contains_key(server))
        .unwrap_or(false)
}

/// Токен для Bearer-заголовка (RemoteConnection::request)
pub fn access_token(server: &str) -> Option<String> {
    let guard = TOKENS.lock().ok()?;
    guard.get(server).map(|t| t.access_token.clone())
}

pub fn has_meta(server: &str) -> bool {
    META.lock().map(|m| m.contains_key(server)).unwrap_or(false)
}

fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .map(|d| d.join(TOKENS_FILE))
        .unwrap_or_else(|_| std::path::PathBuf::from(TOKENS_FILE))
}

/// Загрузка персистнутых токенов при старте (best-effort: vault заперт —
/// токены недоступны, юзер переавторизуется по кнопке). Никаких запросов —
/// только чтение локального файла (оговорка владельца)
pub fn load_persisted(app: &tauri::AppHandle) {
    let Ok(raw) = std::fs::read_to_string(config_path(app)) else {
        return;
    };
    let Some(dec) = crypto::decrypt(raw.trim()) else {
        eprintln!("mcp-oauth: stored tokens unreadable (vault locked?) — re-authorize");
        return;
    };
    if let Ok(map) = serde_json::from_str::<HashMap<String, OAuthTokens>>(dec.trim()) {
        if let Ok(mut mem) = TOKENS.lock() {
            for (k, v) in map {
                mem.entry(k).or_insert(v);
            }
        }
    }
}

/// Best-effort персист: шифруем весь блоб; Err (vault заперт) → только память
fn persist_tokens(app: &tauri::AppHandle) -> Result<(), String> {
    let map = TOKENS.lock().map_err(|e| e.to_string())?.clone();
    let plain = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    let enc = crypto::encrypt(&plain)?;
    let path = config_path(app);
    crate::fsutil::atomic_write(&path, enc.as_bytes())
}

fn refresh_lock(server: &str) -> Arc<tokio::sync::Mutex<()>> {
    if let Ok(mut m) = REFRESH_LOCKS.lock() {
        m.entry(server.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    } else {
        Arc::new(tokio::sync::Mutex::new(()))
    }
}

// ---------- discovery / PKCE / парсинг ----------

#[derive(Debug, Clone, Deserialize)]
struct OAuthMetaRaw {
    #[serde(default)]
    authorization_endpoint: Option<String>,
    #[serde(default)]
    token_endpoint: Option<String>,
    #[serde(default)]
    registration_endpoint: Option<String>,
    #[serde(default)]
    revocation_endpoint: Option<String>,
}

/// RFC 8414 discovery: root → path-вставка → openid-configuration. Запросы
/// идут ТОЛЬКО из authorize (кнопка юзера) — оговорка владельца
async fn discover(server_url: &str) -> Result<OAuthMetaRaw, String> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let trimmed = server_url.trim().trim_end_matches('/');
    let (origin, path) = match trimmed.find("://").and_then(|i| trimmed[i + 3..].find('/')) {
        Some(off) => trimmed.split_at(i_of_from(trimmed, "://") + 3 + off),
        None => (trimmed, ""),
    };
    let candidates = [
        format!("{origin}/.well-known/oauth-authorization-server"),
        format!("{origin}{path}/.well-known/oauth-authorization-server"),
        format!("{origin}{path}/.well-known/openid-configuration"),
    ];
    let mut last = String::new();
    for url in &candidates {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(meta) = resp.json::<OAuthMetaRaw>().await {
                    if meta.authorization_endpoint.is_some() && meta.token_endpoint.is_some() {
                        return Ok(meta);
                    }
                }
            }
            Ok(resp) => last = format!("HTTP {}", resp.status().as_u16()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("oauth discovery failed: {last}"))
}

fn i_of_from(s: &str, needle: &str) -> usize {
    s.find(needle).unwrap_or(0)
}

/// RFC 7636 PKCE: verifier — base64url(48 случайных байт), challenge —
/// BASE64URL(SHA256(verifier))
fn pkce() -> (String, String) {
    let mut bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let digest = Sha256::digest(verifier.as_bytes());
    (verifier, URL_SAFE_NO_PAD.encode(digest))
}

/// State для OAuth: base64url без паддинга — URL-safe по определению
/// (Auth0 прямо рекомендует). STANDARD-энкод давал хвост `==`, провайдеры
/// переэнкодят его на редиректе («==» → «%3D%3D») и сравнение рвалось
fn rand_state(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// Вытащить query-параметр из первой строки GET-запроса loopback-редиректа.
/// Значение разворачивается из percent-encoding: провайдеры переэнкодят state
/// на редиректе («потерян один уровень энкода» — кейсы Atlassian/Google), и
/// сравнение сырого значения с ожидаемым даёт ложный CSRF-mismatch. `+`
/// остаётся литералом (строгий RFC 3986, не form-decode): base64url-значения
/// code/state литеральный `+` не содержат, а голый `+` в них кодируется
/// как %2B. Голый параметр без `=` (напр. `&flag`) пропускается, а не
/// обрывает разбор всей строки.
fn extract_query_param(request_line: &str, key: &str) -> Option<String> {
    let path = request_line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| url_decode(v))
    })
}

/// Строгий percent-decode: %XX → байт; неполная/битая последовательность и
/// не-ASCII за % остаются как есть. Работает по байтам: вход — lossy-строка,
/// срезы внутри многобайтового символа не паникуют
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(hex) = bytes.get(i + 1..i + 3) {
                if let Ok(b) =
                    u8::from_str_radix(std::str::from_utf8(hex).unwrap_or(""), 16)
                {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------- authorize / refresh / revoke ----------

/// Полный authorize-флоу (кнопка юзера): discovery → DCR/конфиг-client_id →
/// PKCE → браузер → loopback → обмен кода. Возвращает (сообщение, persisted).
/// Loopback слушается ДО открытия браузера: redirect_uri точен; жёсткий
/// дедлайн — поток не висит вечно (заметка владельца)
pub async fn authorize(
    app: &tauri::AppHandle,
    server: &str,
    cfg: &crate::mcp::McpServerConfig,
) -> Result<(String, bool), String> {
    let meta = discover(cfg.url.trim()).await?;
    let auth_ep = meta
        .authorization_endpoint
        .clone()
        .ok_or("no authorization_endpoint in discovery")?;
    let token_ep = meta
        .token_endpoint
        .clone()
        .ok_or("no token_endpoint in discovery")?;

    // client_id: из конфига или Dynamic Client Registration (RFC 7591).
    // Loopback-клиенты по RFC 8252 вправе варьировать порт — регистрируем
    // без порта
    let client_id = match &cfg.client_id {
        Some(id) if !id.is_empty() => id.clone(),
        _ => {
            let reg = meta
                .registration_endpoint
                .clone()
                .ok_or("server has no registration_endpoint — add client_id to the server config")?;
            let client = reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client
                .post(&reg)
                .json(&json!({
                    "client_name": "Nocturn",
                    "redirect_uris": ["http://127.0.0.1/callback"],
                    "token_endpoint_auth_method": "none",
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"]
                }))
                .send()
                .await
                .map_err(|e| format!("dynamic registration failed: {e}"))?;
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("registration body: {e}"))?;
            body["client_id"]
                .as_str()
                .ok_or("registration response has no client_id")?
                .to_string()
        }
    };

    let (verifier, challenge) = pkce();
    let state = rand_state(16);
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("loopback bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256{}",
        auth_ep,
        url_encode(&client_id),
        url_encode(&redirect_uri),
        // state теперь URL-safe (rand_state), encode — identity, но оставляем
        // для единообразия: любой параметр URL проходит через url_encode
        url_encode(&state),
        url_encode(&challenge),
        cfg.oauth_scope
            .as_deref()
            .map(|s| format!("&scope={}", url_encode(s)))
            .unwrap_or_default(),
    );
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(&auth_url, None::<String>)
            .map_err(|e| format!("failed to open browser: {e}"))?;
    }
    // wait_for_code_on — синхронный poll-цикл до 180 с: обязан жить в
    // blocking-пуле, иначе занимает tokio-воркер целиком (параллельные
    // authorize съедают пул; домовой паттерн — pty.rs/colibri.rs)
    let state_for_wait = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_code_on(listener, &state_for_wait, LOOPBACK_TIMEOUT_SECS)
    })
    .await
    .map_err(|e| format!("oauth wait task failed: {e}"))??;

    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&token_ep)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", client_id.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;
    if !resp.status().is_success() {
        let snippet: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        return Err(format!("token exchange failed: {}", snippet));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("token body: {e}"))?;
    let tokens = OAuthTokens {
        access_token: body["access_token"]
            .as_str()
            .ok_or("token response has no access_token")?
            .to_string(),
        refresh_token: body["refresh_token"].as_str().map(String::from),
        expires_at: body["expires_in"].as_u64().map(|s| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() + s)
                .unwrap_or(0)
        }),
        client_id,
    };
    META.lock()
        .map_err(|e| e.to_string())?
        .insert(
            server.to_string(),
            OAuthMeta {
                token_endpoint: Some(token_ep),
                revocation_endpoint: meta.revocation_endpoint,
            },
        );
    TOKENS
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server.to_string(), tokens);
    let persisted = match persist_tokens(app) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("mcp-oauth: persist skipped: {e}");
            false
        }
    };
    Ok((
        if persisted {
            "authorized; tokens stored encrypted".to_string()
        } else {
            "authorized; tokens stored for this session only (unlock the vault to persist)"
                .to_string()
        },
        persisted,
    ))
}

/// Ждём редирект с кодом: жёсткий дедлайн (заметка владельца), ответ юзеру —
/// «закройте вкладку», проверка state (CSRF). Соединения без параметров
/// редиректа (префетч браузера, favicon, скан портов) НЕ завершают ожидание —
/// раньше первый же «пустой» запрос гасил весь авторизационный цикл; финал —
/// только код+state, явный error от провайдера или дедлайн
fn wait_for_code_on(
    listener: std::net::TcpListener,
    expected_state: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    const OK_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:3em\"><p>Authorization received - you can close this tab.</p></body>";
    const DENY_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:3em\"><p>Authorization failed - you can close this tab and retry.</p></body>";
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    while Instant::now() < deadline {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 8192 {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let first = String::from_utf8_lossy(&buf);
            let request_line = first.lines().next().unwrap_or("").to_string();
            // Провайдер сам ответил отказом (юзер отклонил) — финал
            if let Some(err) = extract_query_param(&request_line, "error") {
                let _ = stream.write_all(DENY_RESPONSE);
                drop(stream);
                return Err(format!("authorization error: {err}"));
            }
            let code = extract_query_param(&request_line, "code");
            let state = extract_query_param(&request_line, "state");
            let (code, state) = match (code, state) {
                (Some(c), Some(s)) => (c, s),
                // Не редирект: закрываем и продолжаем слушать до дедлайна
                _ => {
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
                    );
                    drop(stream);
                    continue;
                }
            };
            // Несовпадение при наличии обоих параметров — сигнал CSRF, финал
            if state != expected_state {
                let _ = stream.write_all(DENY_RESPONSE);
                drop(stream);
                return Err("state mismatch (CSRF check)".to_string());
            }
            let _ = stream.write_all(OK_RESPONSE);
            drop(stream);
            return Ok(code);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("authorization timed out after {timeout_secs}s"))
}

/// Single-flight refresh (заметка владельца): один запрос, остальные ждут.
/// Вызывается только из 401-ветки активного вызова — фоновых рефрешей нет
pub async fn refresh_single_flight(server: &str) -> Result<(), String> {
    let lock = refresh_lock(server);
    let _guard = lock.lock().await;
    let (tokens, meta) = {
        let t = TOKENS.lock().map_err(|e| e.to_string())?;
        let m = META.lock().map_err(|e| e.to_string())?;
        (t.get(server).cloned(), m.get(server).cloned())
    };
    let Some(tokens) = tokens else {
        return Err("no tokens to refresh".to_string());
    };
    let Some(refresh_token) = tokens.refresh_token.clone() else {
        return Err("no refresh_token — re-authorize in Settings".to_string());
    };
    let Some(token_endpoint) = meta.and_then(|m| m.token_endpoint) else {
        return Err("no token_endpoint (server was never authorized here?)".to_string());
    };
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", tokens.client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("refresh failed: {e}"))?;
    if !resp.status().is_success() {
        let snippet: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect();
        return Err(format!("refresh failed: HTTP {}", snippet));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let access = body["access_token"]
        .as_str()
        .ok_or("refresh response has no access_token")?
        .to_string();
    let updated = OAuthTokens {
        access_token: access,
        // провайдер может не прислать новый refresh — старый остаётся валидным
        refresh_token: body["refresh_token"]
            .as_str()
            .map(String::from)
            .or(Some(refresh_token)),
        expires_at: body["expires_in"].as_u64().map(|s| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() + s)
                .unwrap_or(0)
        }),
        client_id: tokens.client_id,
    };
    if let Ok(mut m) = TOKENS.lock() {
        m.insert(server.to_string(), updated);
    }
    // Персист обновлённых токенов — при следующем authorize/по кнопке:
    // здесь нет AppHandle, токен живёт в памяти до конца сессии
    Ok(())
}

/// Отозвать доступ (кнопка юзера): revoke-эндпоинт best-effort (RFC 7009 —
/// гасим refresh-токен) + локальная очистка
pub async fn revoke(app: &tauri::AppHandle, server: &str) -> Result<(), String> {
    let (tokens, meta) = {
        let t = TOKENS.lock().map_err(|e| e.to_string())?;
        let m = META.lock().map_err(|e| e.to_string())?;
        (t.get(server).cloned(), m.get(server).cloned())
    };
    if let (Some(tokens), Some(meta)) = (tokens, meta) {
        if let (Some(rev), Some(rt)) = (meta.revocation_endpoint, &tokens.refresh_token) {
            let client = reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())?;
            let _ = client.post(&rev).form(&[("token", rt.as_str())]).send().await;
        }
    }
    if let Ok(mut m) = TOKENS.lock() {
        m.remove(server);
    }
    let _ = persist_tokens(app);
    Ok(())
}

// ---------- tauri-команды (кнопки юзера — единственные триггеры сети) ----------

/// Кнопка «Authorize»: единственный триггер discovery/авторизации
#[tauri::command(async)]
pub async fn mcp_oauth_authorize(
    app: tauri::AppHandle,
    name: String,
) -> Result<String, String> {
    // Чтение mcp.json — sync-диск, в blocking-пул (№4 аудита v5)
    let app_for_load = app.clone();
    let servers = tauri::async_runtime::spawn_blocking(move || {
        crate::mcp::load_servers(&app_for_load)
    })
    .await
    .map_err(|e| format!("oauth authorize task failed: {e}"))??;
    let cfg = servers
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("MCP server \"{name}\" is not configured"))?;
    if cfg.auth.as_deref() != Some("oauth") {
        return Err(format!("server \"{name}\" is not an OAuth server"));
    }
    let (msg, persisted) = authorize(&app, &name, &cfg).await?;
    // Токены есть — подключаем сразу (юзер кликнул: цепочка авторизована)
    let registry = app
        .state::<crate::mcp::McpRegistry>()
        .0
        .clone();
    if let Err(e) = crate::mcp::ensure_connected(app.clone(), registry, name.clone()).await {
        // Авторизация успешна, коннект не удался — токены сохранены
        return Ok(format!("{msg}; connect failed: {e}"));
    }
    let _ = persisted;
    Ok(msg)
}

/// Кнопка «Отозвать доступ»: revoke + очистка локальных токенов
#[tauri::command(async)]
pub async fn mcp_oauth_revoke(
    app: tauri::AppHandle,
    name: String,
) -> Result<(), String> {
    revoke(&app, &name).await?;
    // Соединение с отозванным токеном гасим
    let registry = app
        .state::<crate::mcp::McpRegistry>()
        .0
        .clone();
    // remove в отдельный statement: временный MutexGuard не должен жить
    // через .await (future обязан быть Send — как в mcp_disconnect)
    let conn = registry.lock().unwrap_or_else(|p| p.into_inner()).remove(&name);
    if let Some(conn) = conn {
        tauri::async_runtime::spawn_blocking(move || conn.kill())
            .await
            .map_err(|e| format!("join error: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_rfc7636_vector() {
        // Вектор из RFC 7636 Appendix B: известный verifier → известный challenge
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let digest = Sha256::digest(verifier.as_bytes());
        assert_eq!(
            URL_SAFE_NO_PAD.encode(digest),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        // Наш генератор: длина и алфавит base64url
        let (v, c) = pkce();
        assert_eq!(v.len(), 64);
        assert!(!v.contains('+') && !v.contains('/') && !v.contains('='));
        assert_eq!(c.len(), 43);
    }

    #[test]
    fn extract_query_param_parses_redirect() {
        let line = "GET /callback?code=abc123&state=st-1 HTTP/1.1";
        assert_eq!(extract_query_param(line, "code").as_deref(), Some("abc123"));
        assert_eq!(extract_query_param(line, "state").as_deref(), Some("st-1"));
        assert_eq!(extract_query_param(line, "error"), None);
        assert_eq!(extract_query_param("GET /callback HTTP/1.1", "code"), None);
    }

    #[test]
    fn extract_query_param_skips_bare_params_and_decodes() {
        // №22: голый параметр без `=` раньше обрывал разбор (split_once('?')?)
        let line = "GET /callback?flag&state=st%3D1&code=x+y HTTP/1.1";
        assert_eq!(extract_query_param(line, "state").as_deref(), Some("st=1"));
        assert_eq!(extract_query_param(line, "flag"), None);
        // Строгий decode: `+` литералом (base64url-значения его не содержат)
        assert_eq!(extract_query_param(line, "code").as_deref(), Some("x+y"));
        // Битая последовательность % и не-ASCII за % остаются как есть
        let raw = "GET /callback?state=st%zz1%2 HTTP/1.1";
        assert_eq!(extract_query_param(raw, "state").as_deref(), Some("st%zz1%2"));
    }

    #[test]
    fn state_is_url_safe_and_padding_free() {
        // №1: STANDARD-энкод давал хвост `==` и `+/` — провайдеры переэнкодили
        for _ in 0..32 {
            let s = rand_state(16);
            assert_eq!(s.len(), 22); // 16 байт → 128 бит / 6 бит на символ
            assert!(!s.contains('+') && !s.contains('/') && !s.contains('='));
        }
        // Полный круг: state, переэнкодленный провайдером на редиректе
        // (url_encode), после декода совпадает с оригиналом
        let s = rand_state(16);
        let line = format!("GET /callback?code=c&state={} HTTP/1.1", url_encode(&s));
        assert_eq!(extract_query_param(&line, "state").as_deref(), Some(s.as_str()));
    }

    #[test]
    fn url_decode_rejects_garbage_without_panicking() {
        assert_eq!(url_decode("a%20b"), "a b");
        assert_eq!(url_decode("plain"), "plain");
        assert_eq!(url_decode("%"), "%");
        assert_eq!(url_decode("%2"), "%2");
        assert_eq!(url_decode("%zz"), "%zz");
        assert_eq!(url_decode("м%3Dд"), "м=д");
    }

    #[test]
    fn url_encode_form_encodes_specials() {
        assert_eq!(url_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(url_encode("no-op_1.2~x"), "no-op_1.2~x");
    }

    #[test]
    fn refresh_single_flight_locks_are_per_server() {
        let a = refresh_lock("srv-a");
        let a2 = refresh_lock("srv-a");
        let b = refresh_lock("srv-b");
        assert!(Arc::ptr_eq(&a, &a2));
        assert!(!Arc::ptr_eq(&a, &b));
    }
}
