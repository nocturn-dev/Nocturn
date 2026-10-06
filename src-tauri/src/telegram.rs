//! Telegram-бот уведомлений (фаза 1): исходящие уведомления о жизни задачи
//! в личный чат владельца через СВОЕГО бота (токен от @BotFather).
//!
//! Приватность (главный принцип модуля):
//! - мёртв до явного включения тумблером (ни одного запроса к api.telegram.org
//!   до `enabled: true` — зеркалит opt-in проверку обновлений);
//! - наружу уходит ТОЛЬКО то, что владелец включил тумблерами событий, и
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

/// Сеттер статики для загрузки дискового конфига в setup (lib.rs) —
/// без рестарта polling (при старте apply_runtime зовётся отдельно)
pub fn set_config(cfg: TelegramConfig) {
    set_static(cfg);
}

/// Живой long-polling таск: abort при каждом set_config/unbind (ремап по
/// образцу portal-сессии — старый цикл не должен переживать новый).
/// Хранится ПОЛНЫЙ JoinHandle: результат spawn терять нельзя — без него
/// stop_polling вечно no-op и тумблер «выкл» не гасит цикл (найдено по
/// логам владельца: getUpdates уходили при выключенном Telegram)
static POLL_TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);
/// Живость поллера для telegram_status: tauri-JoinHandle не отдаёт
/// is_finished, поэтому флаг ведём сами (spawn/выход/abort)
static POLLING: AtomicBool = AtomicBool::new(false);
/// Персистентный offset getUpdates: старт с 0 ределиверил необработанную
/// пачку после abort/крэша (аудит: повторное исполнение команд владельца
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
/// вызывающий честно гасит/пропускает работу (аудит: поллер уходил с
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
/// (аудит: секрет в консоли при любом сетевом сбое)
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
    // Total-таймаут обязателен (аудит: connect_timeout не спасает от
    // stalled-соединения); Telegram сам отвечает быстро на sendMessage
    // Лимит Telegram на текст — 4096 символов: превышение даёт HTTP 400 и
    // уведомление терялось молча (кандидат на «работает 50/50»); хвост
    // события не критичен
    let text: String = text.chars().take(4096).collect();
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
            "inline_keyboard": [buttons
                .iter()
                .map(|b| serde_json::json!({"text": b.label, "callback_data": b.data}))
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
        // в URL запроса (аудит: 401-флуд молча после каждого рестарта)
        let Some(token) = plain_token(&cfg.bot_token) else {
            eprintln!("telegram polling: bot token is encrypted and the vault is locked — polling stopped until unlock");
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
                // без единой строки в консоли (аудит)
                let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                if !status.is_success() || !ok {
                    let desc = v
                        .get("description")
                        .and_then(|x| x.as_str())
                        .unwrap_or("no description");
                    eprintln!(
                        "telegram polling: API error (http {}): {}",
                        status.as_u16(),
                        desc
                    );
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
                eprintln!("telegram polling: {e}");
                fails = fails.saturating_add(1);
                tokio::time::sleep(Duration::from_secs(poll_backoff_secs(fails))).await;
                continue;
            }
            Err(_) => {
                eprintln!("telegram polling: getUpdates timed out after 65s");
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
                    eprintln!("telegram callback ack failed: {e}");
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
                        eprintln!("telegram clear keyboard failed: {e}");
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

            // /start от НЕ привязанного чата — привязка
            if text.starts_with("/start") {
                if !cfg.chat_id.is_empty() {
                    // Привязка однозначна: бот уже знает владельца. Второй чат
                    // НЕ перебивает — иначе любой, узнавший токен, угонял бы бота
                    let _ = send_message(
                        &token,
                        &chat_id,
                        "This bot is already bound to another chat.",
                        &[],
                    )
                    .await;
                    continue;
                }
                // Привязка: chat_id в статик + на диск (токен остаётся в
                // дисковой копии зашифрованным — читаем файл, правим только
                // поле chat_id). Файл — из blocking-пула: не морозим tokio-
                // воркер long-poll цикла
                let app_for_bind = app.clone();
                let chat_for_bind = chat_id.clone();
                let saved = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                    let _guard = DISK_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
                    let mut disk = crate::settings::read_json_config(&app_for_bind, "telegram.json")
                        .unwrap_or_else(|_| serde_json::json!({}));
                    disk["chat_id"] = serde_json::Value::String(chat_for_bind);
                    crate::settings::save_json_config(&app_for_bind, "telegram.json", &disk)
                })
                .await
                .map_err(|e| format!("telegram bind task failed: {e}"))
                .and_then(|r| r);
                match saved {
                    Ok(()) => {
                        let mut cfg = cfg;
                        cfg.chat_id = chat_id.clone();
                        set_static(cfg);
                        let _ = send_message(
                            &token,
                            &chat_id,
                            "✅ Nocturn bound to this chat. Notifications will arrive here.",
                            &[],
                        )
                        .await;
                    }
                    Err(e) => eprintln!("telegram bind save failed: {e}"),
                }
                continue;
            }

            // Фаза 2: текст от владельца — на фронт. Диспетчер в App разводит:
            // /stop, поправка в идущий прогон, новая задача, текстовое да/нет.
            // Тексты чужих чатов молча игнорируются
            if cfg.chat_id == chat_id && cfg.enabled {
                let _ = app.emit_to(
                    "main",
                    "telegram-command",
                    serde_json::json!({ "type": "text", "text": text }),
                );
            }
        }
        // Offset на диск после каждой пачки, где что-то приехало: после
        // крэша рестарт продолжит с него, а не ределиверит пачку заново
        if updates_were_processed {
            persist_offset(&app, offset).await;
        }
    }
}

/// Сериализация писателей telegram.json: четыре писателя (bind/unbind/
/// set_config/persist_offset) делают read-modify-write целого файла.
/// Без общего лока interleaving давал last-writer-wins — запоздалый
/// offset-снимок перезаписывал выключенный тумблер, и Telegram
/// «самовключался» после рестарта. std-Mutex внутри spawn_blocking:
/// держится микросекунды, await под ним нет
static DISK_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Сохранить offset в telegram.json (поле вне типизированного TelegramConfig —
/// serde при чтении конфига его молча игнорирует). Ошибка не фатальна:
/// worst case — рестарт ределиверит последнюю пачку
async fn persist_offset(app: &tauri::AppHandle, offset: u64) {
    let app2 = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _guard = DISK_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut disk = crate::settings::read_json_config(&app2, "telegram.json")
            .unwrap_or_else(|_| serde_json::json!({}));
        disk["offset"] = serde_json::Value::from(offset);
        crate::settings::save_json_config(&app2, "telegram.json", &disk)
    })
    .await;
}

// ---------- Команды ----------

#[tauri::command(async)]
pub fn telegram_get_config() -> TelegramConfig {
    let mut cfg = config();
    // После старта из диска токен может лежать зашифрованным — для поля
    // настроек расшифровываем, если хранилище открыто (паттерн imagegen)
    if crate::crypto::is_encrypted(&cfg.bot_token) {
        if let Some(plain) = crate::crypto::decrypt(&cfg.bot_token) {
            cfg.bot_token = plain.to_string();
        }
    }
    cfg
}

#[tauri::command(async)]
pub async fn telegram_set_config(
    app: tauri::AppHandle,
    config: TelegramConfig,
) -> Result<(), String> {
    // enc-форма токена — НАШ шифротекст, вернувшийся из get_config при
    // запертом vault (круговое сохранение настроек из UI). valid_token его
    // не разбирает (id «enc» — 3 символа), и ЛЮБАЯ правка настроек падала
    // с «invalid bot token» до разблокировки хранилища (аудит A2-2):
    // форматную проверку и getMe пропускаем — диск уже несёт этот токен,
    // расшифровку и живую проверку сделает unlock → apply_runtime
    let token_is_enc = crate::crypto::is_encrypted(&config.bot_token);
    if !config.bot_token.is_empty() && !token_is_enc && !valid_token(&config.bot_token) {
        return Err("invalid bot token: expected \"123456789:AA...\" from @BotFather".into());
    }
    // Включение проверяем живым Telegram'ом (getMe): иначе опечатка ловится
    // тишиной уведомлений, а не ошибкой на тумблере. enc-токен не проверяем:
    // при запертом vault polling честно погасится с диагностикой (plain_token)
    if config.enabled && !token_is_enc {
        if config.bot_token.is_empty() {
            return Err("bot token is required to enable".into());
        }
        check_token(&config.bot_token).await?;
    }
    let for_disk_input = config.clone();
    let app_for_disk = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = DISK_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut for_disk = for_disk_input;
        if crate::crypto::has_key()
            && !for_disk.bot_token.is_empty()
            && !crate::crypto::is_encrypted(&for_disk.bot_token)
        {
            for_disk.bot_token = crate::crypto::encrypt(&for_disk.bot_token)?;
        }
        crate::settings::save_json_config(&app_for_disk, "telegram.json", &for_disk)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("telegram config task failed: {e}"))??;
    set_static(config);
    apply_runtime(app);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStatus {
    pub enabled: bool,
    pub bound: bool,
    pub polling: bool,
}

#[tauri::command(async)]
pub fn telegram_status() -> TelegramStatus {
    let cfg = config();
    let polling = POLLING.load(Ordering::Relaxed);
    TelegramStatus {
        enabled: cfg.enabled,
        bound: !cfg.chat_id.is_empty(),
        polling,
    }
}

/// Забыть привязку (перепривязка — следующим /start боту)
#[tauri::command(async)]
pub async fn telegram_unbind(app: tauri::AppHandle) -> Result<(), String> {
    let mut cfg = config();
    cfg.chat_id = String::new();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = DISK_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut disk = crate::settings::read_json_config(&app, "telegram.json")
            .unwrap_or_else(|_| serde_json::json!({}));
        disk["chat_id"] = serde_json::Value::String(String::new());
        crate::settings::save_json_config(&app, "telegram.json", &disk)
    })
    .await
    .map_err(|e| format!("telegram unbind task failed: {e}"))??;
    set_static(cfg);
    Ok(())
}

/// Уведомление о событии прогона. Fire-and-forget: вызов возвращается
/// сразу, отправка — в фоне; ошибки только в eprintln (чат не должен
/// зависеть от доступности Telegram). Фронт кэша конфига больше нет —
/// РЕШЕНИЕ о отправке всегда здесь. buttons — inline-клавиатура
/// (фаза 3: решения по подтверждениям/ask_user одним тапом)
#[tauri::command(async)]
pub fn telegram_notify(kind: String, text: String, buttons: Option<Vec<TgButton>>) {
    let cfg = config();
    if !should_notify(&cfg, &kind) {
        // Диагностика «нуля уведомлений» (фидбек владельца): каждая причина
        // дропа видна в консоли. Токен НЕ печатаем — только его состояние
        eprintln!(
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
        );
        return;
    }
    let chat_id = cfg.chat_id;
    // Токен в статике может быть зашифрованным (старт с диска при
    // заблокированном хранилище) — тогда расшифровать нечем и слать
    // нечем. Раньше ветка молчала — единственная немая причина дропа,
    // правдоподобный вклад в жалобу «работает 50/50» (аудит A2-1): теперь
    // причина видна в консоли, как и у should_notify выше
    let token_plain = if crate::crypto::is_encrypted(&cfg.bot_token) {
        match crate::crypto::decrypt(&cfg.bot_token) {
            Some(plain) => plain.to_string(),
            None => {
                eprintln!(
                    "telegram notify dropped: kind={} token is encrypted and the vault is locked — unlock the vault to restore notifications",
                    kind
                );
                return;
            }
        }
    } else {
        cfg.bot_token.clone()
    };
    let buttons = buttons.unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = send_message(&token_plain, &chat_id, &text, &buttons).await {
            eprintln!("telegram notify: {e}");
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

    /// Контракт обхода A2-2: enc-форма — не формат бота, valid_token её
    /// отвергает; set_config пропускает проверку для enc ЯВНО (is_encrypted
    /// перед вызовом). Тест закрепляет, что «enc случайно пройдёт валидатор»
    /// невозможно — обход обязан оставаться явным
    #[test]
    fn enc_form_is_not_a_valid_bot_token() {
        assert!(!valid_token("enc:v1:AAAA"));
        assert!(crate::crypto::is_encrypted("enc:v1:AAAA"));
    }
}
