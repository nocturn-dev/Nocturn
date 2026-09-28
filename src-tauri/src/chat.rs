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
/// в конце функции больше не нужен — Drop чистит автоматически. Чистит
/// только СВОЙ флаг (Arc::ptr_eq): при переиспользовании request_id
/// безусловный remove по ключу вычищал запись НОВОГО стрима, и chat_abort
/// для нового становился no-op
struct AbortGuard<'a> {
    registry: &'a AbortRegistry,
    request_id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for AbortGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.registry.0.lock() {
            // Слот трогаем, только если там до сих пор наш флаг
            if map
                .get(&self.request_id)
                .is_some_and(|cur| Arc::ptr_eq(cur, &self.flag))
            {
                map.remove(&self.request_id);
            }
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

    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;
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
            "ключ не принят ({}): проверьте, что ключ выдан именно этим провайдером — у каждого сервиса свой ключ, ключ от OpenRouter не подходит к другим",
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

/// Разовый non-streaming вызов модели без инструментов (Рефлексия в «Обзоре»).
/// Тот же адаптер провайдера, что и в chat_stream; ответ целиком — без SSE
#[tauri::command(async)]
pub async fn chat_once(
    base_url: String,
    api_key: String,
    model: String,
    provider: Option<String>,
    system: String,
    user: String,
    max_tokens: u32,
) -> Result<String, String> {
    let base_url = normalize_base_url(&base_url);
    let anthropic = match provider.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some("anthropic") => true,
        Some(_) => false,
        None => is_anthropic_base(&base_url),
    };
    let base = base_url.trim_end_matches('/');
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;

    // Ответ нужен целиком, спешить некуда; потолок — от «задумавшейся» reasoning-модели
    let total_timeout = std::time::Duration::from_secs(180);
    let resp = if anthropic {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{ "role": "user", "content": user }]
        });
        client
            .post(format!("{base}/messages"))
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .timeout(total_timeout)
            .send()
            .await
            .map_err(|e| format!("failed to connect: {e}"))?
    } else {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        });
        client
            .post(format!("{base}/chat/completions"))
            .bearer_auth(api_key.trim())
            .json(&body)
            .timeout(total_timeout)
            .send()
            .await
            .map_err(|e| format!("failed to connect: {e}"))?
    };

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;
    if !status.is_success() {
        return Err(provider_error(status, &body));
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("unexpected response format: {e}"))?;
    let text = if anthropic {
        // content — массив блоков; собираем текстовые (thinking-блоки пропускаем)
        let blocks = json
            .get("content")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "response missing content".to_string())?;
        let mut out = String::new();
        for b in blocks {
            if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
        }
        out
    } else {
        json.pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    if text.trim().is_empty() {
        return Err("empty response".to_string());
    }
    Ok(text)
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
    /// Thinking-блок Anthropic для assistant-хода: {thinking, signature,
    /// redacted[]}. Messages API при extended thinking требует возвращать
    /// thinking-блоки хода, завершившегося tool_use, иначе — 400
    /// «Expected thinking or redacted_thinking, but found tool_use».
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<serde_json::Value>,
}

/// Стриминговый чат: POST {base_url}/chat/completions с stream:true.
/// Куски ответа и reasoning пробрасываются на фронт событиями:
///   "chat-chunk"   { requestId, delta }
///   "chat-thought" { requestId, thought }
///   "chat-usage"   { requestId, promptTokens, completionTokens, totalTokens }
/// Прерывание: chat_abort(request_id) поднимает флаг — поток аккуратно гаснет.
#[tauri::command]
// Tauri-команда со всеми параметрами стрима; свёртка в структуру сломала бы JSON-контракт фронтенда
#[allow(clippy::too_many_arguments)]
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
    // Явный провайдер с фронта ("anthropic", "openai", …): раньше адаптер
    // выбирался substring-поиском "api.anthropic.com" в Base URL, и прокси
    // вида https://gw.corp/api.anthropic.com/v1 получал нативный адаптер
    // с x-api-key вместо Bearer — загадочный 401 на валидном ключе
    provider: Option<String>,
) -> Result<(), String> {
    use futures_util::StreamExt;

    // Адаптер протокола: явный провайдер с фронта, при отсутствии — эвристика
    // по Base URL (старое поведение для совместимости)
    let base_url = normalize_base_url(&base_url);
    let anthropic = match provider.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some("anthropic") => true,
        Some(_) => false,
        None => is_anthropic_base(&base_url),
    };
    let base = base_url.trim_end_matches('/');

    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;

    // Регистрируем флаг отмены ДО отправки запроса: иначе chat_abort,
    // пришедший между send() и регистрацией, был бы no-op. Повторный
    // request_id поднимает флаг старого стрима: иначе AbortGuard старого
    // при выходе вычищал запись нового, и отмена нового становилась no-op
    let flag: Arc<AtomicBool> = {
        let mut map = registry.0.lock().map_err(|e| e.to_string())?;
        let f = Arc::new(AtomicBool::new(false));
        if let Some(old) = map.insert(request_id.clone(), f.clone()) {
            old.store(true, Ordering::Relaxed);
        }
        f
    };
    // Guard чистит запись при любом выходе из функции (в т.ч. по "?" и return)
    let _abort_guard = AbortGuard {
        registry: &registry,
        request_id: request_id.clone(),
        flag: flag.clone(),
    };

    let mut body_json: Option<serde_json::Value> = None;
    let mut resp = if anthropic {
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
        body_json = Some(body);
        // let-else вместо unwrap: holder для retry-пути, TS2367-подобная
        // хрупкость инварианта «присваивание выше» не должна паниковать
        let Some(built) = body_json.as_ref() else {
            return Err("internal: request body missing".into());
        };
        client
            .post(format!("{base}/chat/completions"))
            .bearer_auth(api_key.trim())
            .json(built)
            .send()
            .await
            .map_err(|e| format!("failed to connect: {e}"))?
    };

    // Строгие шлюзы (старые vLLM, корпоративные прокси) не знают поле
    // stream_options и отвечают 400 на любой запрос — чат был мёртв целиком.
    // Ретраим один раз без этого поля
    let retry_without_stream_options =
        !anthropic && body_json.is_some() && resp.status() == reqwest::StatusCode::BAD_REQUEST;
    if retry_without_stream_options {
        let err_body = resp.text().await.unwrap_or_default();
        if err_body.contains("stream_options") {
            if let Some(obj) = body_json.as_mut().and_then(|b| b.as_object_mut()) {
                obj.remove("stream_options");
            }
            let Some(rebuilt) = body_json.as_ref() else {
                return Err("internal: request body missing".into());
            };
            resp = client
                .post(format!("{base}/chat/completions"))
                .bearer_auth(api_key.trim())
                .json(rebuilt)
                .send()
                .await
                .map_err(|e| format!("failed to connect: {e}"))?;
        } else {
            return Err(provider_error(reqwest::StatusCode::BAD_REQUEST, &err_body));
        }
    }

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
    // большие ответы) легальны, а «зависший» без байт стрим режется по тишине.
    // 300 с: reasoning-модели (o-серия, Gemini thinking) могут молчать до
    // первого байта заметно дольше двух минут — 120 с рвал легитимный стрим
    const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
    // Потолок буфера неполной строки: провайдер, шлющий байты без '\n' — сломан
    const SSE_BUF_LIMIT: usize = 1024 * 1024;

    // Прерывание пользователем — ранний return: хвост аккумулятора
    // (накопленные tool_calls/usage) не дочитываем, результат отмены не нужен.
    // [DONE] и EOF — естественное завершение: после цикла flush отдаёт
    // накопленное usage и страховочные tool_calls во фронт
    // Батчер дельт: подряд идущие Content/Thought одного сетевого чанка
    // уезжают одним emit'ом (см. DeltaBatcher)
    let mut sink = |event| emit_feed_event(&app, &request_id, event);
    let mut batch = DeltaBatcher::new(&mut sink);
    // Учёт для оценки: провайдеры над OpenAI-слоем часто игнорируют
    // stream_options (include_usage) и молчат о токенах — тогда после
    // стрима уезжает оценка (см. хвост ниже), иначе «Обзор», тренды и
    // Hard Limit молчат на таких провайдерах вечно
    let mut saw_usage = false;
    let mut completion_chars = 0usize;
    'outer: loop {
        let chunk = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
            Ok(item) => item,
            Err(_) => {
                return Err("stream idle: no data for 300s".to_string());
            }
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
                // Естественное завершение: хвост ниже дочитает usage/tool_calls
                break 'outer;
            }
            for event in acc.feed(data) {
                match &event {
                    FeedEvent::Usage { .. } => saw_usage = true,
                    FeedEvent::Content { delta } | FeedEvent::Thought { delta } => {
                        completion_chars += delta.chars().count();
                    }
                    _ => {}
                }
                batch.push(event)?;
            }
        }
        // Конец сетевого чанка — накопленное уезжает одним emit'ом: между
        // чанками батчер пуст (иначе дельта молчала бы до следующего чанка;
        // прерывание посреди чанка теряет только его — результаты отмены не нужны)
        batch.flush()?;
    }

    // Хвост аккумулятора (usage/tool_calls/подозрительный на частичный тег):
    // сюда попадают только естественные финалы — [DONE] и EOF; прерывание
    // пользователем вышло ранним return. AnthropicAccumulator::flush может
    // отдать накопленное на своём пути
    for event in acc.flush() {
        match &event {
            FeedEvent::Usage { .. } => saw_usage = true,
            FeedEvent::Content { delta } | FeedEvent::Thought { delta } => {
                completion_chars += delta.chars().count();
            }
            _ => {}
        }
        batch.push(event)?;
    }
    batch.flush()?;
    drop(batch);

    // Провайдер не сообщил usage — уезжает оценка: промпт из размера тела
    // запроса, ответ — из накопленных символов стрима (~4 символа/токен,
    // усреднение для смешанного en/ru текста; для статистики активности
    // точность достаточная, Hard Limit тоже получает сигнал)
    if !saw_usage && completion_chars > 0 {
        let prompt_est = body_json
            .as_ref()
            .map(|b| b.to_string().chars().count() / 4)
            .unwrap_or(0);
        let completion_est = completion_chars / 4;
        if prompt_est + completion_est > 0 {
            sink(FeedEvent::Usage {
                prompt: prompt_est as u64,
                completion: completion_est as u64,
                total: (prompt_est + completion_est) as u64,
            })?;
        }
    }

    Ok(())
}

/// Единая точка доставки событий аккумулятора на фронт. Раньше у цикла стрима
/// и у хвостового flush были разные match'и: у хвоста не было руки для Usage —
/// и на всех OpenAI-совместимых стримах токены не доезжали до фронта, Hard
/// Limit и статистика затрат молчали. Исчерпывающий match: новый вариант
/// FeedEvent не соберётся, пока у него не появится канал доставки
/// Слияние подряд идущих Content/Thought дельт в один emit. Один сетевой чанк
/// несёт несколько SSE-строк — раньше каждая дельта ехала отдельным
/// IPC-событием, и токен-плотные ответы превращались в сотни мелких сообщений.
/// Порядок и границы Content↔Thought сохраняются; Usage/ToolCallsFinished/
/// ThinkingBlock — самостоятельные события: накопленное перед ними
/// сбрасывается. Эмит под типом-функцией — логика слияния юнит-тестируется
/// без AppHandle.
struct DeltaBatcher<'a, F>
where
    F: FnMut(FeedEvent) -> Result<(), String>,
{
    emit: &'a mut F,
    content: Option<String>,
    thought: Option<String>,
}

impl<'a, F> DeltaBatcher<'a, F>
where
    F: FnMut(FeedEvent) -> Result<(), String>,
{
    fn new(emit: &'a mut F) -> Self {
        Self { emit, content: None, thought: None }
    }

    fn push(&mut self, event: FeedEvent) -> Result<(), String> {
        match event {
            FeedEvent::Content { delta } => match self.content.as_mut() {
                Some(c) => {
                    c.push_str(&delta);
                    Ok(())
                }
                None => {
                    self.flush()?;
                    self.content = Some(delta);
                    Ok(())
                }
            },
            FeedEvent::Thought { delta } => match self.thought.as_mut() {
                Some(t) => {
                    t.push_str(&delta);
                    Ok(())
                }
                None => {
                    self.flush()?;
                    self.thought = Some(delta);
                    Ok(())
                }
            },
            other => {
                self.flush()?;
                (self.emit)(other)
            }
        }
    }

    fn flush(&mut self) -> Result<(), String> {
        if let Some(c) = self.content.take() {
            (self.emit)(FeedEvent::Content { delta: c })?;
        }
        if let Some(t) = self.thought.take() {
            (self.emit)(FeedEvent::Thought { delta: t })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod batcher_tests {
    use super::*;

    /// Собирает события, прошедшие через батчер, — как их увидел бы фронт
    fn merged(steps: Vec<FeedEvent>) -> Vec<FeedEvent> {
        let mut out: Vec<FeedEvent> = Vec::new();
        {
            let mut sink = |e: FeedEvent| {
                out.push(e);
                Ok(())
            };
            let mut batch = DeltaBatcher::new(&mut sink);
            for e in steps {
                batch.push(e).unwrap();
            }
            batch.flush().unwrap();
        }
        out
    }

    #[test]
    fn consecutive_deltas_merge_per_kind() {
        let out = merged(vec![
            FeedEvent::Content { delta: "При".into() },
            FeedEvent::Content { delta: "вет".into() },
            FeedEvent::Thought { delta: "ду".into() },
            FeedEvent::Thought { delta: "маю".into() },
            FeedEvent::Content { delta: "!".into() },
        ]);
        // Граница Content↔Thought не склеивается: два прогона контента
        assert_eq!(
            out,
            vec![
                FeedEvent::Content { delta: "Привет".into() },
                FeedEvent::Thought { delta: "думаю".into() },
                FeedEvent::Content { delta: "!".into() },
            ]
        );
    }

    #[test]
    fn standalone_events_flush_pending_in_order() {
        let out = merged(vec![
            FeedEvent::Content { delta: "a".into() },
            FeedEvent::Usage { prompt: 1, completion: 2, total: 3 },
            FeedEvent::Content { delta: "b".into() },
            FeedEvent::ToolCallsFinished { calls: vec![] },
        ]);
        // Usage/ToolCalls между дельтами не переместились — порядок как на входе
        assert_eq!(out.len(), 4);
        assert!(matches!(out[0], FeedEvent::Content { ref delta } if delta == "a"));
        assert!(matches!(out[1], FeedEvent::Usage { prompt: 1, completion: 2, total: 3 }));
        assert!(matches!(out[2], FeedEvent::Content { ref delta } if delta == "b"));
        assert!(matches!(out[3], FeedEvent::ToolCallsFinished { .. }));
    }
}

fn emit_feed_event(
    app: &tauri::AppHandle,
    request_id: &str,
    event: FeedEvent,
) -> Result<(), String> {
    use tauri::Emitter;
    // emit_to("main"), а не широковещательный emit: приватные дельты чата
    // не должны рассылаться в quickentry-вебвью (тот же бандл, но там свой
    // компонент без слушателей чата)
    match event {
        FeedEvent::Content { delta } => app
            .emit_to(
                "main",
                "chat-chunk",
                serde_json::json!({ "requestId": request_id, "delta": delta }),
            )
            .map_err(|e| e.to_string()),
        FeedEvent::Thought { delta } => app
            .emit_to(
                "main",
                "chat-thought",
                serde_json::json!({ "requestId": request_id, "thought": delta }),
            )
            .map_err(|e| e.to_string()),
        FeedEvent::Usage { prompt, completion, total } => app
            .emit_to(
                "main",
                "chat-usage",
                serde_json::json!({
                    "requestId": request_id,
                    "promptTokens": prompt,
                    "completionTokens": completion,
                    "totalTokens": total
                }),
            )
            .map_err(|e| e.to_string()),
        FeedEvent::ToolCallsFinished { calls } => app
            .emit_to(
                "main",
                "chat-tool-calls",
                serde_json::json!({ "requestId": request_id, "calls": calls }),
            )
            .map_err(|e| e.to_string()),
        FeedEvent::ThinkingBlock { thinking, signature, redacted } => app
            .emit_to(
                "main",
                "chat-thinking",
                serde_json::json!({
                    "requestId": request_id,
                    "thinking": thinking,
                    "signature": signature,
                    "redacted": redacted
                }),
            )
            .map_err(|e| e.to_string()),
    }
}

/// Извлекает из буфера все строки, завершённые байтом '\n'. Каждая строка
/// конвертируется из UTF-8 ровно один раз, поэтому многобайтный символ,
/// разрезанный границей сетевых чанков, не превращается в U+FFFD. Хвост без
/// '\n' остаётся в буфере до следующего куска.
///
/// Один проход с индексом старта и ОДИН drain в конце: раньше drain(..=pos)
/// в цикле сдвигал остаток буфера на каждой строке — O(N·L) memcpy на чанк
/// просаживал приём на скоростных моделях и локальных LLM.
pub fn take_complete_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(pos) = buf[start..].iter().position(|&b| b == b'\n') {
        let end = start + pos;
        out.push(String::from_utf8_lossy(&buf[start..=end]).to_string());
        start = end + 1;
    }
    buf.drain(..start);
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
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeedEvent {
    Content { delta: String },
    Thought { delta: String },
    Usage { prompt: u64, completion: u64, total: u64 },
    ToolCallsFinished { calls: Vec<StreamToolCall> },
    /// Закрытый thinking-блок Anthropic: текст + подпись (нужна для возврата
    /// блока в историю) + redacted-блоки. Эмитится один раз на сообщение.
    ThinkingBlock {
        thinking: String,
        signature: String,
        redacted: Vec<String>,
    },
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
    /// Последний увиденный usage. Эмитится один раз в flush: провайдеры,
    /// кладущие usage в КАЖДЫЙ чанк (Gemini на OpenAI-слое, прокси),
    /// раньше накручивали prompt-токены кратно числу чанков — фронт
    /// суммирует каждое событие (контракт как у Anthropic: финал стрима)
    pending_usage: Option<(u64, u64, u64)>,
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

/// Потолок tool-вызовов на один ответ: больше легитимные провайдеры не шлют.
/// FIX: индекс приходит от провайдера, и цикл добивания вектора ниже при
/// кривом index (например 2^40) занимал всю память — мусорные индексы пропускаем.
const MAX_TOOL_CALLS: usize = 128;

impl SseAccumulator {
    /// Обрабатывает одну data-строку (без префикса "data:"), возвращает события
    pub fn feed(&mut self, data: &str) -> Vec<FeedEvent> {
        let mut events = Vec::new();
        let value: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return events, // мусорный чанк игнорируем
        };

        // usage: запоминаем последнее увиденное значение, эмитим один раз
        // в flush (см. pending_usage — провайдеры шлют usage в каждом чанке)
        if let Some(usage) = value.get("usage").filter(|u| !u.is_null()) {
            let prompt = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let completion = usage
                .get("completion_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            self.pending_usage = Some((prompt, completion, prompt + completion));
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
                // FIX [OOM]: index ничем не ограничен со стороны провайдера —
                // добивание вектора до гигантского индекса = исчерпание памяти
                if index >= MAX_TOOL_CALLS {
                    continue;
                }
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
            // Пустые слоты (провайдер начал нумерацию не с 0) раньше уезжали
            // в агентный цикл как вызов с пустым именем → мусорный шаг
            // «unknown tool:»; не выдаём их вовсе
            calls.retain(|c| !c.name.is_empty());
            if !calls.is_empty() {
                events.push(FeedEvent::ToolCallsFinished { calls });
            }
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
        let mut events = Vec::new();
        // Usage — один раз на стрим (последнее увиденное значение)
        if let Some((prompt, completion, total)) = self.pending_usage.take() {
            events.push(FeedEvent::Usage { prompt, completion, total });
        }
        // Страховка OpenAI-пути (у Anthropic она в его flush): соединение
        // оборвалось после вызовов, но до finish_reason — tool_calls не
        // теряем молча, агентный цикл получает их как обычно
        if self.saw_tool_call && !self.tool_calls_emitted && !self.tool_calls.is_empty() {
            self.tool_calls_emitted = true;
            let mut calls = self.tool_calls.clone();
            for c in &mut calls {
                if c.arguments.trim().is_empty() {
                    c.arguments = "{}".to_string();
                }
            }
            // Пустые слоты (провайдер начал нумерацию не с 0) раньше уезжали
            // в агентный цикл как вызов с пустым именем → мусорный шаг
            // «unknown tool:»; не выдаём их вовсе
            calls.retain(|c| !c.name.is_empty());
            if !calls.is_empty() {
                events.push(FeedEvent::ToolCallsFinished { calls });
            }
        }
        let tail = std::mem::take(&mut self.tag_tail);
        if !tail.is_empty() {
            // Хвост на границе стрима — не тег (тег длиной 7-8 не уместился):
            // отдаём туда, куда нёс его контекст
            events.push(if self.in_think {
                FeedEvent::Thought { delta: tail }
            } else {
                FeedEvent::Content { delta: tail }
            });
        }
        events
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
    // Результаты инструментов за один ход группируются в ОДНО user-сообщение
    // с несколькими tool_result-блоками: Messages API отвечает 400 на
    // несколько user-сообщений подряд
    let mut last_is_tool_result = false;

    for m in messages {
        match m.role.as_str() {
            "system" => {
                if let Some(text) = m.content.as_str() {
                    system_parts.push(text.to_string());
                }
                last_is_tool_result = false;
            }
            "tool" => {
                let tool_use_id = m.tool_call_id.clone().unwrap_or_default();
                let content = m.content.as_str().unwrap_or("").to_string();
                let block = serde_json::json!({
                    "type": "tool_result", "tool_use_id": tool_use_id, "content": content
                });
                if last_is_tool_result {
                    if let Some(arr) = msgs
                        .last_mut()
                        .and_then(|last| last["content"].as_array_mut())
                    {
                        arr.push(block);
                        continue;
                    }
                }
                msgs.push(serde_json::json!({ "role": "user", "content": [block] }));
                last_is_tool_result = true;
            }
            "assistant" => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                // Thinking-блоки идут ПЕРВЫМИ в assistant-контенте: Messages
                // API при extended thinking требует вернуть thinking хода,
                // завершившегося tool_use, иначе — 400
                // «Expected thinking or redacted_thinking, but found tool_use»
                if let Some(th) = m.thinking.as_ref() {
                    let text = th.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                    let sig = th.get("signature").and_then(|v| v.as_str()).unwrap_or("");
                    if !sig.is_empty() && !text.is_empty() {
                        blocks.push(serde_json::json!({
                            "type": "thinking", "thinking": text, "signature": sig
                        }));
                    }
                    if let Some(red) = th.get("redacted").and_then(|v| v.as_array()) {
                        for r in red {
                            if let Some(d) = r.as_str() {
                                blocks.push(serde_json::json!({
                                    "type": "redacted_thinking", "data": d
                                }));
                            }
                        }
                    }
                }
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
                last_is_tool_result = false;
            }
            _ => {
                // user: строка или массив с картинками — конвертируем vision-формат
                let content = if let Some(arr) = m.content.as_array() {
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
                last_is_tool_result = false;
            }
        }
    }

    const ANTHROPIC_DEFAULT_MAX_TOKENS: u64 = 8192;
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": ANTHROPIC_DEFAULT_MAX_TOKENS,
        "messages": msgs,
        "stream": true,
    });
    // Extended thinking: усилие маппится в бюджет размышлений; max_tokens должен покрывать бюджет
    if let Some(eff) = reasoning_effort.map(str::trim).filter(|s| !s.is_empty() && *s != "off") {
        let budget: u64 = match eff { "low" => 2048, "high" => 10000, _ => 16000 };
        body["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": budget });
        body["max_tokens"] = serde_json::json!(ANTHROPIC_DEFAULT_MAX_TOKENS + budget);
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
/// signature/input_json), content_block_stop (закрытие tool_use/thinking),
/// message_delta (usage out + ToolCallsFinished + ThinkingBlock).
#[derive(Debug, Default)]
pub struct AnthropicAccumulator {
    tool_id: String,
    tool_name: String,
    tool_json: String,
    in_tool: bool,
    input_tokens: u64,
    /// Все tool_use текущего ответа. Параллельные вызовы приходят отдельными
    /// блоками со своим content_block_stop, а фронт перезаписывает holder
    /// на каждое событие — поэтому эмитим ОДНО ToolCallsFinished со всеми
    /// вызовами на message_delta (контракт OpenAI-пути).
    pending_calls: Vec<StreamToolCall>,
    /// thinking-блок текущего сообщения: текст (дублирует поток Thought —
    /// тот идёт на дисплей, этот — в историю) + подпись + redacted-блоки.
    /// Messages API требует вернуть блоки хода, завершившегося tool_use
    thinking_text: String,
    thinking_signature: String,
    thinking_seen: bool,
    thinking_emitted: bool,
    redacted: Vec<String>,
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
                // Usage-событие здесь НЕ эмитим: фронт суммирует каждое
                // chat-usage в накопитель задачи, и дубль из message_start
                // удваивал prompt-токены (Hard Limit срабатывал вдвое раньше).
                // input_tokens уйдут единожды в message_delta.
                self.input_tokens = value["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
            }
            "content_block_start" => {
                let block = &value["content_block"];
                match block["type"].as_str().unwrap_or("") {
                    "tool_use" => {
                        self.in_tool = true;
                        self.tool_id = block["id"].as_str().unwrap_or("").to_string();
                        self.tool_name = block["name"].as_str().unwrap_or("").to_string();
                        self.tool_json.clear();
                    }
                    "redacted_thinking" => {
                        // Redacted-блок возвращается в историю как есть
                        // (base64-данные), иначе API отвергает ход
                        if let Some(d) = block["data"].as_str() {
                            self.redacted.push(d.to_string());
                            self.thinking_seen = true;
                        }
                    }
                    _ => {}
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
                                self.thinking_text.push_str(t);
                                self.thinking_seen = true;
                                events.push(FeedEvent::Thought { delta: t.to_string() });
                            }
                        }
                    }
                    // Подпись thinking-блока: без неё блок нельзя вернуть
                    // в историю (API отвергнет ход с tool_use)
                    "signature_delta" => {
                        if let Some(s) = delta["signature"].as_str() {
                            self.thinking_signature.push_str(s);
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
                    self.pending_calls.push(StreamToolCall {
                        index: self.pending_calls.len(),
                        id: std::mem::take(&mut self.tool_id),
                        name: std::mem::take(&mut self.tool_name),
                        arguments,
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
                self.emit_thinking_block(&mut events);
                if !self.pending_calls.is_empty() {
                    events.push(FeedEvent::ToolCallsFinished {
                        calls: std::mem::take(&mut self.pending_calls),
                    });
                }
            }
            _ => {}
        }
        events
    }

    /// Страховка: протокол гарантирует message_delta перед концом стрима,
    /// но если соединение оборвалось раньше — не теряем накопленные вызовы
    fn flush(&mut self) -> Vec<FeedEvent> {
        let mut events = Vec::new();
        self.emit_thinking_block(&mut events);
        if !self.pending_calls.is_empty() {
            events.push(FeedEvent::ToolCallsFinished {
                calls: std::mem::take(&mut self.pending_calls),
            });
        }
        events
    }
}

impl AnthropicAccumulator {
    /// Один ThinkingBlock на сообщение: текст + подпись + redacted
    fn emit_thinking_block(&mut self, events: &mut Vec<FeedEvent>) {
        if self.thinking_emitted || !self.thinking_seen {
            return;
        }
        self.thinking_emitted = true;
        events.push(FeedEvent::ThinkingBlock {
            thinking: std::mem::take(&mut self.thinking_text),
            signature: std::mem::take(&mut self.thinking_signature),
            redacted: std::mem::take(&mut self.redacted),
        });
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
                // Вызовы эмитятся на message_delta, одним событием со всеми calls
                r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":57}}"#,
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
    fn anthropic_parallel_tool_calls_survive() {
        // Регресс: параллельные tool_use раньше затирали друг друга —
        // фронт получал только последний вызов
        let mut acc = AnthropicAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs_read"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a\"}"}}"#,
                r#"{"type":"content_block_stop","index":0}"#,
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"fs_list"}}"#,
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"b\"}"}}"#,
                r#"{"type":"content_block_stop","index":1}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}"#,
            ],
        );
        let call_events: Vec<&Vec<StreamToolCall>> = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls),
                _ => None,
            })
            .collect();
        // Ровно одно событие с обоими вызовами — никакой перезаписи
        assert_eq!(call_events.len(), 1);
        assert_eq!(call_events[0].len(), 2);
        assert_eq!(call_events[0][0].id, "toolu_1");
        assert_eq!(call_events[0][0].name, "fs_read");
        assert_eq!(call_events[0][1].id, "toolu_2");
        assert_eq!(call_events[0][1].name, "fs_list");
    }

    #[test]
    fn anthropic_thinking_block_captured_for_history() {
        // Регресс [A2]: thinking-блок с подписью должен доезжать до истории —
        // без него Messages API отвечает 400 на ход с tool_use при
        // extended thinking
        let mut acc = AnthropicAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"шаг 1: выбрать файл"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}"#,
                r#"{"type":"content_block_stop","index":0}"#,
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"fs_read"}}"#,
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a\"}"}}"#,
                r#"{"type":"content_block_stop","index":1}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}"#,
            ],
        );
        let block = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ThinkingBlock { thinking, signature, redacted } => {
                    Some((thinking.clone(), signature.clone(), redacted.clone()))
                }
                _ => None,
            })
            .next()
            .expect("thinking block event");
        assert_eq!(block.0, "шаг 1: выбрать файл");
        assert_eq!(block.1, "sig-abc");
        assert!(block.2.is_empty());
        // Блок эмитится ровно один раз
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, FeedEvent::ThinkingBlock { .. }))
                .count(),
            1
        );

        // Блок возвращается в тело запроса ПЕРВЫМ в assistant-контенте
        let body = build_anthropic_body(
            "claude-x",
            &[
                ChatMessage {
                    role: "user".into(),
                    content: serde_json::json!("hi"),
                    tool_call_id: None,
                    tool_calls: None,
                    thinking: None,
                },
                ChatMessage {
                    role: "assistant".into(),
                    content: serde_json::json!(""),
                    tool_call_id: None,
                    tool_calls: Some(serde_json::json!([
                        {"id":"toolu_9","type":"function","function":{"name":"fs_read","arguments":"{\"path\":\"a\"}"}}
                    ])),
                    thinking: Some(serde_json::json!({
                        "thinking": "шаг 1: выбрать файл",
                        "signature": "sig-abc",
                        "redacted": []
                    })),
                },
                ChatMessage {
                    role: "tool".into(),
                    content: serde_json::json!("file content"),
                    tool_call_id: Some("toolu_9".into()),
                    tool_calls: None,
                    thinking: None,
                },
            ],
            None,
            None,
        );
        let blocks = body["messages"][1]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[0]["signature"], "sig-abc");
        assert_eq!(blocks[1]["type"], "tool_use");
    }

    #[test]
    fn anthropic_redacted_thinking_passes_through() {
        let mut acc = AnthropicAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"enc-data-1"}}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
            ],
        );
        let block = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ThinkingBlock { redacted, .. } => Some(redacted.clone()),
                _ => None,
            })
            .next()
            .expect("redacted block event");
        assert_eq!(block, vec!["enc-data-1"]);
    }

    #[test]
    fn anthropic_usage_emitted_once() {
        // Регресс: message_start + message_delta удваивали prompt-токены
        let mut acc = AnthropicAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"type":"message_start","message":{"usage":{"input_tokens":120}}}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#,
            ],
        );
        let usage: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::Usage { prompt, completion, total } => Some((*prompt, *completion, *total)),
                _ => None,
            })
            .collect();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0], (120, 42, 162));
    }

    #[test]
    fn anthropic_flush_preserves_calls_on_truncated_stream() {
        // Стрим оборвался до message_delta — flush не теряет накопленные вызовы
        let mut acc = AnthropicAccumulator::default();
        let _ = feed_lines(
            &mut acc,
            &[
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs_read"}}"#,
                r#"{"type":"content_block_stop","index":0}"#,
            ],
        );
        let flushed = acc.flush();
        assert_eq!(flushed.len(), 1);
        match &flushed[0] {
            FeedEvent::ToolCallsFinished { calls } => {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "fs_read");
            }
            _ => panic!("expected ToolCallsFinished from flush"),
        }
    }

    #[test]
    fn anthropic_body_groups_consecutive_tool_results() {
        // Регресс: каждый tool-результат становился отдельным user-сообщением —
        // Messages API отвечает 400 на несколько user подряд
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: serde_json::json!("сделай"),
                tool_call_id: None,
                tool_calls: None,
                thinking: None,
            },
            ChatMessage {
                role: "assistant".into(),
                content: serde_json::json!(""),
                tool_call_id: None,
                tool_calls: Some(serde_json::json!([
                    {"id":"toolu_1","type":"function","function":{"name":"fs_read","arguments":"{\"path\":\"a\"}"}},
                    {"id":"toolu_2","type":"function","function":{"name":"fs_read","arguments":"{\"path\":\"b\"}"}}
                ])),
                thinking: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: serde_json::json!("результат 1"),
                tool_call_id: Some("toolu_1".into()),
                tool_calls: None,
                thinking: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: serde_json::json!("результат 2"),
                tool_call_id: Some("toolu_2".into()),
                tool_calls: None,
                thinking: None,
            },
        ];
        let body = build_anthropic_body("claude-x", &messages, None, None);
        let msgs = body["messages"].as_array().unwrap();
        // user → assistant(tool_use) → один user с двумя tool_result
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[2]["role"], "user");
        let blocks = msgs[2]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["tool_use_id"], "toolu_1");
        assert_eq!(blocks[1]["tool_use_id"], "toolu_2");
    }

    #[test]
    fn anthropic_body_extracts_system_and_tools() {
        let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: serde_json::json!("Ты помощник"),
                tool_call_id: None,
                tool_calls: None,
                thinking: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: serde_json::json!("результат"),
                tool_call_id: Some("toolu_9".into()),
                tool_calls: None,
                thinking: None,
            },
            ChatMessage {
                role: "assistant".into(),
                content: serde_json::json!(""),
                tool_call_id: None,
                tool_calls: Some(serde_json::json!([
                    {"id":"toolu_9","type":"function","function":{"name":"fs_read","arguments":"{\"path\":\"a\"}"}}
                ])),
                thinking: None,
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
            thinking: None,
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
    // Poisoned-лок (паника под ним) раньше глотался молча — Stop переставал
    // работать до перезапуска; into_inner достаёт данные и из отравленного
    let map = match registry.0.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if let Some(flag) = map.get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Автообнаружение локальной Ollama: GET http://localhost:11434/v1/models.
/// Ok(None) — Ollama не отвечает, Ok(Some(ids)) — список локальных моделей.
#[tauri::command]
pub async fn detect_ollama() -> Result<Option<Vec<String>>, String> {
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;
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

    /// Регресс: при переиспользовании request_id guard старого стрима
    /// обязан вычищать только свой флаг, иначе chat_abort нового стрима
    /// становился no-op (реестр терял запись нового)
    #[test]
    fn abort_guard_removes_only_own_flag() {
        let registry = AbortRegistry(Mutex::new(HashMap::new()));
        let old = Arc::new(AtomicBool::new(false));
        registry.0.lock().unwrap().insert("r".into(), old.clone());
        let new = Arc::new(AtomicBool::new(false));
        // Стрим B стартовал на том же request_id: слот перезаписан флагом B,
        // флаг A поднят (эмуляция insert из chat_stream)
        old.store(true, Ordering::Relaxed);
        registry
            .0
            .lock()
            .unwrap()
            .insert("r".into(), new.clone());
        {
            // Guard старого стрима A умирает первым — слот B не трогаем
            let guard_a = AbortGuard {
                registry: &registry,
                request_id: "r".into(),
                flag: old.clone(),
            };
            drop(guard_a);
        }
        assert!(
            registry.0.lock().unwrap().contains_key("r"),
            "guard A не должен вычищать флаг B из реестра"
        );
        {
            let guard_b = AbortGuard {
                registry: &registry,
                request_id: "r".into(),
                flag: new.clone(),
            };
            drop(guard_b);
        }
        assert!(
            !registry.0.lock().unwrap().contains_key("r"),
            "guard B чистит собственный слот"
        );
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
    fn usage_per_chunk_is_counted_once() {
        // Регресс [A6]: Gemini на OpenAI-слое и прокси кладут usage (нарастающий
        // или полный) в КАЖДЫЙ чанк — фронт суммирует каждое событие, prompt-
        // токены умножались на число чанков, Hard Limit срабатывал в разы раньше
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"a"}}],"usage":{"prompt_tokens":100,"completion_tokens":1}}"#,
                r#"{"choices":[{"delta":{"content":"b"}}],"usage":{"prompt_tokens":100,"completion_tokens":2}}"#,
                r#"{"choices":[{"delta":{"content":"c"}}],"usage":{"prompt_tokens":100,"completion_tokens":3}}"#,
            ],
        );
        let usage: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::Usage { prompt, completion, total } => Some((*prompt, *completion, *total)),
                _ => None,
            })
            .collect();
        // Ровно одно событие с финальным значением, а не три с суммой 300
        assert_eq!(usage, vec![(100, 3, 103)]);
    }

    #[test]
    fn disconnect_keeps_accumulated_tool_calls() {
        // Регресс [A7]: соединение оборвалось после вызовов, но до
        // finish_reason — накопленные tool_calls не теряются молча
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"fs_read","arguments":"{\"path\":\"a\"}"}}]}}]}"#,
                // обрыв: ни finish_reason, ни [DONE]
            ],
        );
        let finished = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .expect("flush must emit accumulated tool calls");
        assert_eq!(finished.len(), 1);
        assert_eq!(finished[0].name, "fs_read");
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
