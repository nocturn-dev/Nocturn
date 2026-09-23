//! Стриминговый чат: SSE-аккумуляторы (OpenAI-совместимый и нативный
//! Anthropic), команды chat_stream / chat_abort / detect_ollama / test_connection,
//! реестр отмены стримов.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
/// Реестр флагов отмены стримов: requestId → флаг
pub struct AbortRegistry(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

/// RAII-guard: удаляет запись из AbortRegistry при выходе из любого пути
/// (ранний return по abort-флагу, "[DONE]", все "?"-выходы). Ручной remove
/// в конце функции больше не нужен — Drop чистит автоматически.
struct AbortGuard<'a> {
    registry: &'a AbortRegistry,
    request_id: String,
}

impl Drop for AbortGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.registry.0.lock() {
            map.remove(&self.request_id);
        }
    }
}
#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub vision: bool,
    pub text: bool,
    /// Контекстное окно, если провайдер его отдаёт (OpenRouter:
    /// top_provider.context_length / context_length; vLLM: max_model_len)
    #[serde(default)]
    pub context: Option<u64>,
}

/// Лёгкая проверка провайдера: GET {base_url}/models со Bearer-ключом.
#[tauri::command]
pub async fn test_connection(base_url: String, api_key: String) -> Result<Vec<ModelInfo>, String> {
    let base_url = normalize_base_url(&base_url);
    // Лимит страницы понимает не каждый провайдер (Gemini на нём падает
    // с 400), а OpenRouter без него отдаёт весь список — оставляем
    // ?limit только Anthropic, остальным — голый /models
    let url = if is_anthropic_base(&base_url) {
        format!("{}/models?limit=100", base_url.trim_end_matches('/'))
    } else {
        format!("{}/models", base_url.trim_end_matches('/'))
    };

    let client = crate::network::apply(reqwest::Client::builder())?.build().map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    if is_anthropic_base(&base_url) {
        // Anthropic: /v1/models существует, но авторизация — x-api-key + версия
        req = req
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.bearer_auth(api_key.trim());
    }
    let resp = req
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("failed to connect: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!(
            "ключ не принят ({}): проверьте, что ключ выдан именно этим провайдером —              у каждого сервиса свой ключ, ключ от OpenRouter не подходит к другим",
            status.as_u16()
        ));
    }
    if !status.is_success() {
        return Err(provider_error(status, &body));
    }
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        let snippet: String = body.chars().take(150).collect();
        format!("unexpected response format: {e}; body: {snippet}")
    })?;

    let mut models: Vec<ModelInfo> = json
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|v| v.as_str())?.to_string();
                    let modalities = m
                        .get("architecture")
                        .and_then(|a| a.get("input_modalities"))
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str())
                                .map(|s| s.to_string())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let vision = modalities.iter().any(|x| x == "image");
                    let text = modalities.is_empty() || modalities.iter().any(|x| x == "text");
                    // Контекстное окно: OpenRouter кладёт его в top_provider,
                    // остальные — в верхнеуровневые поля
                    let context = m
                        .get("top_provider")
                        .and_then(|t| t.get("context_length"))
                        .and_then(|v| v.as_u64())
                        .or_else(|| m.get("context_length").and_then(|v| v.as_u64()))
                        .or_else(|| m.get("max_model_len").and_then(|v| v.as_u64()))
                        .or_else(|| {
                            m.get("max_context_length").and_then(|v| v.as_u64())
                        })
                        .filter(|c| *c >= 1024);
                    Some(ModelInfo {
                        id,
                        vision,
                        text,
                        context,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // Бесплатные (:free) — наверх списка
    models.sort_by(|a, b| {
        let fa = a.id.ends_with(":free");
        let fb = b.id.ends_with(":free");
        fb.cmp(&fa).then_with(|| a.id.cmp(&b.id))
    });

    Ok(models)
}

/// Извлекает человекочитаемую ошибку провайдера из тела ответа
/// ({"error": {"message": "..."}}) или возвращает фрагмент сырого тела.
pub fn provider_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").cloned())
        .and_then(|e| {
            e.get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .or_else(|| e.as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("HTTP {}: {}", status.as_u16(), detail)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    // Строка ИЛИ массив [{type:"text"|"image_url", ...}] для vision-моделей
    pub content: serde_json::Value,
    /// Результат инструмента: к какому вызову относится (роль "tool")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Вызовы инструментов в истории (роль "assistant", OpenAI-формат)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
}

/// Стриминговый чат: POST {base_url}/chat/completions с stream:true.
/// Куски ответа и reasoning пробрасываются на фронт событиями:
///   "chat-chunk"   { requestId, delta }
///   "chat-thought" { requestId, thought }
///   "chat-usage"   { requestId, promptTokens, completionTokens, totalTokens }
/// Прерывание: chat_abort(request_id) поднимает флаг — поток аккуратно гаснет.
#[tauri::command]
pub async fn chat_stream(
    app: tauri::AppHandle,
    registry: tauri::State<'_, AbortRegistry>,
    request_id: String,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    tools: Option<serde_json::Value>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    // Адаптер протокола выбирается по Base URL: нативный Anthropic —
    // свой формат запроса и SSE-событий, всё остальное — OpenAI-совместимое
    let base_url = normalize_base_url(&base_url);
    let anthropic = is_anthropic_base(&base_url);
    let base = base_url.trim_end_matches('/');

    let client = crate::network::apply(
        // Только connect-таймаут: общий таймаут запроса обрывал долгие стримы
        reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(30)),
    )
    .map_err(|e| format!("failed to build http client: {e}"))?
    .build()
    .map_err(|e| format!("failed to build http client: {e}"))?;

    // Регистрируем флаг отмены ДО отправки запроса: иначе chat_abort,
    // пришедший между send() и регистрацией, был бы no-op
    let flag: Arc<AtomicBool> = {
        let mut map = registry.0.lock().map_err(|e| e.to_string())?;
        let f = Arc::new(AtomicBool::new(false));
        map.insert(request_id.clone(), f.clone());
        f
    };
    // Guard чистит запись при любом выходе из функции (в т.ч. по "?" и return)
    let _abort_guard = AbortGuard {
        registry: &registry,
        request_id: request_id.clone(),
    };

    let resp = if anthropic {
        let body = build_anthropic_body(
            &model,
            &messages,
            tools.as_ref().filter(|t| !t.is_null()),
            reasoning_effort.as_deref(),
        );
        client
            .post(format!("{base}/messages"))
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("failed to connect: {e}"))?
    } else {
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "stream_options": { "include_usage": true }
        });
        // M2: здесь передаются определения инструментов агента
        if let Some(tools) = tools.filter(|t| !t.is_null()) {
            body["tools"] = tools;
        }
        // Reasoning effort (OpenAI-совместимые; "max" маппится в "high")
        if let Some(eff) = reasoning_effort.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let mapped = if eff == "max" { "high" } else { eff };
            body["reasoning_effort"] = serde_json::json!(mapped);
        }
        client
            .post(format!("{base}/chat/completions"))
            .bearer_auth(api_key.trim())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("failed to connect: {e}"))?
    };

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status, &err_body));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut acc: Box<dyn StreamFeed + Send> = if anthropic {
        Box::new(AnthropicAccumulator::default())
    } else {
        Box::new(SseAccumulator::default())
    };

    // Idle-watchdog вместо общего таймаута запроса: долгие прогоны (thinking,
    // большие ответы) легальны, а «зависший» без байт стрим режется по 120 с тишины
    const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
    // Потолок буфера неполной строки: провайдер, шлющий байты без '\n' — сломан
    const SSE_BUF_LIMIT: usize = 1024 * 1024;

    loop {
        let chunk = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
            Ok(item) => item,
            Err(_) => return Err("stream idle: no data for 120s".to_string()),
        };
        let Some(chunk) = chunk else {
            break;
        };
        // Прерывание: агент ушёл «в бесконечное размышление» — гасим поток
        if flag.load(Ordering::Relaxed) {
            return Ok(());
        }
        let bytes = chunk.map_err(|e| format!("stream interrupted: {e}"))?;
        buf.extend_from_slice(&bytes);
        if buf.len() > SSE_BUF_LIMIT {
            return Err("stream buffer overflow: no line breaks in 1MB of data".to_string());
        }

        for line in take_complete_lines(&mut buf) {
            if flag.load(Ordering::Relaxed) {
                return Ok(());
            }
            let line = line.trim();
            if !line.starts_with("data:") {
                continue;
            }
            let data = line[5..].trim();
            if data == "[DONE]" {
                return Ok(());
            }
            for event in acc.feed(data) {
                match event {
                    FeedEvent::Content { delta } => {
                        app.emit(
                            "chat-chunk",
                            serde_json::json!({ "requestId": request_id, "delta": delta }),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    FeedEvent::Thought { delta } => {
                        app.emit(
                            "chat-thought",
                            serde_json::json!({ "requestId": request_id, "thought": delta }),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    FeedEvent::Usage { prompt, completion, total } => {
                        app.emit(
                            "chat-usage",
                            serde_json::json!({
                                "requestId": request_id,
                                "promptTokens": prompt,
                                "completionTokens": completion,
                                "totalTokens": total
                            }),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    FeedEvent::ToolCallsFinished { calls } => {
                        app.emit(
                            "chat-tool-calls",
                            serde_json::json!({ "requestId": request_id, "calls": calls }),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }

    // Хвост аккумулятора (подозрительный на частичный тег) — дочитываем:
    // flush может отдать только Content/Thought
    for event in acc.flush() {
        match event {
            FeedEvent::Content { delta } => {
                app.emit(
                    "chat-chunk",
                    serde_json::json!({ "requestId": request_id, "delta": delta }),
                )
                .map_err(|e| e.to_string())?;
            }
            FeedEvent::Thought { delta } => {
                app.emit(
                    "chat-thought",
                    serde_json::json!({ "requestId": request_id, "thought": delta }),
                )
                .map_err(|e| e.to_string())?;
            }
            _ => {}
        }
    }

    Ok(())
}

/// Извлекает из буфера все строки, завершённые байтом '\n'. Каждая строка
/// конвертируется из UTF-8 ровно один раз, поэтому многобайтный символ,
/// разрезанный границей сетевых чанков, не превращается в U+FFFD. Хвост без
/// '\n' остаётся в буфере до следующего куска.
pub fn take_complete_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        out.push(String::from_utf8_lossy(&line).to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// M1: Аккумулятор SSE-потока (tool calling)
// ---------------------------------------------------------------------------

/// Вызов инструмента из стрима. arguments — «сырая» склеенная строка JSON;
/// парсится один раз после закрытия вызова, инкрементальный JSON-парсинг не нужен.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct StreamToolCall {
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

/// События, которые аккумулятор отдаёт наружу после каждой data-строки
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeedEvent {
    Content { delta: String },
    Thought { delta: String },
    Usage { prompt: u64, completion: u64, total: u64 },
    ToolCallsFinished { calls: Vec<StreamToolCall> },
}

/// Накапливает разобранные data-чанки стрима
#[derive(Debug, Default)]
pub struct SseAccumulator {
    tool_calls: Vec<StreamToolCall>,
    saw_tool_call: bool,
    finish_reason: Option<String>,
    /// Финальный usage-чанк OpenAI (`choices: []`) повторно триггерит
    /// finish_reason — ToolCallsFinished эмитится ровно один раз
    tool_calls_emitted: bool,
    /// Часть контента внутри `<think>…</think>` — рассуждения, приходящие
    /// инлайном в content (OpenAI-совместимые прокси, DeepSeek-R1 и др.).
    /// Маршрутизируются в Thought, иначе react-markdown без rehype-raw
    /// глотает HTML-блоки и текст «исчезает» до закрытия тега.
    in_think: bool,
    /// Хвост дельты, который может оказаться началом тега, разрезанного
    /// сетевым чанком (держим до следующей порции)
    tag_tail: String,
}

/// Длина хвоста buf, совпадающего с началом tag (частичный тег на границе чанка)
fn partial_tag_len(buf: &str, tag: &str) -> usize {
    let max = tag.len().saturating_sub(1).min(buf.len());
    (1..=max).rev().find(|k| buf.ends_with(&tag[..*k])).unwrap_or(0)
}

impl SseAccumulator {
    /// Пропускает content-дельту через фильтр `<think>`: текст внутри тега
    /// уходит в Thought, снаружи — в Content. Тег, разрезанный между чанками,
    /// собирается через tag_tail.
    fn route_content(&mut self, piece: String, events: &mut Vec<FeedEvent>) {
        let mut buf = std::mem::take(&mut self.tag_tail);
        buf.push_str(&piece);
        loop {
            if self.in_think {
                match buf.find("</think>") {
                    Some(pos) => {
                        let inner = buf[..pos].to_string();
                        buf.drain(..pos + "</think>".len());
                        if !inner.is_empty() {
                            events.push(FeedEvent::Thought { delta: inner });
                        }
                        self.in_think = false;
                    }
                    None => {
                        let keep = partial_tag_len(&buf, "</think>");
                        let emit = buf.len() - keep;
                        if emit > 0 {
                            events.push(FeedEvent::Thought {
                                delta: buf[..emit].to_string(),
                            });
                            buf.drain(..emit);
                        }
                        self.tag_tail = buf;
                        return;
                    }
                }
            } else {
                match buf.find("<think>") {
                    Some(pos) => {
                        let outer = buf[..pos].to_string();
                        buf.drain(..pos + "<think>".len());
                        if !outer.is_empty() {
                            events.push(FeedEvent::Content { delta: outer });
                        }
                        self.in_think = true;
                    }
                    None => {
                        let keep = partial_tag_len(&buf, "<think>");
                        let emit = buf.len() - keep;
                        if emit > 0 {
                            events.push(FeedEvent::Content {
                                delta: buf[..emit].to_string(),
                            });
                            buf.drain(..emit);
                        }
                        self.tag_tail = buf;
                        return;
                    }
                }
            }
        }
    }
}

impl SseAccumulator {
    /// Обрабатывает одну data-строку (без префикса "data:"), возвращает события
    pub fn feed(&mut self, data: &str) -> Vec<FeedEvent> {
        let mut events = Vec::new();
        let value: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return events, // мусорный чанк игнорируем
        };

        // usage обычно приходит в финальном чанке
        if let Some(usage) = value.get("usage").filter(|u| !u.is_null()) {
            let prompt = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let completion = usage
                .get("completion_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            events.push(FeedEvent::Usage {
                prompt,
                completion,
                total: prompt + completion,
            });
        }

        let choice = &value["choices"][0];

        if let Some(reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            self.finish_reason = Some(reason.to_string());
        }

        let delta = &choice["delta"];

        if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
            if !content.is_empty() {
                self.route_content(content.to_string(), &mut events);
            }
        }

        let reasoning = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !reasoning.is_empty() {
            events.push(FeedEvent::Thought { delta: reasoning.to_string() });
        }

        // Склейка tool_calls по index: аргументы — куски строки
        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            self.saw_tool_call = true;
            for call in calls {
                let index = call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                // Добиваем вектор до нужного индекса
                while self.tool_calls.len() <= index {
                    self.tool_calls.push(StreamToolCall { index: self.tool_calls.len(), ..Default::default() });
                }
                let slot = &mut self.tool_calls[index];
                if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        slot.id = id.to_string();
                    }
                }
                if let Some(name) = call["function"].get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        slot.name = name.to_string();
                    }
                }
                if let Some(args) = call["function"].get("arguments").and_then(|v| v.as_str()) {
                    slot.arguments.push_str(args);
                }
            }
        }

        // Вызов закрыт: парсим склеенные аргументы один раз
        if self.finish_reason.as_deref() == Some("tool_calls")
            && self.saw_tool_call
            && !self.tool_calls_emitted
        {
            self.tool_calls_emitted = true;
            let mut calls = self.tool_calls.clone();
            for c in &mut calls {
                if c.arguments.trim().is_empty() {
                    c.arguments = "{}".to_string();
                }
            }
            events.push(FeedEvent::ToolCallsFinished { calls });
        }

        events
    }
}

// ---------------------------------------------------------------------------
// Адаптеры протоколов: OpenAI-совместимый (SseAccumulator) и нативный Anthropic
// ---------------------------------------------------------------------------

/// Общий интерфейс стрим-парсера: data-строка SSE → события фронтовому каналу
trait StreamFeed: Send {
    fn feed(&mut self, data: &str) -> Vec<FeedEvent>;

    /// Хвост, оставшийся в буфере на границе чанков (дочитывается при
    /// следующей порции). Вызывается по завершении стрима, чтобы ничего
    /// не потерять — например, хвост, подозрительный на частичный тег.
    fn flush(&mut self) -> Vec<FeedEvent> {
        Vec::new()
    }
}

/// Детект нативного Anthropic по Base URL
pub fn is_anthropic_base(base_url: &str) -> bool {
    base_url.contains("api.anthropic.com")
}

/// Мягкая почта частых опечаток в Base URL.
/// Gemini отвечает на OpenAI-совместимом слое только по .../v1beta/openai —
/// если пользователь вписал URL без него, дописываем сами.
pub fn normalize_base_url(base_url: &str) -> String {
    let u = base_url.trim().trim_end_matches('/');
    if u.contains("generativelanguage.googleapis.com") && !u.ends_with("/openai") {
        return format!("{u}/openai");
    }
    u.to_string()
}

impl StreamFeed for SseAccumulator {
    fn feed(&mut self, data: &str) -> Vec<FeedEvent> {
        SseAccumulator::feed(self, data)
    }

    fn flush(&mut self) -> Vec<FeedEvent> {
        let tail = std::mem::take(&mut self.tag_tail);
        if tail.is_empty() {
            return Vec::new();
        }
        // Хвост на границе стрима — не тег (тег длиной 7-8 не уместился):
        // отдаём туда, куда нёс его контекст
        if self.in_think {
            vec![FeedEvent::Thought { delta: tail }]
        } else {
            vec![FeedEvent::Content { delta: tail }]
        }
    }
}

/// Тело запроса для нативного Messages API: system — отдельным полем,
/// tool-история конвертируется в content-блоки tool_use / tool_result,
/// изображения из data-URL — в блоки {"type":"image","source":{...}}.
pub fn build_anthropic_body(
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&serde_json::Value>,
    reasoning_effort: Option<&str>,
) -> serde_json::Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut msgs: Vec<serde_json::Value> = Vec::new();

    for m in messages {
        match m.role.as_str() {
            "system" => {
                if let Some(text) = m.content.as_str() {
                    system_parts.push(text.to_string());
                }
            }
            "tool" => {
                // Результат инструмента → user-сообщение с tool_result
                let tool_use_id = m.tool_call_id.clone().unwrap_or_default();
                let content = m.content.as_str().unwrap_or("").to_string();
                msgs.push(serde_json::json!({
                    "role": "user",
                    "content": [{ "type": "tool_result", "tool_use_id": tool_use_id, "content": content }]
                }));
            }
            "assistant" => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if let Some(text) = m.content.as_str() {
                    if !text.is_empty() {
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
                if let Some(calls) = m.tool_calls.as_ref().and_then(|t| t.as_array()) {
                    for c in calls {
                        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = c["function"]["name"].as_str().unwrap_or("");
                        let args_raw = c["function"]["arguments"].as_str().unwrap_or("{}");
                        let input: serde_json::Value =
                            serde_json::from_str(args_raw).unwrap_or(serde_json::json!({}));
                        blocks.push(serde_json::json!({
                            "type": "tool_use", "id": id, "name": name, "input": input
                        }));
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(serde_json::json!({ "role": "assistant", "content": blocks }));
            }
            _ => {
                // user: строка или массив с картинками — конвертируем vision-формат
                let content = if m.content.is_array() {
                    let arr = m.content.as_array().unwrap();
                    let blocks: Vec<serde_json::Value> = arr
                        .iter()
                        .filter_map(|part| {
                            let ptype = part.get("type").and_then(|v| v.as_str())?;
                            if ptype == "text" {
                                Some(serde_json::json!({
                                    "type": "text",
                                    "text": part.get("text").cloned().unwrap_or(serde_json::json!(""))
                                }))
                            } else if ptype == "image_url" {
                                let url = part["image_url"]["url"].as_str()?;
                                anthropic_image_block(url)
                            } else {
                                None
                            }
                        })
                        .collect();
                    serde_json::Value::Array(blocks)
                } else {
                    m.content.clone()
                };
                msgs.push(serde_json::json!({ "role": m.role, "content": content }));
            }
        }
    }

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "messages": msgs,
        "stream": true,
    });
    // Extended thinking: усилие маппится в бюджет размышлений; max_tokens должен покрывать бюджет
    if let Some(eff) = reasoning_effort.map(str::trim).filter(|s| !s.is_empty() && *s != "off") {
        let budget: u64 = match eff { "low" => 2048, "high" => 10000, _ => 16000 };
        body["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": budget });
        body["max_tokens"] = serde_json::json!(8192 + budget);
    }
    if !system_parts.is_empty() {
        body["system"] = serde_json::Value::String(system_parts.join("\n\n"));
    }
    if let Some(tools) = tools.and_then(|t| t.as_array()) {
        // OpenAI-схемы → Anthropic-формат
        let converted: Vec<serde_json::Value> = tools
            .iter()
            .filter_map(|t| {
                let f = &t["function"];
                Some(serde_json::json!({
                    "name": f.get("name").and_then(|v| v.as_str())?,
                    "description": f.get("description").cloned().unwrap_or(serde_json::json!("")),
                    "input_schema": f.get("parameters").cloned().unwrap_or(serde_json::json!({"type":"object"})),
                }))
            })
            .collect();
        if !converted.is_empty() {
            body["tools"] = serde_json::Value::Array(converted);
        }
    }
    body
}

/// data-URL (data:image/png;base64,…) → Anthropic-блок изображения
pub fn anthropic_image_block(data_url: &str) -> Option<serde_json::Value> {
    let rest = data_url.strip_prefix("data:")?;
    let (mime, data) = rest.split_once(";base64,")?;
    Some(serde_json::json!({
        "type": "image",
        "source": { "type": "base64", "media_type": mime, "data": data }
    }))
}

/// Парсер SSE-событий нативного Anthropic Messages API.
/// События: message_start (usage in), content_block_delta (text/thinking/
/// input_json), content_block_stop (закрытие tool_use), message_delta (usage out).
#[derive(Debug, Default)]
pub struct AnthropicAccumulator {
    tool_id: String,
    tool_name: String,
    tool_json: String,
    in_tool: bool,
    input_tokens: u64,
}

impl StreamFeed for AnthropicAccumulator {
    fn feed(&mut self, data: &str) -> Vec<FeedEvent> {
        let mut events = Vec::new();
        let value: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return events,
        };

        match value.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "message_start" => {
                self.input_tokens = value["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                events.push(FeedEvent::Usage {
                    prompt: self.input_tokens,
                    completion: 0,
                    total: self.input_tokens,
                });
            }
            "content_block_start" => {
                let block = &value["content_block"];
                if block["type"] == "tool_use" {
                    self.in_tool = true;
                    self.tool_id = block["id"].as_str().unwrap_or("").to_string();
                    self.tool_name = block["name"].as_str().unwrap_or("").to_string();
                    self.tool_json.clear();
                }
            }
            "content_block_delta" => {
                let delta = &value["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        if let Some(text) = delta["text"].as_str() {
                            if !text.is_empty() {
                                events.push(FeedEvent::Content { delta: text.to_string() });
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = delta["thinking"].as_str() {
                            if !t.is_empty() {
                                events.push(FeedEvent::Thought { delta: t.to_string() });
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let Some(j) = delta["partial_json"].as_str() {
                            self.tool_json.push_str(j);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if self.in_tool {
                    self.in_tool = false;
                    let mut arguments = std::mem::take(&mut self.tool_json);
                    if arguments.trim().is_empty() {
                        arguments = "{}".to_string();
                    }
                    events.push(FeedEvent::ToolCallsFinished {
                        calls: vec![StreamToolCall {
                            index: 0,
                            id: std::mem::take(&mut self.tool_id),
                            name: std::mem::take(&mut self.tool_name),
                            arguments,
                        }],
                    });
                }
            }
            "message_delta" => {
                let output = value["usage"]["output_tokens"].as_u64().unwrap_or(0);
                events.push(FeedEvent::Usage {
                    prompt: self.input_tokens,
                    completion: output,
                    total: self.input_tokens + output,
                });
            }
            _ => {}
        }
        events
    }
}

#[cfg(test)]
mod anthropic_tests {
    use super::*;

    fn feed_lines(acc: &mut AnthropicAccumulator, lines: &[&str]) -> Vec<FeedEvent> {
        let mut events = Vec::new();
        for l in lines {
            events.extend(acc.feed(l));
        }
        events
    }

    #[test]
    fn anthropic_text_thought_usage() {
        let mut acc = AnthropicAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"type":"message_start","message":{"usage":{"input_tokens":120}}}"#,
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"думаю"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Привет"}}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#,
            ],
        );
        assert!(events.iter().any(|e| matches!(e, FeedEvent::Thought { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, FeedEvent::Content { delta } if delta == "Привет")));
        // Финальный usage: prompt=120, completion=42
        assert!(events.iter().any(
            |e| matches!(e, FeedEvent::Usage { prompt: 120, completion: 42, total: 162 })
        ));
    }

    #[test]
    fn anthropic_tool_call_glued_from_chunks() {
        let mut acc = AnthropicAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs_write"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}"#,
                r#"{"type":"content_block_stop","index":0}"#,
            ],
        );
        let calls = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .expect("tool calls event");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(calls[0].name, "fs_write");
        assert_eq!(calls[0].arguments, r#"{"path":"a.txt"}"#);
    }

    #[test]
    fn anthropic_body_extracts_system_and_tools() {
        let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: serde_json::json!("Ты помощник"),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: serde_json::json!("результат"),
                tool_call_id: Some("toolu_9".into()),
                tool_calls: None,
            },
            ChatMessage {
                role: "assistant".into(),
                content: serde_json::json!(""),
                tool_call_id: None,
                tool_calls: Some(serde_json::json!([
                    {"id":"toolu_9","type":"function","function":{"name":"fs_read","arguments":"{\"path\":\"a\"}"}}
                ])),
            },
        ];
        let tools = serde_json::json!([
            {"type":"function","function":{"name":"fs_read","description":"read","parameters":{"type":"object"}}}
        ]);
        let body = build_anthropic_body("claude-x", &messages, Some(&tools), None);
        assert_eq!(body["system"], "Ты помощник");
        assert_eq!(body["max_tokens"], 8192);
        // tool-история сконвертирована в tool_use/tool_result
        assert_eq!(body["messages"][0]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][0]["content"][0]["tool_use_id"], "toolu_9");
        assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn build_anthropic_body_reasoning_budget() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!("привет"),
            tool_call_id: None,
            tool_calls: None,
        }];
        // "max" → бюджет 16000, max_tokens покрывает бюджет (8192 + 16000)
        let body = build_anthropic_body("claude-x", &messages, None, Some("max"));
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 16000);
        assert_eq!(body["max_tokens"], 24192);
        // "low" → бюджет 2048
        let body = build_anthropic_body("claude-x", &messages, None, Some("low"));
        assert_eq!(body["thinking"]["budget_tokens"], 2048);
        assert_eq!(body["max_tokens"], 10240);
        // "off" — thinking не включается
        let body = build_anthropic_body("claude-x", &messages, None, Some("off"));
        assert!(body.get("thinking").is_none());
        assert_eq!(body["max_tokens"], 8192);
    }
}

/// Прерывание активного стрима
#[tauri::command(async)]
pub fn chat_abort(registry: tauri::State<'_, AbortRegistry>, request_id: String) {
    if let Ok(map) = registry.0.lock() {
        if let Some(flag) = map.get(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Автообнаружение локальной Ollama: GET http://localhost:11434/v1/models.
/// Ok(None) — Ollama не отвечает, Ok(Some(ids)) — список локальных моделей.
#[tauri::command]
pub async fn detect_ollama() -> Result<Option<Vec<String>>, String> {
    let client = crate::network::apply(reqwest::Client::builder())?.build().map_err(|e| e.to_string())?;
    let resp = client
        .get("http://localhost:11434/v1/models")
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let body = r.text().await.unwrap_or_default();
            let json: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let ids = json
                .get("data")
                .and_then(|d| d.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|m| {
                            m.get("id").and_then(|v| v.as_str()).map(String::from)
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(Some(ids))
        }
        _ => Ok(None),
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn feed_lines(acc: &mut SseAccumulator, lines: &[&str]) -> Vec<FeedEvent> {
        let mut all = Vec::new();
        for l in lines {
            all.extend(acc.feed(l));
        }
        all.extend(acc.flush());
        all
    }

    fn joined(events: &[FeedEvent], f: impl Fn(&FeedEvent) -> Option<String>) -> String {
        events.iter().filter_map(f).collect()
    }

    #[test]
    fn think_block_routed_to_thought() {
        // Провайдеры-прокси шлют рассуждения инлайном в content:
        // `<think>…</think>` должен уйти в Thought, остальное — в Content
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"<think>думаю"}}]}"#,
                r#"{"choices":[{"delta":{"content":" вслух</think>Ответ готов"}}]}"#,
            ],
        );
        let thought = joined(&events, |e| match e {
            FeedEvent::Thought { delta } => Some(delta.clone()),
            _ => None,
        });
        let content = joined(&events, |e| match e {
            FeedEvent::Content { delta } => Some(delta.clone()),
            _ => None,
        });
        assert_eq!(thought, "думаю вслух");
        assert_eq!(content, "Ответ готов");
    }

    #[test]
    fn think_tag_split_across_chunks() {
        // Тег разрезан посреди сетевых чанков — не должен протечь в Content
        // ни частично, ни целиком
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"Привет <thi"}}]}"#,
                r#"{"choices":[{"delta":{"content":"nk>секрет"}}]}"#,
                r#"{"choices":[{"delta":{"content":"ы</th"}}]}"#,
                r#"{"choices":[{"delta":{"content":"ink>Хвост"}}]}"#,
            ],
        );
        let thought = joined(&events, |e| match e {
            FeedEvent::Thought { delta } => Some(delta.clone()),
            _ => None,
        });
        let content = joined(&events, |e| match e {
            FeedEvent::Content { delta } => Some(delta.clone()),
            _ => None,
        });
        assert_eq!(thought, "секреты");
        assert_eq!(content, "Привет Хвост");
        assert!(!content.contains("<"), "тег протёк в content: {content:?}");
    }

    #[test]
    fn unclosed_think_is_all_thought() {
        // Стрим оборвался без </think> — всё после тега не попадает в ответ
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"Ответ. <think>о хвос"}}]}"#,
                r#"{"choices":[{"delta":{"content":"те"}}]}"#,
            ],
        );
        let content = joined(&events, |e| match e {
            FeedEvent::Content { delta } => Some(delta.clone()),
            _ => None,
        });
        assert_eq!(content, "Ответ. ");
        let thought = joined(&events, |e| match e {
            FeedEvent::Thought { delta } => Some(delta.clone()),
            _ => None,
        });
        assert!(thought.contains("о хвосте"), "{thought:?}");
    }

    #[test]
    fn angle_bracket_without_think_passes_through() {
        // Обычный "<" в тексте (не тег think) не теряется
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[r#"{"choices":[{"delta":{"content":"a < b и 5<6"}}]}"#],
        );
        let content = joined(&events, |e| match e {
            FeedEvent::Content { delta } => Some(delta.clone()),
            _ => None,
        });
        assert_eq!(content, "a < b и 5<6");
    }

    #[test]
    fn content_and_usage_stream() {
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"Прив"}}]}"#,
                r#"{"choices":[{"delta":{"content":"ет"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}"#,
            ],
        );
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::Content { delta } => Some(delta.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Привет");
        assert!(events.iter().any(|e| matches!(
            e,
            FeedEvent::Usage { prompt: 10, completion: 3, total: 13 }
        )));
    }

    #[test]
    fn tool_call_arguments_glued_across_fragments() {
        // Классика: аргументы JSON приходят кусочками строки
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"fs_read","arguments":"{\"pa"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\": \"/tmp/x.py\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        let finished = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .expect("tool calls must finish");
        assert_eq!(finished.len(), 1);
        assert_eq!(finished[0].id, "call_abc");
        assert_eq!(finished[0].name, "fs_read");
        // Склеенная строка — валидный JSON
        let parsed: serde_json::Value = serde_json::from_str(&finished[0].arguments).expect("arguments must be valid JSON after gluing");
        assert_eq!(parsed["path"], "/tmp/x.py");
    }

    #[test]
    fn parallel_tool_calls_interleaved_by_index() {
        // Провайдеры шлют параллельные вызовы вперемешку
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"fs_write","arguments":"{\"path\":"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"fs_read","arguments":"{\"path\":\"a.txt\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"data.txt\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        let finished = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .expect("tool calls must finish");
        assert_eq!(finished.len(), 2);
        assert_eq!(finished[0].name, "fs_read"); // index 0
        let args_a: serde_json::Value = serde_json::from_str(&finished[0].arguments).unwrap();
        assert_eq!(args_a["path"], "a.txt");
        assert_eq!(finished[1].name, "fs_write"); // index 1
        let args_b: serde_json::Value = serde_json::from_str(&finished[1].arguments).unwrap();
        assert_eq!(args_b["path"], "data.txt");
    }

    #[test]
    fn empty_arguments_become_empty_object() {
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"shell_run","arguments":""}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        let finished = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .unwrap();
        assert_eq!(finished[0].arguments, "{}");
    }

    #[test]
    fn garbage_chunks_are_ignored() {
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                "not json at all",
                r#"{"choices":[{"delta":{"content":"ok"}}]}"#,
            ],
        );
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn no_tool_call_event_without_tool_calls() {
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"hi"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            ],
        );
        assert!(!events
            .iter()
            .any(|e| matches!(e, FeedEvent::ToolCallsFinished { .. })));
    }
    #[test]
    fn take_complete_lines_preserves_multibyte_across_chunks() {
        // Строка 'data: {"delta":"при"}\n'. Разрезаем её побайтово ВНУТРИ
        // многобайтного символа 'р' (2 байта) — первый кусок заканчивается
        // половиной символа, второй доводит строку до конца. Раньше каждый
        // чанк конвертировался отдельно и 'р' превращался в U+FFFD.
        let full = "data: {\"delta\":\"при\"}\n".as_bytes().to_vec();
        // 'при' начинается с байта 16; 'п' = 2 байта (16..18), 'р' = 2 байта
        // (18..20). Режем после первого байта 'р' — внутри многобайтного символа.
        let split = 19;
        let mut buf: Vec<u8> = full[..split].to_vec();
        let first = take_complete_lines(&mut buf);
        assert!(first.is_empty(), "до '\n' строк быть не должно: {first:?}");

        buf.extend_from_slice(&full[split..]);
        let second = take_complete_lines(&mut buf);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].trim(), "data: {\"delta\":\"при\"}");
        assert!(
            !second[0].contains('\u{FFFD}'),
            "не должно быть U+FFFD: {:?}",
            second[0]
        );
    }
}
