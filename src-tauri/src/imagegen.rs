//! Генерация изображений — опциональный инструмент агента (тумблер в настройках).
//! BYOK: запрос уходит только к провайдеру, выбранному пользователем
//! (OpenAI-совместимый `POST {base_url}/images/generations`). Модуль не имеет
//! собственных серверов и никуда сам не обращается.
//! Результат сохраняется на диск (appdata/images), модели возвращается путь.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
            "description": "Generate an image from a text prompt via the user's configured image API. Returns JSON with the saved file path. The file is saved locally; you cannot see it, only report the path.",
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

/// Сгенерировать изображение и сохранить на диск.
/// Возвращает JSON-строку {ok, path, bytes} — текст для модели.
pub async fn generate(data_dir: &Path, prompt: &str, size: Option<&str>) -> Result<String, String> {
    let cfg = config();
    if !cfg.enabled {
        return Err("Image generation is disabled in Settings".into());
    }
    let base = cfg.base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() || cfg.model.trim().is_empty() {
        return Err("Image generation is not configured (base URL / model)".into());
    }
    // Ключ мог быть сохранён зашифрованным (vault): расшифровка на месте
    // использования — при заблокированном хранилище модель получит понятную
    // ошибку, а не молча уйдёт на провайдера без ключа
    let api_key = if crate::crypto::is_encrypted(&cfg.api_key) {
        crate::crypto::decrypt(&cfg.api_key)
            .ok_or("vault is locked: enter the master password to use the image API key")?
    } else {
        cfg.api_key.clone()
    };
    let url = format!("{base}/images/generations");

    let client = crate::network::apply(reqwest::Client::builder().timeout(HTTP_TIMEOUT))
        .map_err(|e| format!("http client: {e}"))?
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut body = json!({ "model": cfg.model.trim(), "prompt": prompt, "n": 1 });
    let size = size
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| cfg.size.trim().to_string());
    if !size.is_empty() {
        body["size"] = json!(size);
    }
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let head: String = text.chars().take(500).collect();
        return Err(format!("provider returned HTTP {status}: {head}"));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("bad JSON response: {e}"))?;
    let item = v
        .get("data")
        .and_then(|d| d.get(0))
        .ok_or("response has no data[0]")?;

    // Провайдеры отдают либо b64_json, либо url — поддерживаем оба
    let bytes: Vec<u8> = if let Some(b64) = item.get("b64_json").and_then(|x| x.as_str()) {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("bad base64 image: {e}"))?
    } else if let Some(img_url) = item.get("url").and_then(|x| x.as_str()) {
        let dl = crate::network::apply(reqwest::Client::builder().timeout(DOWNLOAD_TIMEOUT))
            .map_err(|e| format!("http client: {e}"))?
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let r = dl
            .get(img_url)
            .send()
            .await
            .map_err(|e| format!("image download failed: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("image download HTTP {}", r.status()));
        }
        r.bytes()
            .await
            .map_err(|e| format!("image download failed: {e}"))?
            .to_vec()
    } else {
        return Err("response has neither b64_json nor url".into());
    };

    let dir = data_dir.join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create images dir: {e}"))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path: PathBuf = dir.join(format!("img-{ts}.{}", if bytes.starts_with(&[0xFF, 0xD8]) { "jpg" } else { "png" }));
    fs::write(&path, &bytes).map_err(|e| format!("cannot save image: {e}"))?;

    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "bytes": bytes.len(),
    })
    .to_string())
}
