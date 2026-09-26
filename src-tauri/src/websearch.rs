//! Веб-поиск — опциональный инструмент агента (тумблер в настройках).
//! BYOK: SearXNG (свой инстанс, без ключа) или Brave Search API (ключ юзера).
//! Модуль ходит только туда, куда указал пользователь; результат — текстовый
//! список для модели.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Конфигурация (вкладка «Веб-поиск» в настройках)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WebSearchConfig {
    /// Выключено по умолчанию — инструмент появляется у модели только
    /// после явного включения
    #[serde(default)]
    pub enabled: bool,
    /// "searxng" | "brave"
    #[serde(default)]
    pub provider: String,
    /// База SearXNG, напр. "http://localhost:8888" (нужен включённый format=json)
    #[serde(default)]
    pub searxng_url: String,
    /// Brave Search API key (api.search.brave.com)
    #[serde(default)]
    pub brave_key: String,
}

pub static CONFIG: Mutex<Option<WebSearchConfig>> = Mutex::new(None);

pub fn config() -> WebSearchConfig {
    CONFIG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_default()
}

pub fn set_config(cfg: WebSearchConfig) {
    *CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg);
}

// ---------------------------------------------------------------------------
// Схема инструмента
// ---------------------------------------------------------------------------

pub fn websearch_tool_schema() -> Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information. Returns a numbered list of results (title, URL, snippet). Use it for news, docs, version numbers, prices — anything that may be newer than your training data or outside it. To read a full page afterwards, fetch its URL with browser_navigate + browser_read if browser tools are enabled.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query (any language)" },
                    "count": { "type": "integer", "description": "Max results, 1-10, default 5" }
                },
                "required": ["query"]
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// Потолок JSON-ответа поисковика: мусорный/злонамеренный инстанс не должен
/// читаться в память без ограничений
const JSON_MAX_BYTES: usize = 8 * 1024 * 1024;
const SNIPPET_MAX: usize = 300;

/// Обрезка по границе символа (кириллица/эмодзи)
fn clip(s: &str, limit: usize) -> String {
    let mut out = s.trim().to_string();
    crate::truncate_at_char_boundary(&mut out, limit);
    out
}

fn fmt_results(results: &[(String, String, String)]) -> String {
    if results.is_empty() {
        return "No results found.".to_string();
    }
    results
        .iter()
        .enumerate()
        .map(|(i, (title, url, snippet))| {
            format!(
                "{}. {}\n   {}\n   {}",
                i + 1,
                title,
                url,
                if snippet.is_empty() { "—" } else { snippet }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// GET с прокси/CA из настроек сети; тело с потолком размера
async fn http_get(url: &str, headers: Vec<(String, String)>) -> Result<String, String> {
    let client = crate::network::apply(
        reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(15)),
    )?
    .build()
    .map_err(|e| format!("failed to build http client: {e}"))?;
    let mut req = client.get(url).timeout(HTTP_TIMEOUT);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    let status = resp.status();
    if let Some(len) = resp.content_length() {
        if len as usize > JSON_MAX_BYTES {
            return Err("search response too large".to_string());
        }
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;
    if !status.is_success() {
        let snippet: String = body.chars().take(200).collect();
        return Err(format!("HTTP {}: {}", status.as_u16(), snippet));
    }
    if body.len() > JSON_MAX_BYTES {
        return Err("search response too large".to_string());
    }
    Ok(body)
}

/// query в query-string: std не имеет urlencode, crate ради одного параметра
/// не тянем — формируем percent-encoding вручную
fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn collect_json_items(v: &Value, url_key: &str, snippet_key: &str, count: usize) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    let Some(items) = v.get("results").and_then(|r| r.as_array()) else {
        return out;
    };
    for it in items {
        if out.len() >= count {
            break;
        }
        let title = it.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let link = it.get(url_key).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let snippet = it.get(snippet_key).and_then(|x| x.as_str()).unwrap_or("").to_string();
        if link.is_empty() {
            continue;
        }
        out.push((clip(&title, 160), link, clip(&snippet, SNIPPET_MAX)));
    }
    out
}

async fn searxng(base: &str, query: &str, count: usize) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("SearXNG URL is not configured (Settings → Веб-поиск)".to_string());
    }
    let url = format!("{}/search?q={}&format=json", base, urlencode(query));
    let body = http_get(&url, Vec::new()).await?;
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("bad JSON from SearXNG: {e}"))?;
    // У SearXNG сниппет лежит в "content"; у Brave — "description", а сами
    // результаты вложены в web.results (нормализуем тут, один walker на обоих)
    let items = collect_json_items(&v, "url", "content", count);
    Ok(fmt_results(&items))
}

async fn brave(key: &str, query: &str, count: usize) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Brave API key is not configured (Settings → Веб-поиск)".to_string());
    }
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
        urlencode(query),
        count
    );
    let headers = vec![
        ("X-Subscription-Key".to_string(), key.to_string()),
        ("Accept".to_string(), "application/json".to_string()),
    ];
    let body = http_get(&url, headers).await?;
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("bad JSON from Brave: {e}"))?;
    let empty = Vec::new();
    let direct = collect_json_items(&v, "url", "description", count);
    let items = if direct.is_empty() {
        v.pointer("/web/results")
            .and_then(|r| r.as_array())
            .map(|arr| {
                arr.iter()
                    .take(count)
                    .filter_map(|it| {
                        let link = it.get("url").and_then(|x| x.as_str())?;
                        if link.is_empty() {
                            return None;
                        }
                        Some((
                            clip(it.get("title").and_then(|x| x.as_str()).unwrap_or(""), 160),
                            link.to_string(),
                            clip(it.get("description").and_then(|x| x.as_str()).unwrap_or(""), SNIPPET_MAX),
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or(empty)
    } else {
        direct
    };
    Ok(fmt_results(&items))
}

/// Вход инструмента: провайдер из конфига, count 1-10 (дефолт 5)
pub async fn execute(query: &str, count: Option<u64>) -> Result<String, String> {
    let cfg = config();
    if !cfg.enabled {
        return Err("Web search is disabled in Settings".to_string());
    }
    let query = query.trim();
    if query.is_empty() {
        return Err("empty search query".to_string());
    }
    let count = count.unwrap_or(5).clamp(1, 10) as usize;
    match cfg.provider.as_str() {
        "brave" => brave(&cfg.brave_key, query, count).await,
        _ => searxng(&cfg.searxng_url, query, count).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_percent_encodes() {
        assert_eq!(urlencode("hello world"), "hello+world");
        // 'a','&','b','=','с' — кириллица кодируется двумя байтами
        assert_eq!(urlencode("a&b=с"), "a%26b%3D%D1%81");
        assert_eq!(urlencode("safe-_.~"), "safe-_.~");
    }

    #[test]
    fn fmt_handles_empty_and_snippet_clipping() {
        assert_eq!(fmt_results(&[]), "No results found.");
        let long = "ё".repeat(1000);
        let res = vec![(clip("t", 160), "https://x".into(), clip(&long, SNIPPET_MAX))];
        let out = fmt_results(&res);
        assert!(out.contains("ё"));
        assert!(out.chars().filter(|c| *c == 'ё').count() <= SNIPPET_MAX);
    }

    #[test]
    fn collect_items_skips_empty_links_and_caps() {
        let v: Value = serde_json::json!({ "results": [
            { "title": "A", "url": "https://a", "content": "s1" },
            { "title": "B", "content": "no url" },
            { "title": "C", "url": "https://c", "content": "s3" }
        ]});
        let items = collect_json_items(&v, "url", "content", 2);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].1, "https://a");
        assert_eq!(items[1].1, "https://c");
    }
}
