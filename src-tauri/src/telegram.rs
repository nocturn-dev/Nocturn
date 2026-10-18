//! Telegram-бот уведомлений (фаза 1): исходящие уведомления о жизни задачи
//! в личный чат пользователя через СВОЕГО бота (токен от @BotFather).
//!
//! Приватность (главный принцип модуля):
//! - мёртв до явного включения тумблером (ни одного запроса к api.telegram.org
//!   до `enabled: true` — зеркалит opt-in проверку обновлений);
//! - наружу уходит ТОЛЬКО то, что пользователь включил тумблерами событий, и
//!   ТОЛЬКО в привязанный chat_id (первый /start боту — см. polling);
//! - сообщения от других чатов игнорируются молча, ничего не отвечают;
//! - токен на диске — enc:v1:… (шифруется как Brave-ключ), в экспорте —
//!   пустая строка (mask_secrets).
//!
//! Управление чатом из TG (входящие команды) — фаза 2; здесь только
//! привязка + исходящий канал.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

/// Кнопка inline-клавиатуры под уведомлением (фаза 3): «Разрешить/Всегда/
/// Отклонить» для подтверждений, опции ask_user. data — непрозрачная строка
/// для фронта ("confirm:once", "ask:<msgId>:<index>")
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TgButton {
    pub label: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TelegramConfig {
    pub enabled: bool,
    /// Токен бота от @BotFather. В статике — как ввёл пользователь; на диске
    /// — enc:v1:… (шифрование в telegram_set_config, по образцу Brave-ключа)
    pub bot_token: String,
    /// chat_id владельца: привязывается первым /start боту (пусто — не привязан)
    pub chat_id: String,
    pub notify_start: bool,
    pub notify_finish: bool,
    pub notify_error: bool,
    pub notify_confirm: bool,
    /// персистентный offset getUpdates — переживает
    /// сохранение из UI (иначе после рестарта команды исполнялись повторно)
    #[serde(default)]
    pub offset: Option<u64>,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bot_token: String::new(),
            chat_id: String::new(),
            notify_start: true,
            notify_finish: true,
            notify_error: true,
            notify_confirm: true,
                    offset: None,
        }
    }
}

static CONFIG: Mutex<Option<TelegramConfig>> = Mutex::new(None);

/// Снимок конфига; до первого set_config — дефолт (модуль мёртв)
pub fn config() -> TelegramConfig {
    CONFIG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_default()
}

fn set_static(cfg: TelegramConfig) {
    *CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(cfg);
}

fn update_static<F: FnOnce(&mut TelegramConfig)>(f: F) -> TelegramConfig {
    let mut lock = CONFIG.lock().unwrap_or_else(|p| p.into_inner());
    let mut cfg = lock.clone().unwrap_or_default();
    f(&mut cfg);
    *lock = Some(cfg.clone());
    cfg
}

/// Сеттер статики для загрузки дискового конфига в setup (lib.rs) —
/// без рестарта polling (при старте apply_runtime зовётся отдельно)
pub fn set_config(cfg: TelegramConfig) {
    set_static(cfg);
}

struct BindCode {
    code: String,
    expires_at: std::time::Instant,
}

static BIND_CODE: Mutex<Option<BindCode>> = Mutex::new(None);

fn current_bind_code() -> (Option<String>, Option<u64>) {
    let mut lock = BIND_CODE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(bc) = lock.as_ref() {
        let now = std::time::Instant::now();
        if now < bc.expires_at {
            let left = bc.expires_at.duration_since(now).as_secs();
            return (Some(bc.code.clone()), Some(left));
        }
    }
    *lock = None;
    (None, None)
}

fn extract_bind_code(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }
    let candidate = if parts[0].eq_ignore_ascii_case("/start") {
        if parts.len() >= 2 {
            parts[1]
        } else {
            return None;
        }
    } else {
        parts[0]
    };
    let clean = candidate.trim();
    if clean.len() == 6 && clean.chars().all(|c| c.is_ascii_digit()) {
        Some(clean.to_string())
    } else {
        None
    }
}

pub fn mask_bot_token(token: &str) -> String {
    let token = token.trim();
    if token.is_empty() {
        return String::new();
    }
    if let Some((id, secret)) = token.split_once(':') {
        if secret.len() >= 6 {
            format!("{id}:{}***{}", &secret[..2], &secret[secret.len().saturating_sub(3)..])
        } else {
            format!("{id}:***")
        }
    } else if token.len() >= 8 {
        format!("{}***{}", &token[..3], &token[token.len().saturating_sub(3)..])
    } else {
        "***".to_string()
    }
}

pub fn is_masked_token(token: &str) -> bool {
    token.contains("***")
}

pub fn sanitize_outgoing_text(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    const SECRET_PREFIXES: &[&str] = &[
        "sk-", "sk-ant-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_",
        "AKIA", "ASIA", "xoxb-", "xoxp-", "xoxe-", "xoxr-", "xoxa-",
        "glpat-", "glsoat-", "AIza", "ya29.", "eyJ",
    ];

    let mut words: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        if (word.starts_with("http://") || word.starts_with("https://")) && word.contains('?') {
            let mut masked_url = word.to_string();
            const QUERY_KEYS: &[&str] = &[
                "key=", "token=", "api_key=", "apikey=", "secret=", "password=", "passwd=", "auth=",
            ];
            for q in QUERY_KEYS {
                if let Some(pos) = masked_url.find(q) {
                    let val_start = pos + q.len();
                    let val_end = masked_url[val_start..]
                        .find('&')
                        .map(|p| val_start + p)
                        .unwrap_or(masked_url.len());
                    masked_url.replace_range(val_start..val_end, "[REDACTED_SECRET]");
                }
            }
            words.push(masked_url);
            continue;
        }

        if SECRET_PREFIXES.iter().any(|p| word.contains(p)) {
            words.push("[REDACTED_SECRET]".to_string());
            continue;
        }

        if let Some((id, secret)) = word.split_once(':') {
            if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) && secret.len() >= 20 {
                words.push("[REDACTED_SECRET]".to_string());
                continue;
            }
        }

        let is_sensitive_path = {
            let lower = word.to_lowercase();
            (word.len() >= 3 && word.chars().nth(1) == Some(':') && (word.chars().nth(2) == Some('\\') || word.chars().nth(2) == Some('/')))
                || word.starts_with("/home/")
                || word.starts_with("/Users/")
                || word.starts_with("~/.ssh")
                || word.starts_with("~/.aws")
                || word.starts_with("~/.config")
                || lower.contains("appdata")
                || lower.contains(".ssh")
                || lower.contains(".aws")
                || lower.contains("settings.json")
                || lower.contains("crypto.json")
                || lower.contains("telegram.json")
                || lower.contains("hooks.json")
                || lower.contains("mcp.json")
                || lower.contains(".env")
        };
        if is_sensitive_path {
            words.push("[REDACTED_PATH]".to_string());
            continue;
        }

        let clean = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        if clean.len() >= 32
            && clean.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '=')
            && clean.chars().any(|c| c.is_ascii_digit())
            && clean.chars().any(|c| c.is_ascii_alphabetic())
        {
            words.push("[REDACTED_SECRET]".to_string());
            continue;
        }

        words.push(word.to_string());
    }

    words.join(" ")
}

/// Живой long-polling таск: abort при каждом set_config/unbind (ремап по
/// образцу portal-сессии — старый цикл не должен переживать новый).
/// Хранится ПОЛНЫЙ JoinHandle: результат spawn терять нельзя — без него
/// stop_polling вечно no-op и тумблер «выкл» не гасит цикл (раньше getUpdates
/// уходили при выключенном Telegram)
static POLL_TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);
/// Живость поллера для telegram_status: tauri-JoinHandle не отдаёт
/// is_finished, поэтому флаг ведём сами (spawn/выход/abort)
static POLLING: AtomicBool = AtomicBool::new(false);
/// Персистентный offset getUpdates: старт с 0 ределиверил необработанную
/// пачку после abort/крэша (повторное исполнение команд владельца
/// и повторный confirm-callback на фронте). В процессе живёт статика,
/// между рестартами — поле "offset" в telegram.json (пишется после каждой
/// обработанной пачки; set_config его теряет — допустимо: replay только
/// пачки, жившей на момент сохранения конфига)
static OFFSET: AtomicU64 = AtomicU64::new(0);
static OFFSET_LOADED: AtomicBool = AtomicBool::new(false);

fn stop_polling() {
    if let Some(h) = POLL_TASK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        h.abort();
    }
    POLLING.store(false, Ordering::Relaxed);
}

/// Запустить/остановить polling по текущему статик-конфигу. Вызывается из
/// set_config и из setup (загрузка telegram.json на старте).
pub fn apply_runtime(app: tauri::AppHandle) {
    stop_polling();
    let cfg = config();
    if !cfg.enabled || cfg.bot_token.is_empty() {
        return;
    }
    POLLING.store(true, Ordering::Relaxed);
    let handle = tauri::async_runtime::spawn(polling_loop(app));
    *POLL_TASK
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(handle);
}

/// Токен из статики в рабочем виде: на диске и в статике он может лежать
/// enc:v1:… (старт при запертом vault). None = расшифровать нечем —
/// вызывающий честно гасит/пропускает работу (поллер уходил с
/// зашифрованным токеном в URL и молча ловил 401 после каждого рестарта)
fn plain_token(token: &str) -> Option<String> {
    if crate::crypto::is_encrypted(token) {
        crate::crypto::decrypt(token).map(|p| p.to_string())
    } else {
        Some(token.to_string())
    }
}

/// Категория сетевой ошибки БЕЗ URL: reqwest прикладывает полный URL к
/// Display/Debug ошибок, а URL getUpdates/sendMessage содержит токен бота
/// (секрет в консоли при любом сетевом сбое)
fn net_err(e: &reqwest::Error) -> String {
    if let Some(s) = e.status() {
        format!("http {}", s.as_u16())
    } else if e.is_timeout() {
        "timeout".into()
    } else if e.is_connect() {
        "connect failed".into()
    } else {
        "network error".into()
    }
}

/// Пауза между попытками getUpdates после неудач: 5 → 10 → 20 → 30 (кап).
/// Недоступный Telegram (блокировка/прокси) не должен заспамить консоль —
/// раньше фиксированные 5 с давали строку ошибки каждые 5 секунд
fn poll_backoff_secs(failures: u32) -> u64 {
    match failures {
        1 => 5,
        2 => 10,
        3 => 20,
        _ => 30,
    }
}

/// Токен бота: "<bot_id>:<secret>" — обе части из безопасного алфавита.
/// Ручная проверка без regex-крейта: формат стабильный, ошибки ловит
/// ещё и getMe при включении
pub fn valid_token(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    let id_ok = (6..=12).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
    let secret_ok = (30..=64).contains(&secret.len())
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    id_ok && secret_ok
}

/// Кому отправлять: включённость + привязка + тумблер события. Чистая
/// функция — тесты; Rust перепроверяет ALWAYS (фронтовый кэш — только
/// оптимизация, истина здесь). ask_user и подтверждение инструмента
/// делят один тумблер notify_confirm (обе категории — «ждёт решения»)
pub fn should_notify(cfg: &TelegramConfig, kind: &str) -> bool {
    if !cfg.enabled || cfg.chat_id.is_empty() || cfg.bot_token.is_empty() {
        return false;
    }
    match kind {
        "start" => cfg.notify_start,
        "finish" => cfg.notify_finish,
        "error" => cfg.notify_error,
        "confirm" | "ask" => cfg.notify_confirm,
        _ => false,
    }
}

async fn send_message(
    token: &str,
    chat_id: &str,
    text: &str,
    buttons: &[TgButton],
) -> Result<(), String> {
    let client = crate::network::shared_client(Duration::from_secs(15))?;
    // Total-таймаут обязателен (connect_timeout не спасает от

    // stalled-соединения); Telegram сам отвечает быстро на sendMessage
    let clean_text = sanitize_outgoing_text(text);
    let text: String = clean_text.chars().take(4096).collect();
    let mut body = serde_json::json!({
        "chat_id": chat_id,
        "text": text,
        // plain text: без parse_mode юзерские задачи/ошибки со скобками
        // и подчёркиваниями не ломают отправку
        "disable_web_page_preview": true,
    });
    if !buttons.is_empty() {
        // Inline-клавиатура: callback_data вернётся в callback_query и
        // уйдёт на фронт как решение
        body["reply_markup"] = serde_json::json!({
            // Telegram ограничивает callback_data
            // 64 БАЙТАМИ — более длинное значение молча убивало ВСЮ
            // клавиатуру, и уведомление уходило без кнопок
            "inline_keyboard": [buttons
                .iter()
                .map(|b| {
                    let mut data = b.data.as_str();
                    while data.len() > 64 {
                        data = &data[..data.len() - 1];
                    }
                    serde_json::json!({"text": b.label, "callback_data": data})
                })
                .collect::<Vec<_>>()],
        });
    }
    let fut = client
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&body)
        .send();
    let resp = tokio::time::timeout(Duration::from_secs(20), fut)
        .await
        .map_err(|_| "telegram request timed out after 20s".to_string())?
        .map_err(|e| format!("telegram request failed: {}", net_err(&e)))?;
    let status = resp.status();
    // Чтение тела — тоже под таймаутом: stalled-соединение после заголовков
    // иначе вешает вызывающего (notify — навсегда, таск висит в фоне)
    let body = tokio::time::timeout(Duration::from_secs(10), resp.text())
        .await
        .map_err(|_| "telegram response read timed out".to_string())?
        .unwrap_or_default();
    if !status.is_success() {
        // Телеграм-ошибки не несут токен; тело обрезаем до причины
        let snippet: String = body.chars().take(200).collect();
        return Err(format!("telegram HTTP {}: {}", status.as_u16(), snippet));
    }
    Ok(())
}

/// getMe при включении: токен проверяется ЖИВЫМ Telegram'ом — опечатка
/// ловится на тумблере, а не молчанием уведомлений
async fn check_token(token: &str) -> Result<(), String> {
    let client = crate::network::shared_client(Duration::from_secs(15))?;
    let fut = client.get(format!("https://api.telegram.org/bot{token}/getMe")).send();
    let resp = tokio::time::timeout(Duration::from_secs(20), fut)
        .await
        .map_err(|_| "telegram request timed out after 20s".to_string())?
        .map_err(|e| format!("telegram request failed: {}", net_err(&e)))?;
    if !resp.status().is_success() {
        return Err(format!(
            "token rejected by Telegram (HTTP {})",
            resp.status().as_u16()
        ));
    }
    // Чтение тела — под таймаутом (см. send_message): stalled-соединение
    // иначе вешает UI-команду подключения на неограниченный срок
    let v: serde_json::Value = tokio::time::timeout(Duration::from_secs(10), resp.json())
        .await
        .map_err(|_| "telegram response read timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return Err("token rejected by Telegram (ok=false)".into());
    }
    Ok(())
}

/// Долгий poll: держит привязку (первый /start) и живёт, пока включено.
/// Перезапускается целиком при каждом изменении конфига (см. apply_runtime).
/// Каждая итерация перепроверяет конфиг — выключение гасит цикл максимум
/// через один poll даже если abort по какой-то причине не дошёл
async fn polling_loop(app: tauri::AppHandle) {
    let mut fails: u32 = 0;
    // Дисковый offset читаем один раз за жизнь процесса (внутри процесса
    // его несёт статика OFFSET); файл — только из blocking-пула
    if !OFFSET_LOADED.swap(true, Ordering::Relaxed) {
        let app2 = app.clone();
        if let Ok(Ok(disk)) = tauri::async_runtime::spawn_blocking(move || {
            crate::settings::read_json_config(&app2, "telegram.json")
        })
        .await
        {
            if let Some(o) = disk.get("offset").and_then(|x| x.as_u64()) {
                OFFSET.store(o, Ordering::Relaxed);
            }
        }
    }
    let mut offset = OFFSET.load(Ordering::Relaxed);
    loop {
        let cfg = config();
        if !cfg.enabled || cfg.bot_token.is_empty() {
            POLLING.store(false, Ordering::Relaxed);
            return;
        }
        // Токен расшифровывается на КАЖДУЮ итерацию: после авто-лока vault
        // ключ стирается и цикл честно гасится вместо хождения с enc:v1:…
        // в URL запроса (401-флуд молча после каждого рестарта)
        let Some(token) = plain_token(&cfg.bot_token) else {
            crate::app_log::log_warn("telegram polling: bot token is encrypted and the vault is locked — polling stopped until unlock");
            POLLING.store(false, Ordering::Relaxed);
            return;
        };
        let req = tokio::time::timeout(Duration::from_secs(65), async {
            let resp = crate::network::shared_client(Duration::from_secs(15))?
                .get(format!(
                    // message (фаза 2: команды владельца) + callback_query
                    // (фаза 3: нажатия inline-кнопок)
                    "https://api.telegram.org/bot{token}/getUpdates?timeout=50&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D&offset={offset}"
                ))
                .send()
                .await
                .map_err(|e| format!("telegram poll failed: {}", net_err(&e)))?;
            let status = resp.status();
            let v: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("telegram poll body: {e}"))?;
            Ok::<_, String>((status, v))
        })
        .await;
        let updates = match req {
            Ok(Ok((status, v))) => {
                // 401/409/400 приходят как HTTP != 2xx ИЛИ {"ok":false} при
                // 2xx: без этой проверки ветка трактовала ошибку API как
                // «пустую пачку», сбрасывала бэкофф и флудила запросами
                // без единой строки в консоли
                let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                if !status.is_success() || !ok {
                    let desc = v
                        .get("description")
                        .and_then(|x| x.as_str())
                        .unwrap_or("no description");
                    crate::app_log::log_warn(&format!(
                        "telegram polling: API error (http {}): {}",
                        status.as_u16(),
                        desc
                    ));
                    fails = fails.saturating_add(1);
                    tokio::time::sleep(Duration::from_secs(poll_backoff_secs(fails))).await;
                    continue;
                }
                fails = 0;
                v.get("result")
                    .and_then(|x| x.as_array())
                    .cloned()
                    .unwrap_or_default()
            }
            // Сеть/сервер дёрнулись — пауза с нарастающим бэкоффом и ретрай
            // (не busy-loop и не флуд)
            Ok(Err(e)) => {
                crate::app_log::log_warn(&format!("telegram polling: {e}"));
                fails = fails.saturating_add(1);
                tokio::time::sleep(Duration::from_secs(poll_backoff_secs(fails))).await;
                continue;
            }
            Err(_) => {
                crate::app_log::log_warn("telegram polling: getUpdates timed out after 65s");
                continue;
            }
        };
        let updates_were_processed = !updates.is_empty();
        for u in &updates {
            let Some(id) = u.get("update_id").and_then(|x| x.as_u64()) else {
                continue;
            };
            if id + 1 > offset {
                offset = id + 1;
                OFFSET.store(offset, Ordering::Relaxed);
            }
            let cfg = config();

            // Фаза 3: нажатие inline-кнопки — решение по подтверждению или
            // выбор опции ask_user. Только от привязанного чата и только
            // при включённой интеграции
            if let Some(cq) = u.get("callback_query") {
                let Some(data) = cq.get("data").and_then(|x| x.as_str()).map(String::from)
                else {
                    continue;
                };
                let Some(chat_id) = cq
                    .pointer("/message/chat/id")
                    .and_then(|x| x.as_i64())
                    .map(|n| n.to_string())
                else {
                    continue;
                };
                if !cfg.enabled || cfg.chat_id != chat_id {
                    continue;
                }
                // Ack: гасим спиннер на кнопке и снимаем клавиатуру
                // (best-effort — решение уже уехало на фронт)
                let cq_id = cq.get("id").cloned().unwrap_or(serde_json::Value::Null);
                let mid = cq
                    .pointer("/message/message_id")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
                let ack = tokio::time::timeout(Duration::from_secs(10), async {
                    crate::network::shared_client(Duration::from_secs(15))?
                        .post(format!(
                            "https://api.telegram.org/bot{token}/answerCallbackQuery"
                        ))
                        .json(&serde_json::json!({ "callback_query_id": cq_id }))
                        .send()
                        .await
                        .map_err(|e| net_err(&e))
                })
                .await;
                if let Err(e) = ack {
                    crate::app_log::log_warn(&format!("telegram callback ack failed: {e}"));
                }
                if mid != 0 {
                    let clear = tokio::time::timeout(Duration::from_secs(10), async {
                        crate::network::shared_client(Duration::from_secs(15))?
                            .post(format!(
                                "https://api.telegram.org/bot{token}/editMessageReplyMarkup"
                            ))
                            .json(&serde_json::json!({
                                "chat_id": chat_id,
                                "message_id": mid,
                                "reply_markup": { "inline_keyboard": [] }
                            }))
                            .send()
                            .await
                            .map_err(|e| net_err(&e))
                    })
                    .await;
                    if let Err(e) = clear {
                        crate::app_log::log_warn(&format!("telegram clear keyboard failed: {e}"));
                    }
                }
                let _ = app.emit_to(
                    "main",
                    "telegram-command",
                    serde_json::json!({ "type": "callback", "data": data }),
                );
                continue;
            }

            let Some(msg) = u.get("message") else { continue };
            let Some(chat_id) = msg
                .get("chat")
                .and_then(|c| c.get("id"))
                .and_then(|x| x.as_i64())
                .map(|n| n.to_string())
            else {
                continue;
            };
            let text = msg
                .get("text")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                continue;
            }

            // Повторный /start от уже привязанного чата — no-op
            if cfg.chat_id == chat_id && text.starts_with("/start") {
                continue;
            }

            // Обработка сообщений не от привязанного чата:
            // привязка возможна исключительно по одноразовому 6-значному коду из интерфейса.
            // Посторонние сообщения и некорректные коды игнорируются молча,
            // чтобы не раскрывать факт существования и статус бота в сети.
            if cfg.chat_id != chat_id {
                if cfg.chat_id.is_empty() {
                    let code_candidate = extract_bind_code(&text);
                    let is_valid = if let Some(candidate) = code_candidate {
                        let mut lock = BIND_CODE.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(bc) = lock.as_ref() {
                            if std::time::Instant::now() < bc.expires_at && bc.code == candidate {
                                *lock = None;
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    };

                    if is_valid {
                        let app_for_bind = app.clone();
                        let chat_for_bind = chat_id.clone();
                        let saved = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                            let _guard = DISK_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
                            let mut disk = read_disk_config_safe(&app_for_bind)?;
                            disk["chat_id"] = serde_json::Value::String(chat_for_bind);
                            crate::settings::save_json_config(&app_for_bind, "telegram.json", &disk)
                        })
                        .await
                        .map_err(|e| format!("telegram bind task failed: {e}"))
                        .and_then(|r| r);

                        match saved {
                            Ok(()) => {
                                update_static(|c| {
                                    c.chat_id = chat_id.clone();
                                });
                                let _ = send_message(
                                    &token,
                                    &chat_id,
                                    "✅ Nocturn bound to this chat. Notifications will arrive here.",
                                    &[],
                                )
                                .await;
                            }
                            Err(e) => crate::app_log::log_error(&format!("telegram bind save failed: {e}")),
                        }
                    }
                }
                continue;
            }

            // Сообщение из привязанного чата отправляем интерфейсу
            if cfg.enabled {
                let _ = app.emit_to(
                    "main",
                    "telegram-command",
                    serde_json::json!({ "type": "text", "text": text }),
                );
            }
        }
        // Offset на диск после каждой пачки, где что-то приехало: после
        // сбоя рестарт продолжит с него, а не передоставит пачку заново
        if updates_were_processed {
            persist_offset(&app, offset).await;
        }
    }
}

/// Сериализация писателей telegram.json
static DISK_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn read_disk_config_safe(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))?
        .join("telegram.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(e) => return Err(format!("failed to read telegram.json: {e}")),
    };
    match serde_json::from_str::<serde_json::Value>(&data) {
        Ok(v) => Ok(v),
        Err(e) => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let broken_path = path.with_file_name(format!("telegram.json.broken-{}", ts));
            let _ = std::fs::copy(&path, &broken_path);
            crate::app_log::log_warn(&format!(
                "telegram config corrupted ({e}), backup preserved at {}",
                broken_path.display()
            ));
            Err(format!(
                "telegram.json is corrupted ({e}), backup saved to {}",
                broken_path.display()
            ))
        }
    }
}

/// Сохранить offset в telegram.json. При повреждённом файле запись отменяется,
/// чтобы не затереть конфигурацию пустым объектом.
async fn persist_offset(app: &tauri::AppHandle, offset: u64) {
    let app2 = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _guard = DISK_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut disk = match read_disk_config_safe(&app2) {
            Ok(d) => d,
            Err(e) => {
                crate::app_log::log_warn(&format!("telegram persist_offset skipped: {e}"));
                return Ok(());
            }
        };
        disk["offset"] = serde_json::Value::from(offset);
        crate::settings::save_json_config(&app2, "telegram.json", &disk)
    })
    .await;
}

// ---------- Команды ----------

#[tauri::command(async)]
pub fn telegram_get_config() -> TelegramConfig {
    let mut cfg = config();
    let plain = if crate::crypto::is_encrypted(&cfg.bot_token) {
        crate::crypto::decrypt(&cfg.bot_token).map(|p| p.to_string())
    } else if !cfg.bot_token.is_empty() {
        Some(cfg.bot_token.clone())
    } else {
        None
    };
    cfg.bot_token = plain.map(|t| mask_bot_token(&t)).unwrap_or_default();
    cfg
}

#[tauri::command(async)]
pub async fn telegram_set_config(
    app: tauri::AppHandle,
    config: TelegramConfig,
) -> Result<(), String> {
    let current = self::config();

    // Значение chat_id из IPC игнорируется: привязка меняется только
    // процедурой подтверждения одноразового кода или явным unbind
    let mut actual_chat_id = current.chat_id.clone();

    // Если токен замаскирован (содержит ***), пользователь его не менял
    let target_token = if is_masked_token(&config.bot_token) {
        current.bot_token.clone()
    } else {
        config.bot_token.trim().to_string()
    };

    let token_is_enc = crate::crypto::is_encrypted(&target_token);
    if !target_token.is_empty() && !token_is_enc && !valid_token(&target_token) {
        return Err("invalid bot token: expected \"123456789:AA...\" from @BotFather".into());
    }

    let plain_current = plain_token(&current.bot_token).unwrap_or_default();
    let plain_target = plain_token(&target_token).unwrap_or_default();
    let token_changed = !target_token.is_empty() && (plain_target != plain_current);

    // Смена токена сбрасывает привязку к прежнему чату
    if token_changed {
        actual_chat_id = String::new();
    }

    // Подтверждение через нативный системный диалог при смене токена или первом включении
    let needs_dialog = (token_changed || (!current.enabled && config.enabled)) && !cfg!(test);
    if needs_dialog {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let msg = if token_changed {
            "Change Telegram bot token? This will reset existing chat binding."
        } else {
            "Enable Telegram notifications? Notifications and task status will be sent to your configured bot."
        };
        let confirmed = app
            .dialog()
            .message(msg)
            .title("Confirm Telegram Configuration")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()))
            .blocking_show();
        if !confirmed {
            return Err("telegram configuration update cancelled by user".to_string());
        }
    }

    if config.enabled && !token_is_enc {
        if target_token.is_empty() {
            return Err("bot token is required to enable".into());
        }
        check_token(&target_token).await?;
    }

    let mut for_disk = config.clone();
    for_disk.bot_token = target_token.clone();
    for_disk.chat_id = actual_chat_id.clone();

    let app_for_disk = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = DISK_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        if let Ok(disk) = read_disk_config_safe(&app_for_disk) {
            for_disk.offset = disk.get("offset").and_then(|x| x.as_u64());
        }
        if !for_disk.bot_token.is_empty() && !crate::crypto::is_encrypted(&for_disk.bot_token) {
            if crate::crypto::is_configured() && !crate::crypto::is_unlocked() {
                return Err("vault is locked: unlock the vault before saving secrets".into());
            }
            if crate::crypto::has_key() {
                for_disk.bot_token = crate::crypto::encrypt(&for_disk.bot_token)?;
            }
        }
        crate::settings::save_json_config(&app_for_disk, "telegram.json", &for_disk)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("telegram config task failed: {e}"))??;

    update_static(|c| {
        c.enabled = config.enabled;
        c.bot_token = target_token;
        c.chat_id = actual_chat_id;
        c.notify_start = config.notify_start;
        c.notify_finish = config.notify_finish;
        c.notify_error = config.notify_error;
        c.notify_confirm = config.notify_confirm;
    });

    apply_runtime(app);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStatus {
    pub enabled: bool,
    pub bound: bool,
    pub polling: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_code_expires_in: Option<u64>,
}

#[tauri::command(async)]
pub fn telegram_status() -> TelegramStatus {
    let cfg = config();
    let polling = POLLING.load(Ordering::Relaxed);
    let (bind_code, bind_code_expires_in) = current_bind_code();
    TelegramStatus {
        enabled: cfg.enabled,
        bound: !cfg.chat_id.is_empty(),
        polling,
        bind_code,
        bind_code_expires_in,
    }
}

#[tauri::command(async)]
pub fn telegram_start_bind() -> Result<String, String> {
    use rand::Rng;
    let cfg = config();
    if !cfg.enabled || cfg.bot_token.is_empty() {
        return Err("telegram is not enabled or bot token is empty".into());
    }
    if !cfg.chat_id.is_empty() {
        return Err("telegram is already bound: unbind first to bind a new chat".into());
    }
    let code: u32 = rand::thread_rng().gen_range(100_000..=999_999);
    let code_str = code.to_string();
    let mut lock = BIND_CODE.lock().unwrap_or_else(|p| p.into_inner());
    *lock = Some(BindCode {
        code: code_str.clone(),
        expires_at: std::time::Instant::now() + Duration::from_secs(300),
    });
    Ok(code_str)
}

/// Забыть привязку
#[tauri::command(async)]
pub async fn telegram_unbind(app: tauri::AppHandle) -> Result<(), String> {
    update_static(|c| {
        c.chat_id = String::new();
    });
    *BIND_CODE.lock().unwrap_or_else(|p| p.into_inner()) = None;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = DISK_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut disk = read_disk_config_safe(&app)?;
        disk["chat_id"] = serde_json::Value::String(String::new());
        crate::settings::save_json_config(&app, "telegram.json", &disk)
    })
    .await
    .map_err(|e| format!("telegram unbind task failed: {e}"))??;
    Ok(())
}

/// Уведомление о событии прогона
#[tauri::command(async)]
pub fn telegram_notify(kind: String, text: String, buttons: Option<Vec<TgButton>>) {
    if !matches!(kind.as_str(), "start" | "finish" | "error" | "confirm" | "ask") {
        crate::app_log::log_warn(&format!("telegram notify dropped: unknown event kind '{kind}'"));
        return;
    }

    let sanitized_title = text
        .replace("```", "")
        .replace(['\r', '\n'], " ")
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    let clean_title = sanitize_outgoing_text(&sanitized_title);

    let formatted = if clean_title.starts_with("▶️")
        || clean_title.starts_with("Задача")
        || clean_title.starts_with("Ошибка")
        || clean_title.starts_with("Ожидает")
        || clean_title.starts_with("Вопрос")
    {
        clean_title
    } else {
        match kind.as_str() {
            "start" => format!("▶️ Задача запущена: {clean_title}"),
            "finish" => format!("Задача завершена: {clean_title}"),
            "error" => format!("Ошибка задачи: {clean_title}"),
            "confirm" => format!("Ожидает подтверждения: {clean_title}"),
            "ask" => format!("Вопрос от агента: {clean_title}"),
            _ => return,
        }
    };

    let safe_buttons = buttons.map(|btns| {
        btns.into_iter()
            .filter(|b| b.data.starts_with("confirm:") || b.data.starts_with("ask:"))
            .map(|mut b| {
                if b.data.len() > 64 {
                    b.data.truncate(64);
                }
                b
            })
            .collect::<Vec<_>>()
    });

    notify_formatted(&kind, &formatted, safe_buttons);
}

#[allow(dead_code)]
pub fn notify_event(kind: &str, title: &str, buttons: Option<Vec<TgButton>>) {
    telegram_notify(kind.to_string(), title.to_string(), buttons);
}

fn notify_formatted(kind: &str, text: &str, buttons: Option<Vec<TgButton>>) {
    let cfg = config();
    if !should_notify(&cfg, kind) {
        crate::app_log::log_info(&format!(
            "telegram notify dropped: kind={} enabled={} bound={} token={}",
            kind,
            cfg.enabled,
            !cfg.chat_id.is_empty(),
            if cfg.bot_token.is_empty() {
                "empty"
            } else if crate::crypto::is_encrypted(&cfg.bot_token) {
                "encrypted(vault locked?)"
            } else {
                "plain"
            },
        ));
        return;
    }
    let chat_id = cfg.chat_id;
    let token_plain = if crate::crypto::is_encrypted(&cfg.bot_token) {
        match crate::crypto::decrypt(&cfg.bot_token) {
            Some(plain) => plain.to_string(),
            None => {
                crate::app_log::log_warn(&format!(
                    "telegram notify dropped: kind={} token is encrypted and the vault is locked — unlock the vault to restore notifications",
                    kind
                ));
                return;
            }
        }
    } else {
        cfg.bot_token.clone()
    };
    let buttons = buttons.unwrap_or_default();
    let text = text.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = send_message(&token_plain, &chat_id, &text, &buttons).await {
            crate::app_log::log_error(&format!("telegram notify: {e}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_format_validation() {
        assert!(valid_token("123456789:AAHdqTcvbCHG0jKIhASdeOQ8vDoOvBOiO"));
        assert!(valid_token(
            "123456789012:AAEk2xLmNoPqRsTuVwXyZ0123456789_-abcdefg"
        ));
        // Нет двоеточия / короткий id / короткий секрет / плохие символы
        assert!(!valid_token("123456789"));
        assert!(!valid_token("12345:AAHdqTcvbCHG0jKIhASdeOQ8vDoOvBOiO"));
        assert!(!valid_token("123456789:short"));
        assert!(!valid_token("123456789:AAHdqTcvbCHG0jK!hASdeOQ8vDoOvBOiO"));
        assert!(!valid_token(""));
    }

    #[test]
    fn poll_backoff_grows_and_caps() {
        // 5 → 10 → 20 → 30 (кап): недоступный Telegram не спамит консоль
        assert_eq!(poll_backoff_secs(1), 5);
        assert_eq!(poll_backoff_secs(2), 10);
        assert_eq!(poll_backoff_secs(3), 20);
        assert_eq!(poll_backoff_secs(4), 30);
        assert_eq!(poll_backoff_secs(50), 30);
    }

    #[test]
    fn should_notify_gates_everything() {
        let base = TelegramConfig::default();
        // Мёртв по умолчанию: выключен / не привязан / без токена
        assert!(!should_notify(&base, "start"));
        let mut cfg = base.clone();
        cfg.enabled = true;
        cfg.bot_token = "123456789:AAHdqTcvbCHG0jKIhASdeOQ8vDoOvBOiO".into();
        assert!(!should_notify(&cfg, "start"), "нет chat_id — не шлём");
        cfg.chat_id = "42".into();
        assert!(should_notify(&cfg, "start"));
        assert!(should_notify(&cfg, "finish"));
        assert!(should_notify(&cfg, "error"));
        assert!(should_notify(&cfg, "confirm"));
        // Тумблеры событий и неизвестный kind
        cfg.notify_start = false;
        assert!(!should_notify(&cfg, "start"));
        assert!(should_notify(&cfg, "finish"));
        assert!(!should_notify(&cfg, "unknown"));
    }

    /// Стык с фронтом (api.ts TelegramConfig): поля camelCase
    #[test]
    fn config_serializes_camel_case() {
        let cfg = TelegramConfig {
            enabled: true,
            bot_token: "t".into(),
            chat_id: "1".into(),
            ..TelegramConfig::default()
        };
        let v = serde_json::to_value(&cfg).unwrap();
        assert!(v.get("notifyStart").is_some(), "camelCase поле потеряно");
        assert!(v.get("notify_start").is_none(), "snake_case утёк на фронт");
        assert!(v.get("botToken").is_some());
    }

    /// Диск может нести поле "offset" (персистентный offset getUpdates,
    /// живущий вне типизированного конфига) — чтение конфига обязано его
    /// молча игнорировать, а не падать
    #[test]
    fn config_ignores_disk_offset_field() {
        let raw = r#"{"enabled":true,"botToken":"t","chatId":"1","notifyStart":true,"notifyFinish":true,"notifyError":true,"notifyConfirm":true,"offset":42}"#;
        let cfg: TelegramConfig = serde_json::from_str(raw).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.chat_id, "1");
    }

    /// plain_token: plain проходит насквозь; enc без разблокированного
    /// хранилища — None (поллер гасится вместо хождения с enc:v1:… в URL).
    /// В тестах vault не разблокирован — расшифровать нечем
    #[test]
    fn plain_token_passes_plain_and_blocks_encrypted_without_key() {
        assert_eq!(plain_token("123456789:AAx"), Some("123456789:AAx".into()));
        assert_eq!(plain_token("enc:v1:AAAA"), None);
    }

 /// Контракт обхода enc-форма — не формат бота, valid_token её
    /// отвергает; set_config пропускает проверку для enc ЯВНО (is_encrypted
    /// перед вызовом). Тест закрепляет, что «enc случайно пройдёт валидатор»
    /// невозможно — обход обязан оставаться явным
    #[test]
    fn enc_form_is_not_a_valid_bot_token() {
        assert!(!valid_token("enc:v1:AAAA"));
        assert!(crate::crypto::is_encrypted("enc:v1:AAAA"));
    }

    #[test]
    fn mask_token_and_detect_mask() {
        let token = "123456789:AAHdqTcvbCHG0jKIhASdeOQ8vDoOvBOiO";
        let masked = mask_bot_token(token);
        assert!(masked.starts_with("123456789:AA***"));
        assert!(masked.ends_with("iO"));
        assert!(is_masked_token(&masked));
        assert!(!is_masked_token(token));
        assert_eq!(mask_bot_token(""), "");
    }

    #[test]
    fn extract_bind_code_various_inputs() {
        assert_eq!(extract_bind_code("/start 123456"), Some("123456".into()));
        assert_eq!(extract_bind_code("  /start   654321  "), Some("654321".into()));
        assert_eq!(extract_bind_code("123456"), Some("123456".into()));
        assert_eq!(extract_bind_code("/start"), None);
        assert_eq!(extract_bind_code("/start abc"), None);
        assert_eq!(extract_bind_code("hello world"), None);
        assert_eq!(extract_bind_code("12345"), None);
        assert_eq!(extract_bind_code("1234567"), None);
    }

    #[test]
    fn sanitize_outgoing_text_removes_keys_and_paths() {
        let text_with_key = "Failed with token sk-ant-api03-abcdef123456789 during request";
        let sanitized_key = sanitize_outgoing_text(text_with_key);
        assert!(!sanitized_key.contains("sk-ant-"));
        assert!(sanitized_key.contains("[REDACTED_SECRET]"));

        let text_with_url = "Requesting https://api.openai.com/v1/chat?key=secret12345&foo=bar";
        let sanitized_url = sanitize_outgoing_text(text_with_url);
        assert!(!sanitized_url.contains("secret12345"));
        assert!(sanitized_url.contains("key=[REDACTED_SECRET]"));

        let text_with_path = "Error reading C:\\Users\\Alice\\AppData\\Roaming\\com.haloui.app\\settings.json";
        let sanitized_path = sanitize_outgoing_text(text_with_path);
        assert!(!sanitized_path.contains("Alice"));
        assert!(sanitized_path.contains("[REDACTED_PATH]"));

        let text_with_unix = "Key placed in /home/alice/.ssh/id_rsa";
        let sanitized_unix = sanitize_outgoing_text(text_with_unix);
        assert!(!sanitized_unix.contains("alice"));
        assert!(sanitized_unix.contains("[REDACTED_PATH]"));

        let normal = "Задача выполнена за 3 секунды";
        assert_eq!(sanitize_outgoing_text(normal), normal);
    }
}
