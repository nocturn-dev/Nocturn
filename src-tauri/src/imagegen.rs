//! Генерация изображений — опциональный инструмент агента (тумблер в настройках).
//! BYOK: запрос уходит только к провайдеру, выбранному пользователем
//! (OpenAI-совместимый `POST {base_url}/images/generations`) и для загрузки
//! сгенерированных изображений по публичным URL провайдера (с фильтрацией приватных адресов).
//! Результат сохраняется на диск (appdata/images), модели возвращается путь.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::settings::ApiSettings;
use zeroize::Zeroizing;

// ---------------------------------------------------------------------------
// Конфигурация (вкладка «Генерация изображений» в настройках)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(Default)]
pub struct ImageGenConfig {
    /// Выключено по умолчанию — инструмент появляется у модели только
    /// после явного включения
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    /// Размер картинки ("1024x1024" и т.п.), пусто — решает провайдер
    #[serde(default)]
    pub size: String,
}


pub static CONFIG: Mutex<Option<ImageGenConfig>> = Mutex::new(None);

pub fn config() -> ImageGenConfig {
    CONFIG.lock().unwrap_or_else(|p| p.into_inner()).clone().unwrap_or_default()
}

pub fn set_config(cfg: ImageGenConfig) {
    *CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg);
}

// ---------------------------------------------------------------------------
// Схема инструмента
// ---------------------------------------------------------------------------

pub fn imagegen_tool_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "image_generate",
            "description": "Generate an image from a text prompt via the user's configured image API; when the dedicated image settings are empty, the main chat connection is used. NEVER describe the requested image in text — call this tool to actually create it. The saved image is rendered in the chat for the user automatically. Returns JSON with the saved file path; you cannot see the image, only report that it is ready.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Image description (any language)" },
                    "size": { "type": "string", "description": "Optional size like 1024x1024; default from settings" }
                },
                "required": ["prompt"]
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// Потолок скачивания картинки: misconfigured/злонамеренный base_url,
/// отдающий гигабайты, раньше читался в память целиком (OOM)
const IMAGE_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// Потолок JSON-ответа провайдера
const JSON_MAX_BYTES: u64 = 10 * 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 4000;
const MIN_IMAGE_DIM: u32 = 64;
const MAX_IMAGE_DIM: u32 = 4096;

/// Валидация текста промпта: пустые промпты и превышающие лимит отсекаются
pub fn sanitize_prompt(prompt: &str) -> Result<String, String> {
    let p = prompt.trim();
    if p.is_empty() {
        return Err("prompt cannot be empty".into());
    }
    let count = p.chars().count();
    if count > MAX_PROMPT_CHARS {
        return Err(format!(
            "prompt too long: {count} characters (limit {MAX_PROMPT_CHARS})"
        ));
    }
    Ok(p.to_string())
}

/// Валидация и нормализация размера изображения вида "WIDTHxHEIGHT"
pub fn sanitize_size(size: &str) -> Result<String, String> {
    let s = size.trim();
    if s.is_empty() {
        return Ok(String::new());
    }
    let parts: Vec<&str> = s.split('x').collect();
    if parts.len() != 2 {
        return Err(format!(
            "invalid image size '{s}', expected WIDTHxHEIGHT format like 1024x1024"
        ));
    }
    let w: u32 = parts[0]
        .trim()
        .parse()
        .map_err(|_| format!("invalid width in image size '{s}'"))?;
    let h: u32 = parts[1]
        .trim()
        .parse()
        .map_err(|_| format!("invalid height in image size '{s}'"))?;
    if !(MIN_IMAGE_DIM..=MAX_IMAGE_DIM).contains(&w)
        || !(MIN_IMAGE_DIM..=MAX_IMAGE_DIM).contains(&h)
    {
        return Err(format!(
            "image dimensions in '{s}' are outside allowed range {MIN_IMAGE_DIM}..{MAX_IMAGE_DIM}"
        ));
    }
    Ok(format!("{w}x{h}"))
}

fn host_of(endpoint: &str) -> Option<String> {
    let s = endpoint.trim();
    if let Ok(u) = url::Url::parse(s) {
        return u.host_str().map(|h| h.to_ascii_lowercase());
    }
    let rest = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let host = rest
        .split(['/', ':', '?'])
        .next()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Целевое подключение для генерации. Приоритет у вкладки «Генерация
/// изображений»; её пустые поля дополняются текущим подключением чата
/// (settings.json). Ключ чата передаётся только если эндпоинт генерации
/// не задан или совпадает по хосту с чатом (защита от утечки ключа на сторонний хост).
fn resolve_target(
    cfg: &ImageGenConfig,
    chat: Option<&ApiSettings>,
) -> Result<(String, String, String), String> {
    let chat_base = chat.map(|c| c.base_url.as_str()).unwrap_or("");
    let chat_model = chat.map(|c| c.model.as_str()).unwrap_or("");
    let chat_key = chat.map(|c| c.api_key.as_str()).unwrap_or("");
    let cfg_base = cfg.base_url.as_str();
    let cfg_model = cfg.model.as_str();
    let cfg_key = cfg.api_key.as_str();

    let base = if !cfg_base.trim().is_empty() {
        cfg_base.trim().trim_end_matches('/').to_string()
    } else {
        chat_base.trim().trim_end_matches('/').to_string()
    };

    let model = if !cfg_model.trim().is_empty() {
        cfg_model.trim().to_string()
    } else {
        chat_model.trim().to_string()
    };

    let api_key = if !cfg_key.trim().is_empty() {
        cfg_key.trim().to_string()
    } else {
        let same_host = match (host_of(&base), host_of(chat_base)) {
            (Some(h1), Some(h2)) => h1 == h2,
            _ => false,
        };
        if cfg_base.trim().is_empty() || same_host {
            chat_key.trim().to_string()
        } else {
            String::new()
        }
    };

    if base.is_empty() || model.is_empty() {
        return Err(
            "Image generation is not configured: fill the Image tab in Settings \
             or connect an API in Settings → Connection"
                .into(),
        );
    }
    Ok((base, model, api_key))
}

/// Проверка Stop-флага между стадиями генерации (см. generate)
fn aborted(flag: Option<&std::sync::atomic::AtomicBool>) -> bool {
    flag.is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed))
}

/// Сгенерировать изображение и сохранить на диск.
/// Возвращает JSON-строку {ok, path, bytes} — текст для модели.
pub async fn generate(
    data_dir: &Path,
    prompt: &str,
    size: Option<&str>,
    chat: Option<&ApiSettings>,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    // Stop должен останавливать и генерацию картинок: конвейер — до 4
    // HTTP-стадий по ~3 минуты суммарно, без проверок «отменённый» вызов
    // тратил кредиты API все девять минут. HTTP-запрос посреди не рвём
    // (это потребовало бы дросселировать тело), но между стадиями — обязаны
    if aborted(abort) {
        return Err("aborted by user".to_string());
    }
    let cfg = config();
    if !cfg.enabled {
        return Err("Image generation is disabled in Settings".into());
    }
    let valid_prompt = sanitize_prompt(prompt)?;
    let (base, model, api_key_raw) = resolve_target(&cfg, chat)?;
    ensure_https_or_local(&base)?;
    // Ключ мог быть сохранён зашифрованным (vault): расшифровка на месте
    // использования — при заблокированном хранилище модель получит понятную
    // ошибку, а не молча уйдёт на провайдера без ключа
    let api_key = if crate::crypto::is_encrypted(&api_key_raw) {
        crate::crypto::decrypt(&api_key_raw)
            .ok_or("vault is locked: enter the master password to use the image API key")?
    } else {
        // Единый тип с веткой расшифровки: plaintext живёт в Zeroizing,
        // пока уходит в заголовок запроса
        Zeroizing::new(api_key_raw)
    };
    let url = format!("{base}/images/generations");
    let client = crate::network::shared_client(std::time::Duration::from_secs(15))
        .map_err(|e| format!("http client: {e}"))?;
    let raw_size = size
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| cfg.size.trim().to_string());
    let req_size = sanitize_size(&raw_size)?;

    // Попытка 1: стандартный OpenAI-совместимый images/generations.
    // 404/HTML означают, что у провайдера просто нет этой ручки — тогда
    // попытка 2: генерация через сам chat/completions (картинка приходит
    // в тексте ответа ссылкой или data-URI)
    if aborted(abort) {
        return Err("aborted by user".to_string());
    }
    let bytes = match post_images_endpoint(
        &client,
        &url,
        &model,
        api_key.trim(),
        &valid_prompt,
        Some(req_size.as_str()).filter(|s| !s.is_empty()),
    )
    .await
    {
        Ok(b) => b,
        Err((msg, retry)) if retry => {
            if aborted(abort) {
                return Err("aborted by user".to_string());
            }
            // Кандидаты: модель вкладки -> image-модели провайдера
            // (автодискавери по /models) -> модель чата. Останавливаемся
            // на первой удачной; каждая попытка - один запрос провайдеру
            let discovered = fetch_image_model_ids(&base, api_key.trim()).await;
            let candidates = image_model_candidates(&cfg.model, &model, &discovered);
            let mut first_err: Option<String> = None;
            let mut bytes_fb: Option<Vec<u8>> = None;
            for m in &candidates {
                if aborted(abort) {
                    return Err("aborted by user".to_string());
                }
                match chat_image_bytes(&client, &base, m, api_key.trim(), &valid_prompt).await {
                    Ok(b) => {
                        bytes_fb = Some(b);
                        break;
                    }
                    Err(e) => {
                        if first_err.is_none() {
                            first_err = Some(e);
                        }
                    }
                }
            }
            match bytes_fb {
                Some(b) => b,
                None => {
                    let hint = if discovered.is_empty() {
                        String::new()
                    } else {
                        format!(
                            " Your provider lists image models ({}): set one as the image model in Settings -> Image generation.",
                            discovered.join(", ")
                        )
                    };
                    return Err(format!(
                        "{msg}. Fallback via chat/completions failed: {}{hint}",
                        first_err.unwrap_or_else(|| "no candidates".into()),
                    ));
                }
            }
        }
        Err((msg, _)) => return Err(msg),
    };
    if aborted(abort) {
        return Err("aborted by user".to_string());
    }

    let dir = data_dir.join("images");
    // rand_hex8 вместо миллисекундного штампа: два вызова в одну миллисекунду
    // раньше тихо перезаписывали результат друг друга
    // Формат по сигнатуре: провайдер может отдать webp/gif — раньше всё
    // не-JPEG звалось .png, и asset-протокол отдавал контент не тем типом
    let ext = if bytes.starts_with(&[0xFF, 0xD8]) {
        "jpg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else {
        // неизвестный формат (HTML-заглушка, JSON
        // ошибки) раньше сохранялся как .png с "ok". Отказ вместо мусора
        return Err("response is not a recognized image format (jpeg/png/webp/gif)".into());
    };
    // Запись до 32 МБ (каталог может быть на сетевом профиле) — в
    // blocking-пул: sync fs::create_dir_all/fs::write на воркере tokio
    // морозили стримы (класс b451fd4)

    let (path, bytes_len) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(PathBuf, usize), String> {
            fs::create_dir_all(&dir).map_err(|e| format!("cannot create images dir: {e}"))?;
            let path: PathBuf = dir.join(format!(
                "img-{}.{}",
                crate::fsutil::rand_hex8(),
                ext
            ));
            fs::write(&path, &bytes).map_err(|e| format!("cannot save image: {e}"))?;
            Ok((path, bytes.len()))
        },
    )
    .await
    .map_err(|e| format!("image save task failed: {e}"))??;

    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "bytes": bytes_len,
        "note": "The image is saved and rendered in the chat for the user — do not re-describe it, just confirm it is ready.",
    })
    .to_string())
}


/// POST {base}/images/generations -> байты картинки. Ошибка несёт флаг
/// «стоит пробовать chat/completions» (404 или HTML-ответ: у провайдера
/// нет этой ручки — не тащим HTML-простыню в текст ошибки).
/// ключ в заголовках по открытому http — утечка.
/// http:// допустим только локальным адресам (localhost/LAN), как в
/// ensure_key_transport_is_safe в chat.rs
fn ensure_https_or_local(base: &str) -> Result<(), String> {
    let b = base.trim();
    if b.starts_with("https://") || !b.starts_with("http://") {
        return Ok(());
    }
    let rest = b.strip_prefix("http://").unwrap_or(b);
    let host = rest
        .split(['/', ':', '?'])
        .next()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let local = host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.parse::<std::net::Ipv4Addr>().map(|ip| {
            let o = ip.octets();
            ip.is_loopback()
                || o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 169 && o[1] == 254)
        }).unwrap_or(false);
    if local {
        Ok(())
    } else {
        Err(format!(
            "base URL {b} uses plain http:// — the API key would be sent unencrypted. Use https:// (http is allowed only for local addresses)"
        ))
    }
}

async fn post_images_endpoint(
    client: &reqwest::Client,
    url: &str,
    model: &str,
    api_key: &str,
    prompt: &str,
    size: Option<&str>,
) -> Result<Vec<u8>, (String, bool)> {
    let mut body = json!({ "model": model, "prompt": prompt, "n": 1 });
    if let Some(s) = size.map(str::trim).filter(|s| !s.is_empty()) {
        body["size"] = json!(s);
    }
    // Общий таймаут переехал с клиента на запрос: shared_client без overall-
    // timeout разделяется с чатом/MCP, у которых свои бюджеты
    let resp = client
        .post(url)
        .timeout(HTTP_TIMEOUT)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| (format!("request failed: {e}"), false))?;
    let status = resp.status();
    // Потолок JSON: враждебный base_url мог слать гигабайты
    let text_bytes = crate::network::read_body_capped(resp, JSON_MAX_BYTES)
        .await
        .map_err(|e| (e, false))?;
    let text = String::from_utf8_lossy(&text_bytes).to_string();
    if !status.is_success() {
        let html = text.trim_start().starts_with('<');
        let detail = if html {
            "an HTML page instead of JSON - this provider has no /images/generations endpoint"
                .to_string()
        } else {
            text.chars().take(300).collect()
        };
        let retry = status.as_u16() == 404 || html;
        return Err((format!("POST {url} -> HTTP {status}: {detail}"), retry));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| (format!("bad JSON response: {e}"), false))?;
    let item = v
        .get("data")
        .and_then(|d| d.get(0))
        .ok_or(("response has no data[0]".to_string(), false))?;

    // Провайдеры отдают либо b64_json, либо url - поддерживаем оба
    if let Some(b64) = item.get("b64_json").and_then(|x| x.as_str()) {
        use base64::Engine as _;
        return base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| (format!("bad base64 image: {e}"), false));
    }
    if let Some(img_url) = item.get("url").and_then(|x| x.as_str()) {
        return download_image(img_url).await.map_err(|e| (e, false));
    }
    Err(("response has neither b64_json nor url".to_string(), false))
}

/// Фолбэк: генерация через сам chat/completions - картинка приходит
/// в тексте ответа (markdown-ссылка, голый URL или data-URI).
async fn chat_image_bytes(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    api_key: &str,
    prompt: &str,
) -> Result<Vec<u8>, String> {
    ensure_https_or_local(base)?;
    let url = format!("{base}/chat/completions");
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
    });
    let resp = client
        .post(&url)
        .timeout(HTTP_TIMEOUT)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let text_bytes = crate::network::read_body_capped(resp, JSON_MAX_BYTES).await?;
    let text = String::from_utf8_lossy(&text_bytes).to_string();
    if !status.is_success() {
        let head: String = text.chars().take(200).collect();
        return Err(format!("chat/completions -> HTTP {status}: {head}"));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("bad JSON response: {e}"))?;
    let message = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .cloned()
        .ok_or("response has no choices[0].message")?;
    let (image, text_reply) = message_image_and_text(&message);
    match image.or_else(|| extract_image_ref(&text_reply)) {
        None => Err(
            "model reply contains no image (no markdown image, URL or data URI)".into(),
        ),
        Some(r) if r.starts_with("data:image/") => {
            let b64 = r.split("base64,").nth(1).unwrap_or("");
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("bad base64 image in chat reply: {e}"))
        }
        Some(img_url) => {
            // SSRF: ответ модели - недоверенный ввод, фильтр обязателен
            download_image(&img_url).await
        }
    }
}

/// Достать картинку и текст из message: понимает `message.images`
/// (OpenRouter-стиль: [{type:"image_url", image_url:{url}}]) и content
/// как строку, и как массив частей.
fn message_image_and_text(message: &Value) -> (Option<String>, String) {
    let mut image = message
        .get("images")
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
        .and_then(|p| {
            if let Some(s) = p.as_str() {
                Some(s.to_string())
            } else {
                p.get("image_url")
                    .and_then(|u| u.get("url"))
                    .and_then(|u| u.as_str())
                    .map(String::from)
            }
        });
    let text = match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => {
            let mut txt = String::new();
            for p in parts {
                if let Some(u) = p
                    .get("image_url")
                    .and_then(|u| u.get("url"))
                    .and_then(|u| u.as_str())
                {
                    if image.is_none() {
                        image = Some(u.to_string());
                    }
                } else if let Some(s) = p.get("text").and_then(|x| x.as_str()) {
                    txt.push_str(s);
                }
            }
            txt
        }
        _ => String::new(),
    };
    (image, text)
}

/// Вытащить ссылку на картинку из текста ответа модели
fn extract_image_ref(content: &str) -> Option<String> {
    // 1) data-URI
    if let Some(i) = content.find("data:image/") {
        let rest = &content[i..];
        let end = rest.find(['"', ')', ' ', ']']).unwrap_or(rest.len());
        return Some(rest[..end].to_string());
    }
    // 2) markdown-картинка ![...](url)
    if let Some(i) = content.find("](") {
        let rest = &content[i + 2..];
        if let Some(j) = rest.find(')') {
            let url = rest[..j].trim();
            if url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }
    // 3) первый голый http(s)-URL
    for token in content.split([' ', '"', '`', ')', ']', '\n']) {
        let tok = token.trim();
        if tok.starts_with("http://") || tok.starts_with("https://") {
            return Some(tok.to_string());
        }
    }
    None
}

/// Скачать картинку по URL (SSRF-фильтр внутри), потолок размера
async fn download_image(img_url: &str) -> Result<Vec<u8>, String> {
    crate::network::rejects_private_url(img_url)?;
    let dl = crate::network::shared_client(std::time::Duration::from_secs(15))
        .map_err(|e| format!("http client: {e}"))?;
    let r = dl
        .get(img_url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("image download failed: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("image download HTTP {}", r.status()));
    }
    crate::network::read_body_capped(r, IMAGE_MAX_BYTES).await
}


/// Модели-кандидаты для chat-фолбэка: явная модель вкладки -> найденные
/// image-модели провайдера (до 2) -> текущая модель чата. Дедуп по порядку.
fn image_model_candidates(
    cfg_model: &str,
    chat_model: &str,
    discovered: &[String],
) -> Vec<String> {
    fn push_unique(out: &mut Vec<String>, s: &str) {
        let s = s.trim();
        if !s.is_empty() && !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    }
    let mut out: Vec<String> = Vec::new();
    push_unique(&mut out, cfg_model);
    for d in discovered.iter().take(2) {
        push_unique(&mut out, d);
    }
    push_unique(&mut out, chat_model);
    out
}

/// Похоже ли имя модели на генератор картинок
fn looks_like_image_model(id: &str) -> bool {
    let id = id.to_lowercase();
    [
        "diffus", "image", "img", "dall", "flux", "stable", "sdxl", "sd3",
        "seedream", "imagen", "banana", "ideogram", "recraft", "photon",
        "kolors",
    ]
    .iter()
    .any(|k| id.contains(k))
}

/// GET {base}/models -> id моделей, похожих на генераторы картинок (до 2).
/// Best-effort: любая ошибка = пустой список.
async fn fetch_image_model_ids(base: &str, api_key: &str) -> Vec<String> {
    // Best-effort без `?`: функция возвращает Vec, а не Option
    let client = match crate::network::shared_client(std::time::Duration::from_secs(15)).ok() {
        Some(c) => c,
        None => return Vec::new(),
    };
    let url = format!("{base}/models");
    let resp = match client
        .get(&url)
        .timeout(HTTP_TIMEOUT)
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let text_bytes = match crate::network::read_body_capped(resp, JSON_MAX_BYTES).await {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let v: Value = match serde_json::from_str(&String::from_utf8_lossy(&text_bytes)) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let ids: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    ids.into_iter()
        .filter(|id| looks_like_image_model(id))
        .take(2)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(base: &str, model: &str, key: &str) -> ApiSettings {
        ApiSettings {
            api_key: key.into(),
            base_url: base.into(),
            model: model.into(),
            provider: "custom".into(),
            encrypt_keys: false,
            fallback_model: None,
        }
    }

    #[test]
    fn falls_back_to_chat_connection() {
        let cfg = ImageGenConfig { enabled: true, ..Default::default() };
        let (base, model, key) =
            resolve_target(&cfg, Some(&chat("http://localhost:9/v1", "grok-4.3", "sk-x")))
                .unwrap();
        assert_eq!(base, "http://localhost:9/v1");
        assert_eq!(model, "grok-4.3");
        assert_eq!(key, "sk-x");
    }

    #[test]
    fn dedicated_config_has_priority() {
        let cfg = ImageGenConfig {
            enabled: true,
            base_url: "http://img.local/v1".into(),
            api_key: "sk-img".into(),
            model: "img-model".into(),
            ..Default::default()
        };
        let (base, model, key) =
            resolve_target(&cfg, Some(&chat("http://chat.local/v1", "chat-model", "sk-chat")))
                .unwrap();
        assert_eq!(base, "http://img.local/v1");
        assert_eq!(model, "img-model");
        assert_eq!(key, "sk-img");
    }

    #[test]
    fn mixed_fields_are_filled_per_field() {
        let cfg = ImageGenConfig {
            enabled: true,
            base_url: "http://img.local/v1/".into(), // хвостовой слэш срезается
            ..Default::default()
        };
        let (base, model, key) =
            resolve_target(&cfg, Some(&chat("http://img.local/v1", "chat-model", "sk-chat"))).unwrap();
        assert_eq!(base, "http://img.local/v1");
        assert_eq!(model, "chat-model");
        assert_eq!(key, "sk-chat");
    }

    #[test]
    fn chat_key_is_never_leaked_to_foreign_host() {
        let cfg = ImageGenConfig {
            enabled: true,
            base_url: "https://api.foreign-image-ai.com/v1".into(),
            model: "dall-e-3".into(),
            ..Default::default()
        };
        let (base, model, key) = resolve_target(
            &cfg,
            Some(&chat("https://api.openai.com/v1", "gpt-4o", "sk-primary-secret")),
        )
        .unwrap();
        assert_eq!(base, "https://api.foreign-image-ai.com/v1");
        assert_eq!(model, "dall-e-3");
        assert_eq!(key, "", "ключ основного чата не должен передаваться на сторонний хост");
    }

    #[test]
    fn validates_prompt_and_size() {
        assert!(sanitize_prompt("").is_err());
        assert!(sanitize_prompt("   ").is_err());
        assert_eq!(sanitize_prompt("cat").unwrap(), "cat");
        let long_prompt = "a".repeat(4001);
        assert!(sanitize_prompt(&long_prompt).is_err());

        assert_eq!(sanitize_size("").unwrap(), "");
        assert_eq!(sanitize_size("1024x1024").unwrap(), "1024x1024");
        assert_eq!(sanitize_size(" 512 x 768 ").unwrap(), "512x768");
        assert!(sanitize_size("invalid").is_err());
        assert!(sanitize_size("10x10").is_err());
        assert!(sanitize_size("9999x9999").is_err());
    }

    #[test]
    fn nothing_configured_is_a_clear_error() {
        let cfg = ImageGenConfig { enabled: true, ..Default::default() };
        let err = resolve_target(&cfg, None).unwrap_err();
        assert!(err.contains("not configured"));
        let err = resolve_target(&cfg, Some(&chat("", "", ""))).unwrap_err();
        assert!(err.contains("not configured"));
    }
    #[test]
    fn extracts_image_from_chat_reply() {
        assert_eq!(
            extract_image_ref("вот ![картинка](https://x.com/a.png) готово").as_deref(),
            Some("https://x.com/a.png")
        );
        assert_eq!(
            extract_image_ref("data:image/png;base64,AAAA").as_deref(),
            Some("data:image/png;base64,AAAA")
        );
        assert_eq!(
            extract_image_ref("файл: https://cdn.example.org/img/ab.jpg?sig=1 ок").as_deref(),
            Some("https://cdn.example.org/img/ab.jpg?sig=1")
        );
        assert_eq!(extract_image_ref("просто текст, ничего нет"), None);
    }
    #[test]
    fn image_candidates_order_and_dedupe() {
        let out = image_model_candidates(
            "",
            "grok-4.3",
            &["ashna-diffusion-1".into(), "flux-1".into()],
        );
        assert_eq!(out, vec!["ashna-diffusion-1", "flux-1", "grok-4.3"]);
        // Явная модель вкладки - первой; дубликат чат-модели не дублируется
        let out = image_model_candidates(
            "grok-4.3",
            "grok-4.3",
            &["ashna-diffusion-1".into()],
        );
        assert_eq!(out, vec!["grok-4.3", "ashna-diffusion-1"]);
        // Пустые строки не попадают
        let out = image_model_candidates("", "", &[]);
        assert!(out.is_empty());
    }

    #[test]
    fn image_model_detector() {
        assert!(looks_like_image_model("ashna-diffusion-1"));
        assert!(looks_like_image_model("dall-e-3"));
        assert!(looks_like_image_model("gemini-2.5-flash-image"));
        assert!(!looks_like_image_model("grok-4.3"));
        assert!(!looks_like_image_model("gpt-4o"));
    }

    #[test]
    fn message_images_openrouter_style() {
        let m = serde_json::json!({
            "images": [{ "type": "image_url", "image_url": { "url": "data:image/png;base64,QQ" } }],
            "content": ""
        });
        let (img, txt) = message_image_and_text(&m);
        assert_eq!(img.as_deref(), Some("data:image/png;base64,QQ"));
        assert!(txt.is_empty());
    }

    #[test]
    fn content_array_parts() {
        let m = serde_json::json!({
            "content": [
                { "type": "text", "text": "вот" },
                { "type": "image_url", "image_url": { "url": "https://x.com/a.png" } }
            ]
        });
        let (img, txt) = message_image_and_text(&m);
        assert_eq!(img.as_deref(), Some("https://x.com/a.png"));
        assert_eq!(txt, "вот");
    }
}
