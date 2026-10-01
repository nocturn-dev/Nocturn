//! Исполнение инструментов агента (run_tool), схемы инструментов,
//! серверный слой прав (perm_set), конфиги browser/computer/imagegen,
//! звуки уведомлений, keep-awake, история сессий.

use crate::crypto;
use crate::notes::notes_dir;
use crate::perm;
use crate::settings::{config_file, rejects_sensitive_path, save_json_config};
use crate::{browser, computer, hooks, imagegen, mcp, tools, websearch};
use base64::engine::general_purpose::STANDARD as B64;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
// mpsc нужен только keep-awake воркеру (Windows); на остальных ОС импорт мёртв
#[cfg(windows)]
use std::sync::mpsc;
use std::path::PathBuf;
use std::time::Duration;

/// Кап одного вызова MCP-инструмента (обе попытки пула)
const MCP_TOOL_TIMEOUT: Duration = Duration::from_secs(120);
/// M2: исполнение инструмента агента (вызывается из агентного цикла / для тестов).
/// Имена mcp__<server>__<tool> маршрутизируются в подключённый MCP-сервер.
/// По пути прогоняются хуки PreToolUse (может заблокировать) и PostToolUse
/// (additionalContext дописывается к результату).
/// Инструмент, отключённый пользователем для задачи (Session.disabledTools):
/// серверный гардал к фронт-фильтру схем — модель может позвать скрытое.
/// Отказ ДО perm-слоя и PreToolUse-хуков, как perm-проверка: хуки не должны
/// исполняться для заведомо заблокированного вызова. Err уходит модели как
/// обычная ошибка инструмента.
fn ensure_not_user_disabled(
    name: &str,
    disabled: &Option<Vec<String>>,
) -> Result<(), String> {
    match disabled {
        Some(list) if list.iter().any(|n| n == name) => Err(format!(
            "tool \"{name}\" is disabled by the user for this task; continue without it"
        )),
        _ => Ok(()),
    }
}

// IPC-граница tauri: плоские аргументы — контракт invoke с фронтенда
// (как chat_stream в chat.rs)
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_tool(
    app: tauri::AppHandle,
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
    browser_registry: tauri::State<'_, browser::BrowserRegistry>,
    abort_registry: tauri::State<'_, crate::chat::AbortRegistry>,
    name: String,
    arguments: String,
    // requestId прогона: по нему Stop находит флаг отмены и убивает
    // исполняющийся процесс немедленно (shell_run, хуки)
    request_id: Option<String>,
    // Чёрный список инструментов активной задачи (Session.disabledTools);
    // субагенты наследуют его, не расширяя набор
    disabled_tools: Option<Vec<String>>,
) -> Result<String, String> {
    use tauri::Manager;

    let args: serde_json::Value =
        serde_json::from_str(&arguments).map_err(|e| format!("invalid arguments JSON: {e}"))?;

    // Отключённые пользователем: раньше perm-слоя, чтобы хуки не выполнялись
    ensure_not_user_disabled(&name, &disabled_tools)?;

    // Серверный слой прав: бэкенд не «глухой исполнитель» — дубль фронт-логики
    // разрешений (App.tsx). Err уходит модели как обычная ошибка инструмента.
    // Проверка стоит ДО PreToolUse-хуков: в Plan-режиме shell-команды хуков
    // не должны запускаться на каждый вызов заблокированного инструмента.
    // shell_run — без path-контроля (cwd опционален); для fs_* берём путь из args.
    {
        let perm_path = if name.starts_with("fs_") {
            args.get("path").and_then(|v| v.as_str()).map(str::to_string)
        } else {
            None
        };
        let state = perm::current();
        let tool = name.clone();
        // Канонизация пути в perm ходит по ФС (вплоть до сетевых корней): в
        // blocking-пул, иначе на tokio-воркере это вставало поперёк всех
        // SSE-стримов (класс бага, уже починенный для load_settings/CA_PEM)
        tauri::async_runtime::spawn_blocking(move || {
            perm::decide(&state, &tool, perm_path.as_deref())
        })
        .await
        .map_err(|e| format!("perm task failed: {e}"))??;
    }

    // Флаг отмены прогона: chat_abort/Stop поднимают его в реестре.
    // Инструменты исполняются ПОСЛЕ завершения стрима, когда AbortGuard
    // chat_stream уже вычистил запись — раньше abort_flag здесь всегда был
    // None, и Stop не мог прервать исполняющийся инструмент (shell_run
    // крутился до собственного таймаута до 300 с). Если записи нет —
    // регистрируем свежий флаг на время тулл-кола.
    let (abort_flag, tool_abort_created): (
        Option<std::sync::Arc<AtomicBool>>,
        bool,
    ) = {
        let mut map = abort_registry.0.lock().map_err(|e| e.to_string())?;
        match request_id.as_ref().and_then(|id| map.get(id).cloned()) {
            Some(f) => (Some(f), false),
            None => match &request_id {
                Some(id) => {
                    let f = std::sync::Arc::new(AtomicBool::new(false));
                    map.insert(id.clone(), f.clone());
                    (Some(f), true)
                }
                None => (None, false),
            },
        }
    };
    // created: мы сами завели запись (стрима с этим id уже нет) — снимаем её
    // на выходе; чужую запись (живой стрим) не трогаем, её чистит AbortGuard
    struct ToolAbortGuard<'a> {
        registry: &'a crate::chat::AbortRegistry,
        request_id: Option<String>,
        created: bool,
    }
    impl Drop for ToolAbortGuard<'_> {
        fn drop(&mut self) {
            if self.created {
                if let Some(id) = &self.request_id {
                    if let Ok(mut map) = self.registry.0.lock() {
                        map.remove(id);
                    }
                }
            }
        }
    }
    let _tool_abort_guard = ToolAbortGuard {
        registry: &abort_registry,
        request_id: request_id.clone(),
        created: tool_abort_created,
    };

    // Хуки PreToolUse: любой с decision=block (или ненулевым exit) блокирует вызов
    {
        let cfg_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?;
        let payload = serde_json::json!({
            "event": "PreToolUse",
            "tool": name,
            "arguments": args,
        });
        let tool_name = name.clone();
        let pre_abort = abort_flag.clone();
        for out in tauri::async_runtime::spawn_blocking(move || {
            hooks::run_event_with_abort(
                &cfg_dir,
                "PreToolUse",
                &tool_name,
                &payload,
                pre_abort.as_deref(),
            )
        })
        .await
        .map_err(|e| format!("hook task failed: {e}"))?
        {
            if out.blocked {
                return Err(format!(
                    "blocked by hook {}: {}",
                    out.id,
                    if out.reason.is_empty() { "no reason given" } else { &out.reason }
                ));
            }
        }
        // Прогон отменили, пока выполнялся хук: сам инструмент не запускаем
        if abort_flag
            .as_ref()
            .is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed))
        {
            return Err("aborted by user".to_string());
        }
    }

    // notes_dir (fs::create_dir_all) нужен только vault-инструментам: раньше
    // он гонялся синхронно на tokio-воркере на КАЖДЫЙ тулл-колл, включая
    // чисто-чатовые, и вставал поперёк стримов на медленном/сетевом диске
    let notes = if name.starts_with("vault_") {
        Some(notes_dir(&app)?)
    } else {
        None
    };
    // memory.json (конфиг-каталог) — только memory-инструментам (тот же мотив)
    let memory_file = if name.starts_with("memory_") {
        Some(crate::settings::config_file(&app, "memory.json")?)
    } else {
        None
    };
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    // Синхронный fs::read + AES-расшифровка settings.json — в blocking-пул:
    // на tokio-воркере это вставало поперёк всех SSE-стримов (класс бага,
    // уже починенный в network.rs для CA_PEM)
    let app_for_settings = app.clone();
    let chat_api = tauri::async_runtime::spawn_blocking(move || {
        // Фолбэк None сознателен (битый конфиг не должен ронять инструмент),
        // но отказ чтения неотличим от «не настроено» — снимаем тупик
        // диагностики логом
        crate::settings::load_settings(app_for_settings)
            .inspect_err(|e| {
                eprintln!("run_tool: settings load failed, fallbacks degraded: {e}");
            })
            .ok()
    })
    .await
    .unwrap_or(None);
    let result = execute_tool_inner(
        app.clone(),
        mcp_registry,
        browser_registry,
        name.clone(),
        args.clone(),
        notes,
        data_dir,
        memory_file,
        chat_api,
        abort_flag.clone(),
    )
    .await?;

    // Прогон отменили во время исполнения инструмента: результат уже не нужен
    if abort_flag
        .as_ref()
        .is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed))
    {
        return Err("aborted by user".to_string());
    }

    // Хуки PostToolUse: additionalContext дописывается к результату
    {
        let cfg_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?;
        let payload = serde_json::json!({
            "event": "PostToolUse",
            "tool": name,
            "arguments": args,
            "result": result,
        });
        let outs = tauri::async_runtime::spawn_blocking(move || {
            hooks::run_event(&cfg_dir, "PostToolUse", &name, &payload)
        })
        .await
        .map_err(|e| format!("hook task failed: {e}"))?;
        let extra: Vec<String> = outs
            .iter()
            .filter(|o| !o.additional_context.is_empty())
            .map(|o| o.additional_context.clone())
            .collect();
        if extra.is_empty() {
            Ok(result)
        } else {
            Ok(format!("{result}\n\n[hook context]\n{}", extra.join("\n")))
        }
    }
}

/// Ожидание abort-флага (для select! поверх блокирующих вызовов):
/// None — ждём вечно; флаг поллится раз в 100 мс (AtomicBool без нотификации)
async fn wait_for_abort(flag: Option<&std::sync::Arc<AtomicBool>>) {
    let Some(f) = flag else {
        std::future::pending::<()>().await;
        return;
    };
    loop {
        if f.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Собственно диспетчеризация инструмента (без хуков)
// IPC-внутренняя граница: плоские параметры (как у run_tool с chat_stream)
#[allow(clippy::too_many_arguments)]
pub async fn execute_tool_inner(
    app: tauri::AppHandle,
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
    browser_registry: tauri::State<'_, browser::BrowserRegistry>,
    name: String,
    args: serde_json::Value,
    // Нужен только vault-инструментам (лениво из run_tool): см. заметку
    // про синхронный IO в run_tool
    notes_dir: Option<std::path::PathBuf>,
    data_dir: std::path::PathBuf,
    // memory.json (конфиг-каталог) — только memory-инструментам
    memory_file: Option<std::path::PathBuf>,
    // Подключение чата (settings.json) для фолбэка image_generate
    chat_api: Option<crate::settings::ApiSettings>,
    abort_flag: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<String, String> {
    // Computer-инструменты: скриншот быстрый, мышь/клавиатура — блокирующие
    if name.starts_with("computer_") {
        if !computer::config().enabled {
            return Err("Computer Use is disabled in Settings".to_string());
        }
        // arguments (JSON-строка) нужен только computer/vault/memory-веткам;
        // раньше сериализовался впустую на каждый тулл-колл (в т.ч. MCP
        // с большими аргументами)
        let arguments = args.to_string();
        let work = tauri::async_runtime::spawn_blocking(move || {
            computer::execute_computer_tool(&name, &arguments)
        });
        // Stop обязан отвечать сразу: блокирующий вызов доигрывает в фоне,
        // результат отбрасывается (раньше шаг стоял до таймаута)
        let result: String = tokio::select! {
            res = work => res.map_err(|e| format!("tool task failed: {e}"))??,
            _ = wait_for_abort(abort_flag.as_ref()) => {
                return Err("aborted by user".to_string());
            }
        };
        return Ok(result);
    }

    // Browser-инструменты: соединение лениво запускается, блокирующий
    // CDP-вызов — в отдельном потоке. Дублируем проверку тумблера:
    // модель могла получить схемы до выключения
    if name.starts_with("browser_") {
        if !browser::config().enabled {
            return Err("Browser Use is disabled in Settings".to_string());
        }
        if name == "browser_close" {
            // kill() внутри — taskkill/CDP-close, блокирующие: не занимаем
            // tokio-воркер (класс «встало поперёк всех SSE-стримов»)
            let reg = browser_registry.0.clone();
            tauri::async_runtime::spawn_blocking(move || browser::BrowserRegistry(reg).kill_all())
                .await
                .map_err(|e| format!("tool task failed: {e}"))?;
            return Ok("Browser closed.".to_string());
        }
        // get_or_launch (запуск браузера до ~20 с) — тоже в отдельном потоке,
        // иначе блокирующий launch оккупировал бы воркер tokio
        let browser_reg = browser_registry.0.clone();
        let conn = tauri::async_runtime::spawn_blocking(move || {
            browser::BrowserRegistry(browser_reg).get_or_launch()
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))??;
        // args переезжает в поток по владению: ветка завершается return,
        // глубокая копия Value на каждый browser-вызов была лишней
        let work = tauri::async_runtime::spawn_blocking(move || {
            browser::execute_on(&conn, &name, &args)
        });
        // Stop отвечает немедленно: блокирующий CDP-вызов (до WS-таймаута
        // 120 с, например browser_navigate на молчащем сайте) доигрывает
        // в фоне, результат отбрасывается
        let result: String = tokio::select! {
            res = work => res.map_err(|e| format!("tool task failed: {e}"))??,
            _ = wait_for_abort(abort_flag.as_ref()) => {
                return Err("aborted by user".to_string());
            }
        };
        return Ok(result);
    }

    if let Some((server_raw, tool_raw)) = mcp::split_prefixed_name(&name) {
        let server = server_raw.to_string();
        let tool = tool_raw.to_string();
        // Пул: не подключён — прозрачный connect-on-demand (сервер включён
        // в конфиге); подключён — живой хендл
        let registry_arc = mcp_registry.0.clone();
        let handle = mcp::ensure_connected(app.clone(), registry_arc.clone(), server.clone())
            .await
            .map_err(|e| format!("mcp {server}.{tool}: {e}"))?;

        // Одна попытка вызова: кап таймаута + abort (зависший/однопоточный
        // MCP-сервер раньше вешал runTool навсегда — Stop не помогал)
        macro_rules! mcp_attempt {
            ($h:expr, $a:expr) => {
                tokio::select! {
                    res = $h.call_tool(&tool, $a) => res.map_err(|e| format!("mcp {server}.{tool}: {e}")),
                    _ = tokio::time::sleep(MCP_TOOL_TIMEOUT) => Err(format!(
                        "mcp {server}.{tool}: timed out after {}s",
                        MCP_TOOL_TIMEOUT.as_secs()
                    )),
                    _ = wait_for_abort(abort_flag.as_ref()) => {
                        Err("aborted by user".to_string())
                    }
                }
            };
        }

        // Попытка 1. Транспортная ошибка (процесс умер, EPIPE, сеть упала) →
        // реконнект + ОДИН повтор; ошибки самого инструмента не повторяем —
        // побочные эффекты вызова задвоились бы. Таймаут ответа тоже не
        // ретраится: сервер жив, просто метод долгий
        let first = handle.call_tool(&tool, args.clone()).await;
        let result: String = match first {
            Ok(r) => r,
            Err(e) if mcp::is_transport_err(&e) => {
                // Мёртвый хендл вон из реестра: mcp_status честно покажет
                // «не подключён», следующий вызов сам переподключится
                registry_arc
                    .lock()
                    .map_err(|err| err.to_string())?
                    .remove(&server);
                mcp::note_transport_fail(&server);
                let fresh = mcp::ensure_connected(app.clone(), registry_arc.clone(), server.clone())
                    .await
                    .map_err(|e| format!("mcp {server}.{tool}: reconnect: {e}"))?;
                mcp_attempt!(fresh, args.clone())?
            }
            Err(e) => return Err(format!("mcp {server}.{tool}: {e}")),
        };
        return Ok(result);
    }
    // Vault-инструменты (заметки): чтение, не мутируют — исполним в потоке.
    // arguments (JSON-строка) общий для vault/memory — сериализуем один раз
    let arguments = args.to_string();
    if name.starts_with("vault_") {
        let Some(notes_dir) = notes_dir else {
            return Err("notes directory unavailable".to_string());
        };
        return tauri::async_runtime::spawn_blocking(move || {
            tools::execute_vault_tool(&notes_dir, &name, &arguments)
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }
    // Memory-инструменты: memory_save мутирует (perm-слой отфильтровал выше),
    // memory_recall — чтение. Файл хранилища resolved в run_tool
    if name.starts_with("memory_") {
        let Some(memory_file) = memory_file else {
            return Err("memory storage unavailable".to_string());
        };
        return tauri::async_runtime::spawn_blocking(move || {
            crate::memory::execute_memory_tool(&memory_file, &name, &arguments)
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }
    // Веб-поиск: async HTTP, дубль-проверка тумблера. abort на входе: Stop
    // не должен оставлять «отменённый» запрос в полёте (сам запрос ограничен
    // таймаутом 20с)
    if name == "web_search" {
        if !websearch::config().enabled {
            return Err("Web search is disabled in Settings".to_string());
        }
        if abort_flag
            .as_ref()
            .is_some_and(|f| f.load(std::sync::atomic::Ordering::Relaxed))
        {
            return Err("aborted by user".to_string());
        }
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("missing required argument: query")?
            .to_string();
        let count = args.get("count").and_then(|v| v.as_u64());
        return websearch::execute(&query, count).await;
    }

    // Генерация изображений: асинхронный HTTP, дубль-проверка тумблера.
    // chat_api — текущее подключение из «Подключения к ИИ»: фолбэк, когда
    // вкладка «Генерация изображений» не заполнена
    if name == "image_generate" {
        let prompt = args
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or("missing required argument: prompt")?
            .to_string();
        let size = args
            .get("size")
            .and_then(|v| v.as_str())
            .map(String::from);
        // abort: Stop должен останавливать и генерацию картинок, как любой
        // другой инструмент — иначе «отменённый» шаг висит до ~9 минут
        // и продолжает тратить кредиты API
        return imagegen::generate(
            &data_dir,
            &prompt,
            size.as_deref(),
            chat_api.as_ref(),
            abort_flag.as_deref(),
        )
        .await;
    }
    // Инструменты блокирующие (shell_run — до 300 сек): исполняем в
    // отдельном потоке, иначе главный поток окна замирает на весь таймаут.
    // abort-флаг: Stop убивает процесс немедленно
    tauri::async_runtime::spawn_blocking(move || {
        tools::execute_tool_with_abort(&name, &arguments, abort_flag.as_deref())
    })
    .await
    .map_err(|e| format!("tool task failed: {e}"))?
}

/// Текущий конфиг Browser Use (для вкладки настроек)
#[tauri::command(async)]
pub fn browser_get_config() -> browser::BrowserConfig {
    browser::config()
}

/// Сохранить конфиг Browser Use: в файл + в снапшот; смена пути к браузеру
/// или headless сбрасывает текущее соединение, чтобы настройки применились
#[tauri::command(async)]
pub fn browser_set_config(
    app: tauri::AppHandle,
    registry: tauri::State<'_, browser::BrowserRegistry>,
    config: browser::BrowserConfig,
) -> Result<(), String> {
    let old = browser::config();
    save_json_config(&app, "browser.json", &config)?;
    let exe_changed = old.executable != config.executable;
    let headless_changed = old.headless != config.headless;
    browser::set_config(config);
    if exe_changed || headless_changed {
        registry.kill_all();
    }
    Ok(())
}

#[tauri::command(async)]
pub fn computer_get_config() -> computer::ComputerConfig {
    computer::config()
}

#[tauri::command(async)]
pub fn computer_set_config(
    app: tauri::AppHandle,
    config: computer::ComputerConfig,
) -> Result<(), String> {
    save_json_config(&app, "computer.json", &config)?;
    computer::set_config(config);
    Ok(())
}

#[tauri::command(async)]
pub fn imagegen_get_config() -> imagegen::ImageGenConfig {
    let mut cfg = imagegen::config();
    // На диске и в памяти после старта ключ может лежать зашифрованным —
    // для отображения в настройках расшифровываем, если хранилище открыто
    if crypto::is_encrypted(&cfg.api_key) {
        if let Some(plain) = crypto::decrypt(&cfg.api_key) {
            // Граница serde (поле конфига — String): копия здесь неизбежна
            cfg.api_key = plain.to_string();
        }
    }
    cfg
}

#[tauri::command(async)]
pub fn imagegen_set_config(
    app: tauri::AppHandle,
    config: imagegen::ImageGenConfig,
) -> Result<(), String> {
    // На диск ключ уходит зашифрованным (как ключи settings/profiles),
    // в памяти остаётся открытым текстом для запросов к провайдеру
    let mut for_disk = config.clone();
    if crypto::has_key()
        && !for_disk.api_key.is_empty()
        && !crypto::is_encrypted(&for_disk.api_key)
    {
        for_disk.api_key = crypto::encrypt(&for_disk.api_key)?;
    }
    save_json_config(&app, "imagegen.json", &for_disk)?;
    imagegen::set_config(config);
    Ok(())
}

#[tauri::command(async)]
pub fn websearch_get_config() -> websearch::WebSearchConfig {
    let mut cfg = websearch::config();
    // Ключ Brave шифруется на диске как ключи провайдеров (см. imagegen)
    if crypto::is_encrypted(&cfg.brave_key) {
        if let Some(plain) = crypto::decrypt(&cfg.brave_key) {
            // Граница serde (поле конфига — String): копия здесь неизбежна
            cfg.brave_key = plain.to_string();
        }
    }
    cfg
}

#[tauri::command(async)]
pub fn websearch_set_config(
    app: tauri::AppHandle,
    config: websearch::WebSearchConfig,
) -> Result<(), String> {
    let mut for_disk = config.clone();
    if crypto::has_key()
        && !for_disk.brave_key.is_empty()
        && !crypto::is_encrypted(&for_disk.brave_key)
    {
        for_disk.brave_key = crypto::encrypt(&for_disk.brave_key)?;
    }
    save_json_config(&app, "websearch.json", &for_disk)?;
    websearch::set_config(config);
    Ok(())
}

// ---------- Свои звуки уведомлений ----------

/// Разрешённые расширения своей мелодии + MIME для data URL
pub fn sound_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" => Some("audio/ogg"),
        "m4a" => Some("audio/mp4"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

pub fn sound_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sounds");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Импорт своей мелодии: копия в appdata/sounds/custom.<ext>,
/// возвращает "имя файла|расширение" для отображения
#[tauri::command(async)]
pub async fn sound_import(app: tauri::AppHandle, src: String) -> Result<String, String> {
    rejects_sensitive_path(&src)?;
    // Чтение до 5 МБ + перезапись каталога звуков — в blocking-пул,
    // а не на воркере tokio со стримами (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || sound_import_impl(app, src))
        .await
        .map_err(|e| format!("sound import task failed: {e}"))?
}

fn sound_import_impl(app: tauri::AppHandle, src: String) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    // Обход каталогов через «..» запрещён — путь должен указывать на файл напрямую
    if src_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("invalid source path".into());
    }
    let ext = src_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .ok_or("file has no extension")?;
    sound_mime(&ext).ok_or(format!("unsupported audio format: .{ext}"))?;
    // Лимит ДО чтения: иначе выбранный 10-гигабайтный файл тянулся в память
    // целиком и падал OOM'ом раньше, чем проверка размера успевала сработать
    let meta = fs::metadata(&src_path).map_err(|e| e.to_string())?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("audio file is larger than 5 MB".into());
    }
    let bytes = fs::read(&src_path).map_err(|e| e.to_string())?;
    let dir = sound_path(&app)?;
    // Удаляем старую копию с другим расширением, кладём новую
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("custom.") {
            let _ = fs::remove_file(e.path());
        }
    }
    fs::write(dir.join(format!("custom.{ext}")), bytes).map_err(|e| e.to_string())?;
    let name = src_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "custom".into());
    Ok(format!("{name}|{ext}"))
}

/// Своя мелодия как data URL (для WebAudio/Audio). None — не импортирована
#[tauri::command(async)]
pub async fn sound_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    // Чтение файла мелодии + base64 — в blocking-пул (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || sound_data_impl(app))
        .await
        .map_err(|e| format!("sound data task failed: {e}"))?
}

fn sound_data_impl(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = sound_path(&app)?;
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(ext) = name.strip_prefix("custom.") else { continue };
        let Some(mime) = sound_mime(ext) else { continue };
        let bytes = fs::read(e.path()).map_err(|e| e.to_string())?;
        use base64::Engine as _;
        return Ok(Some(format!(
            "data:{mime};base64,{}",
            B64.encode(bytes)
        )));
    }
    Ok(None)
}

/// Удалить свою мелодию
#[tauri::command(async)]
pub fn sound_delete(app: tauri::AppHandle) -> Result<(), String> {
    let dir = sound_path(&app)?;
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("custom.") {
            let _ = fs::remove_file(e.path());
        }
    }
    Ok(())
}

// ---------- Живой просмотр браузера агента (панель справа) ----------

/// Активна ли трансляция кадров (один поток на всё приложение)
static BROWSER_VIEW_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Поколение трансляции: stop → start гонка, при которой старый поток,
/// проснувшись после сна, видел бы ВЗВЕДЁННЫЙ новым start'ом флаг и жил
/// параллельно с новым (двойной кадр-стрим). Не своё поколение — выход
static BROWSER_VIEW_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Включить трансляцию: поток раз в 400мс снимает кадр агентовского
/// Chromium (Page.captureScreenshot) и шлёт событие browser-frame.
/// Кадры шлём только при изменении; URL — с каждым тиком.
#[tauri::command(async)]
pub fn browser_view_start(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    use std::time::Duration;

    use serde_json::{json, Value};
    if BROWSER_VIEW_ACTIVE.swap(true, Ordering::SeqCst) {
        return Ok(()); // трансляция уже идёт
    }
    let gen = BROWSER_VIEW_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let mut last_frame = String::new();
        while BROWSER_VIEW_ACTIVE.load(Ordering::SeqCst)
            && BROWSER_VIEW_GEN.load(Ordering::SeqCst) == gen
        {
            // Окно-потребитель УНИЧТОЖЕНО (не скрыто в трей — скрытое живо):
            // кадры больше некому доставлять, гасим трансляцию сами
            if app.get_webview_window("main").is_none() {
                BROWSER_VIEW_ACTIVE.store(false, Ordering::SeqCst);
                break;
            }
            let conn = {
                let reg = app.state::<browser::BrowserRegistry>();
                let guard = reg.0.lock().unwrap_or_else(|p| p.into_inner());
                guard.clone()
            };
            let mut payload = json!({ "data": Value::Null, "url": "" });
            if let Some(conn) = conn {
                match conn.view_frame() {
                    Ok((data, url)) => {
                        if data != last_frame {
                            last_frame = data.clone();
                            payload["data"] = json!(data);
                        }
                        payload["url"] = json!(url);
                    }
                    Err(_) => last_frame.clear(),
                }
            } else {
                last_frame.clear();
            }
            // При ошибке кадра — пауза подольше: страница занята/браузер не запущен
            let pause = if payload["data"].is_null() { 1200 } else { 400 };
            // emit_to, не broadcast: кадры браузера слушает только главное окно
            let _ = app.emit_to("main", "browser-frame", payload);
            std::thread::sleep(Duration::from_millis(pause));
        }
    });
    Ok(())
}

#[tauri::command(async)]
pub fn browser_view_stop() {
    BROWSER_VIEW_ACTIVE.store(false, Ordering::SeqCst);
    // Рост поколения гасит и поток, висящий в sleep на момент stop:
    // проснувшись, он увидит чужое поколение и выйдет (см. static)
    BROWSER_VIEW_GEN.fetch_add(1, Ordering::SeqCst);
}

/// Размер вьюпорта агентовского браузера (null/null — вернуть как есть).
/// CDP-запрос блокирующий и мог висеть до 120 с — выполняем в отдельном
/// потоке и режем таймаут до 10 с: смена вьюпорта не должна подвешивать UI
#[tauri::command(async)]
pub async fn browser_view_size(
    app: tauri::AppHandle,
    w: Option<i64>,
    h: Option<i64>,
) -> Result<(), String> {
    use tauri::Manager;
    let conn = {
        let reg = app.state::<browser::BrowserRegistry>();
        let guard = reg.0.lock().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    };
    if let Some(conn) = conn {
        tauri::async_runtime::spawn_blocking(move || conn.set_viewport_short(w, h))
            .await
            .map_err(|e| format!("join error: {e}"))??;
    }
    Ok(())
}

// ---------- Не давать ПК уснуть, пока работает задача (Automations) ----------

#[tauri::command(async)]
pub fn keep_awake(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        // ES_CONTINUOUS привязан к конкретному потоку: вызов в одноразовом
        // std::thread::spawn сбрасывается сразу после его завершения (поток
        // умирает) — фича была no-op. Поэтому держим ОДИН постоянный воркер
        // на весь процесс, а keep_awake лишь шлёт значение в его канал.
        static TX: std::sync::OnceLock<mpsc::Sender<bool>> = std::sync::OnceLock::new();
        let tx = TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<bool>();
            std::thread::spawn(move || keep_awake_worker(rx));
            tx
        });
        tx.send(enable)
            .map_err(|_| "keep-awake worker gone".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = enable; // вне Windows — no-op
        Ok(())
    }
}

/// Постоянный воркер keep_awake: держит ES_CONTINUOUS в своём потоке, чтобы
/// флаг не сбрасывался. enable → держит систему и экран, disable → снимает.
#[cfg(windows)]
pub fn keep_awake_worker(rx: mpsc::Receiver<bool>) {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(esflags: u32) -> u32;
    }
    while let Ok(enable) = rx.recv() {
        let flags = if enable {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        // Результат игнорируем: канал односторонний, вернуть ошибку некуда.
        unsafe { SetThreadExecutionState(flags) };
    }
}
/// Фронт синхронизирует режим разрешений и корни проекта перед первым
/// инструментом прогона (fire-and-forget из handleSend, App.tsx)
#[tauri::command(async)]
pub async fn perm_set(mode: String, roots: Vec<String>) -> Result<(), String> {
    let mode = match mode.as_str() {
        "plan" => perm::PermMode::Plan,
        "ask" => perm::PermMode::Ask,
        "edit" => perm::PermMode::Edit,
        "full" => perm::PermMode::Full,
        other => return Err(format!("unknown permission mode: {other}")),
    };
    // Канонизация корней — один раз здесь (FS-работа в blocking-пул; на
    // сетевом корне висела бы до таймаута), а не на каждый fs_* вызов
    let roots_for_canon = roots.clone();
    let roots_canon = tauri::async_runtime::spawn_blocking(move || {
        perm::canonicalize_roots(&roots_for_canon)
    })
    .await
    .map_err(|e| format!("perm task failed: {e}"))?;
    perm::set(perm::PermState { mode, roots, roots_canon, synced: true });
    Ok(())
}

#[tauri::command(async)]
pub fn get_tool_schemas(
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
) -> serde_json::Value {
    let builtin = tools::tool_schemas();
    let vault = tools::vault_tool_schemas();
    let mut merged = mcp_registry.tool_schemas_merged(builtin);
    if let Some(arr) = merged.as_array_mut() {
        if let Some(extra) = vault.as_array() {
            arr.extend(extra.iter().cloned());
        }
        // Долговременная память: факты (фронт фильтрует по своему тумблеру)
        if let Some(extra) = crate::memory::memory_tool_schemas().as_array() {
            arr.extend(extra.iter().cloned());
        }
        if browser::config().enabled {
            let extra = browser::browser_tool_schemas()
                .as_array()
                .cloned()
                .unwrap_or_default();
            arr.extend(extra);
        }
        if computer::config().enabled {
            let extra = computer::computer_tool_schemas()
                .as_array()
                .cloned()
                .unwrap_or_default();
            arr.extend(extra);
        }
        // Генерация изображений: только при включённом тумблере
        if imagegen::config().enabled {
            arr.push(imagegen::imagegen_tool_schema());
        }
        // Веб-поиск: только при включённом тумблере
        if websearch::config().enabled {
            arr.push(websearch::websearch_tool_schema());
        }
        // Фронтовые инструменты: исполнение целиком на вебвью (App.tsx),
        // Rust отдаёт только схемы
        arr.extend(frontend_tool_schemas());
    }
    merged
}

/// Схемы инструментов, которые исполняются на фронтенде, а не в Rust:
/// субагенты, план задач и вопрос пользователю (ask_user)
pub fn frontend_tool_schemas() -> Vec<serde_json::Value> {
    vec![
        // Субагенты: исполнение на фронтенде (вложенный цикл в App), но
        // схема должна быть в списке, чтобы главный агент мог вызвать
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "subagent_run",
                "description": "Run a subagent: an isolated agent with its own role, context and tool allowlist. It returns a final report. Use for research, coding subtasks, review (critic) or repo navigation. Depth is 1 — a subagent cannot spawn subagents. With background=true the call returns immediately (id bg-N), the subagent works in parallel, and the report lands in this conversation when ready — check progress anytime with subagent_status.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "role": {
                            "type": "string",
                            "description": "Subagent role id: researcher (web/read-only), coder (fs/shell), critic (review, no tools), librarian (repo navigation) — or any custom role id configured in Settings → Subagents / plugins"
                        },
                        "task": {
                            "type": "string",
                            "description": "Self-contained brief for the subagent: what to do, where to look, what to return. It does NOT see this conversation."
                        },
                        "background": {
                            "type": "boolean",
                            "description": "Run in background: return immediately and keep working in parallel. The report is appended to this conversation on completion; poll subagent_status for progress"
                        }
                    },
                    "required": ["role", "task"]
                }
            }
        }),
        // Статус/отчёт фоновых субагентов: исполнение на фронтенде (реестр
        // фоновых задач в useAgentRun), Rust — только схема
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "subagent_status",
                "description": "Status of background subagents. Without id: a list of all background tasks with statuses. With id: running progress, or the FULL final report of a completed subagent.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Background task id, e.g. \"bg-1\"" }
                    }
                }
            }
        }),
        // Workflow-оркестратор v1 (блок 12 шаг 6): исполнение на фронтенде
        // (шаги — субагенты через runSubagent), Rust — только схема
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "workflow_run",
                "description": "Run a named workflow: an ordered scenario of subagent steps. Each step is executed as a subagent; its final report becomes a variable, later steps reference earlier outputs with {{stepId}} in their prompt. A failed step stops the scenario unless the step has continueOnError=true. Use for repeatable multi-part tasks (research then code then review).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "workflow": {
                            "type": "object",
                            "description": "Scenario definition {name, steps:[{id, prompt, role?, continueOnError?}]}. id — [a-zA-Z0-9_-] up to 32 chars, used as the variable name; role — a known subagent role id (researcher/coder/critic/librarian or a custom one); prompt may reference earlier step outputs as {{stepId}}",
                            "properties": {
                                "name": { "type": "string" },
                                "steps": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "id": { "type": "string" },
                                            "prompt": { "type": "string" },
                                            "role": { "type": "string" },
                                            "continueOnError": { "type": "boolean" }
                                        },
                                        "required": ["id", "prompt"]
                                    }
                                }
                            },
                            "required": ["name", "steps"]
                        }
                    },
                    "required": ["workflow"]
                }
            }
        }),
        // План задач: исполнение целиком на фронтенде (App парсит tasks и
        // обновляет виджет Progress в чате), Rust нужен только как схема
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "plan_update",
                "description": "Create or update the task plan shown to the user. Call it when starting a multi-step task and after each task status change. Tasks: [{title, status}]. status: pending | in_progress | done",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tasks": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": { "type": "string" },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "done"]
                                    }
                                },
                                "required": ["title", "status"]
                            }
                        }
                    },
                    "required": ["tasks"]
                }
            }
        }),
        // Вопрос пользователю: блокирующий выбор из вариантов, ответ —
        // tool result. Схема всегда в списке у главного агента
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "ask_user",
                "description": "Ask the user a blocking question with structured options — ONLY when the decision is truly theirs (scope of work, approach, trade-offs, anything you cannot resolve yourself) and the answer changes what you do next. Do NOT use it for facts you can look up, trivial choices with a conventional default, or to ask permission to proceed. Returns the selected option labels and optional free-text notes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "The complete question, specific and self-contained. Simple markdown allowed (bold, `code`)"
                        },
                        "header": {
                            "type": "string",
                            "description": "Very short label for the question chip (max ~12 chars), e.g. 'Auth method'"
                        },
                        "options": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 4,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {
                                        "type": "string",
                                        "description": "Concise option title (1-5 words). For the recommended option, append ' (Recommended)'"
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "What this option means, its trade-offs. One short paragraph"
                                    },
                                    "preview": {
                                        "type": "string",
                                        "description": "Optional monospace preview (code snippet, mockup, config) shown next to the focused option. Single-select questions only"
                                    }
                                },
                                "required": ["label"]
                            }
                        },
                        "multiSelect": {
                            "type": "boolean",
                            "description": "Allow the user to select several options"
                        }
                    },
                    "required": ["question", "options"]
                }
            }
        }),
    ]
}

/// История задач: таскаем целиком как JSON-строку, чтобы не дублировать типы.
#[tauri::command(async)]
pub fn load_sessions(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = config_file(&app, "sessions.json")?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub async fn save_sessions(app: tauri::AppHandle, data: String) -> Result<(), String> {
    // Автосейв после каждого сообщения: запись многометрового sessions.json
    // на воркере tokio вставала поперёк SSE-стримов — в blocking-пул
    // (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "sessions.json")?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        crate::fsutil::atomic_write(&path, data.as_bytes())
    })
    .await
    .map_err(|e| format!("sessions save task failed: {e}"))?
}

/// Хранилище проекта в его папке: <root>/.nocturn. root — выбранная
/// пользователем папка проекта; sensitive-path гард закрывает системные
/// локации. create=false (чтение) не создаёт папку на диске
fn project_store_dir(root: &str, create: bool) -> Result<std::path::PathBuf, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("project root is empty".into());
    }
    crate::settings::rejects_sensitive_path(root)?;
    let dir = std::path::Path::new(root).join(".nocturn");
    if create {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    } else if !dir.is_dir() {
        return Err("project store does not exist".into());
    }
    Ok(dir)
}

/// Сессии проекта: читаются из <root>/.nocturn/sessions.json (ZCode-стиль —
/// данные проекта живут в папке проекта). Нет файла — None
#[tauri::command(async)]
pub async fn load_project_sessions(root: String) -> Result<Option<String>, String> {
    // Отказ sensitive-path-гардала — не «хранилища нет»: наружу Err, чтобы
    // системный отказ не маскировался пустым ответом (project_store_dir оба
    // случая неразличим). Пустой корень — ошибка контракта, как и раньше
    let root = root.trim();
    if root.is_empty() {
        return Err("project root is empty".into());
    }
    crate::settings::rejects_sensitive_path(root)?;
    let dir = std::path::Path::new(root).join(".nocturn");
    if !dir.is_dir() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = dir.join("sessions.json");
        if !path.exists() {
            return Ok(None);
        }
        fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("blocking task failed: {e}"))?
}

/// Сессии проекта: атомарная запись в <root>/.nocturn/sessions.json
#[tauri::command(async)]
pub fn save_project_sessions(root: String, data: String) -> Result<(), String> {
    let dir = project_store_dir(&root, true)?;
    crate::fsutil::atomic_write(&dir.join("sessions.json"), data.as_bytes())
}

/// Обои чата: разрешить вебвью читать выбранное изображение через
/// asset-протокол (по образцу ambient_video_register)
// (async): Path::exists() на отвалившемся сетевом диске висит до SMB-таймаута —
// sync-команда исполнялась на главном потоке и морозила GUI
#[tauri::command(async)]
pub fn wallpaper_register(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Путь с фронта → тот же sensitive-path гардал, что у sound_import:
    // allow_file расширяет asset-скоуп вебвью на произвольный файл
    rejects_sensitive_path(&path)?;
    const OK: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or("file has no extension")?;
    if !OK.contains(&ext.as_str()) {
        return Err(format!("unsupported image format: .{ext} (use png/jpg/webp/gif)"));
    }
    if !std::path::Path::new(&path).exists() {
        return Err("file does not exist".into());
    }
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| format!("cannot allow wallpaper file: {e}"))
}

/// Ambient: разрешить вебвью читать выбранное пользователем видео через
/// asset-протокол. Скоуп расширяется ТОЧКО на выбранный файл (allow_file) —
/// никаких широких "**"-разрешений; расширение проверяем по whitelist.
// (async): см. wallpaper_register — fs-доступ вне главного потока
#[tauri::command(async)]
pub fn ambient_video_register(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Путь с фронта → тот же sensitive-path гардал, что у sound_import
    rejects_sensitive_path(&path)?;
    // ogv/mkv убраны: Chromium-движок (WebView2) не играет Matroska/Theora
    // в <video> — пользователь получал тихо пустой слой вместо ошибки.
    // Linux/WebKitGTK: mp4/mov/m4v требуют GStreamer gst-libav — в
    // минимальных установках видео молча не играет, webm надёжнее
    const OK: &[&str] = &["mp4", "webm", "mov", "m4v"];
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or("file has no extension")?;
    if !OK.contains(&ext.as_str()) {
        return Err(format!("unsupported video format: .{ext} (use mp4/webm)"));
    }
    if !std::path::Path::new(&path).exists() {
        return Err("file does not exist".into());
    }
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| format!("cannot allow video file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_tool_schemas_are_wellformed() {
        let schemas = frontend_tool_schemas();
        let name_of = |v: &serde_json::Value| v["function"]["name"].as_str().unwrap().to_string();
        let names: Vec<String> = schemas.iter().map(name_of).collect();
        assert!(names.contains(&"subagent_run".to_string()));
        assert!(names.contains(&"workflow_run".to_string()));
        assert!(names.contains(&"plan_update".to_string()));
        assert!(names.contains(&"ask_user".to_string()));

        let ask = schemas
            .iter()
            .find(|v| name_of(v) == "ask_user")
            .unwrap()
            .clone();
        let params = &ask["function"]["parameters"];
        // Обязательные поля вопроса и опций; границы количества опций
        assert_eq!(params["required"], serde_json::json!(["question", "options"]));
        let props = &params["properties"];
        assert_eq!(
            props["options"]["items"]["required"],
            serde_json::json!(["label"])
        );
        assert_eq!(props["options"]["minItems"], serde_json::json!(2));
        assert_eq!(props["options"]["maxItems"], serde_json::json!(4));
        // multiSelect и preview объявлены (v2-поля, схема должна их нести)
        assert!(props.get("multiSelect").is_some());
        assert!(props["options"]["items"]["properties"]
            .get("preview")
            .is_some());
    }

    #[test]
    fn user_disabled_tool_is_rejected() {
        let disabled = Some(vec!["shell_run".to_string(), "mcp__x__y".to_string()]);
        assert!(ensure_not_user_disabled("fs_read", &disabled).is_ok());
        assert!(ensure_not_user_disabled("shell_run", &disabled).is_err());
        assert!(ensure_not_user_disabled("mcp__x__y", &disabled).is_err());
        // Нет списка / пустой список — всё разрешено
        assert!(ensure_not_user_disabled("shell_run", &None).is_ok());
        assert!(ensure_not_user_disabled("shell_run", &Some(vec![])).is_ok());
        // Сообщение показывает имя и подсказывает продолжить без него
        let err = ensure_not_user_disabled("shell_run", &disabled).unwrap_err();
        assert!(err.contains("shell_run"));
        assert!(err.contains("disabled by the user"));
    }
}
