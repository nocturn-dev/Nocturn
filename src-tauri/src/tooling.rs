//! Исполнение инструментов агента (run_tool), схемы инструментов,
//! серверный слой прав (perm_set), конфиги browser/computer/imagegen,
//! звуки уведомлений, keep-awake, история сессий.

use crate::crypto;
use crate::notes::notes_dir;
use crate::perm;
use crate::settings::{config_file, rejects_sensitive_path, save_json_config};
use crate::mcp_oauth;
use crate::{browser, computer, hooks, imagegen, lsp, mcp, tools, websearch};
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
/// По пути прогоняются хуки PreToolUse (может заблокировать; additionalContext
/// дописывается к результату) и PostToolUse (additionalContext к результату).
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

/// Склейка результата инструмента с additionalContext хуков. PreToolUse-контекст
/// собирается до исполнения и раньше терялся: парсер hooks.rs отдаёт его для
/// обоих событий, а run_tool потреблял только PostToolUse. Смысл тот же, что у
/// PostToolUse: подмешать модели текст хука рядом с результатом (у ошибочного
/// вызова контекста нет — блокирующий хук доносит причину через reason).
fn append_hook_context(result: String, pre: &[String], post: &[String]) -> String {
    let mut extra: Vec<String> = Vec::new();
    if !pre.is_empty() {
        extra.push(format!("[pre-hook context]\n{}", pre.join("\n")));
    }
    if !post.is_empty() {
        extra.push(format!("[hook context]\n{}", post.join("\n")));
    }
    if extra.is_empty() {
        result
    } else {
        format!("{result}\n\n{}", extra.join("\n"))
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
    // shell_run — без path-контроля (cwd опционален), но его КОМАНДА едет в
    // perm как аргумент матчинга deny-правил (волна E1)
    {
        let perm_arg = if name.starts_with("fs_") || name == "diagnostics" {
            args.get("path").and_then(|v| v.as_str()).map(str::to_string)
        } else if name == "shell_run" {
            args.get("command")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        } else {
            None
        };
        let state = perm::current();
        let tool = name.clone();
        // Канонизация пути в perm ходит по ФС (вплоть до сетевых корней): в
        // blocking-пул, иначе на tokio-воркере это вставало поперёк всех
        // SSE-стримов (класс бага, уже починенный для load_settings/CA_PEM)
        tauri::async_runtime::spawn_blocking(move || {
            perm::decide(&state, &tool, perm_arg.as_deref())
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
    // на выходе; чужую запись (живой стрим) не трогаем, её чистит AbortGuard.
    // Снятие — только если в map всё ещё лежит ИМЕННО наш флаг: между
    // созданием и drop-ом стрим с тем же request_id мог подменить слот
    // своим (ptr_eq-семантика, как у AbortGuard в chat.rs)
    struct ToolAbortGuard<'a> {
        registry: &'a crate::chat::AbortRegistry,
        request_id: Option<String>,
        created: bool,
        flag: Option<std::sync::Arc<AtomicBool>>,
    }
    impl Drop for ToolAbortGuard<'_> {
        fn drop(&mut self) {
            if self.created {
                if let (Some(id), Some(flag)) = (&self.request_id, &self.flag) {
                    if let Ok(mut map) = self.registry.0.lock() {
                        if map
                            .get(id)
                            .is_some_and(|f| std::sync::Arc::ptr_eq(f, flag))
                        {
                            map.remove(id);
                        }
                    }
                }
            }
        }
    }
    let _tool_abort_guard = ToolAbortGuard {
        registry: &abort_registry,
        request_id: request_id.clone(),
        created: tool_abort_created,
        flag: abort_flag.clone(),
    };

    // Хуки PreToolUse: любой с decision=block (или ненулевым exit) блокирует вызов
    let mut pre_context: Vec<String> = Vec::new();
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
            if !out.additional_context.is_empty() {
                pre_context.push(out.additional_context);
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

    // notes_dir (fs::create_dir_all) нужен только vault-инструментам. Резолв
    // — в blocking-пул, как и load_settings ниже: sync-ФС на tokio-воркере
    // вставал поперёк стримов на медленном/сетевом диске
    let notes = if name.starts_with("vault_") {
        let app_for_notes = app.clone();
        Some(
            tauri::async_runtime::spawn_blocking(move || notes_dir(&app_for_notes))
                .await
                .map_err(|e| format!("notes dir task failed: {e}"))??,
        )
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
        crate::settings::load_settings_blocking(&app_for_settings)
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
        let post: Vec<String> = outs
            .iter()
            .filter(|o| !o.additional_context.is_empty())
            .map(|o| o.additional_context.clone())
            .collect();
        Ok(append_hook_context(result, &pre_context, &post))
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
        // ретраится: сервер жив, просто метод долгий. select! с abort —
        // как у ретрая: раньше Stop ждал завершения первой попытки до
        // 120 с (кап был только внутренний, у вызова abort-ветки не было)
        let first = tokio::select! {
            res = handle.call_tool(&tool, args.clone()) => res.map_err(|e| format!("mcp {server}.{tool}: {e}")),
            _ = tokio::time::sleep(MCP_TOOL_TIMEOUT) => Err(format!(
                "mcp {server}.{tool}: timed out after {}s",
                MCP_TOOL_TIMEOUT.as_secs()
            )),
            _ = wait_for_abort(abort_flag.as_ref()) => {
                return Err("aborted by user".to_string());
            }
        };
        let result: String = match first {
            Ok(r) => r,
            Err(e) if e.contains("HTTP 401") && mcp_oauth::has_meta(&server) => {
                // Волна F5: 401 на oauth-сервере — запрос НЕ исполнялся
                // (auth-гейт), поэтому повтор безопасен. Refresh single-flight:
                // ровно один запрос к провайдеру, остальные ждут новый токен
                mcp_oauth::refresh_single_flight(&server)
                    .await
                    .map_err(|re| format!("mcp {server}.{tool}: token refresh failed: {re}"))?;
                handle
                    .call_tool(&tool, args.clone())
                    .await
                    .map_err(|e| format!("mcp {server}.{tool}: {e}"))?
            }
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
            Err(e) if mcp::is_session_expired(&e) => {
                // Волна F2: сессия удалённого сервера истекла — невидимый
                // реконнект (drop + ensure_connected), повтор инициирует сама
                // модель следующим вызовом (аннотаций readOnlyHint нет,
                // авто-повтор задвоил бы побочные эффекты)
                registry_arc
                    .lock()
                    .map_err(|err| err.to_string())?
                    .remove(&server);
                mcp::ensure_connected(app.clone(), registry_arc.clone(), server.clone())
                    .await
                    .map_err(|e| format!("mcp {server}.{tool}: reconnect: {e}"))?;
                return Err(format!(
                    "mcp {server}.{tool}: session expired, server reconnected — retry the call"
                ));
            }
            Err(e) => return Err(e),
        };
        return Ok(result);
    }
    // Волна F4: discover отложенных MCP-схем — чтение реестра, не мутация
    if name == "mcp_tool_discover" {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let found = mcp_registry.discover_tools(query);
        if found.is_empty() {
            return Ok(format!(
                "no MCP tools matched \"{query}\" — the server may be offline or the query too narrow"
            ));
        }
        return serde_json::to_string(&found).map_err(|e| e.to_string());
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

    // LSP-диагностики: блокирующий клиент (спавн сервера, ожидание
    // publishDiagnostics) — в blocking-пул, Stop гасит ожидание через select!
    if name == "diagnostics" {
        if !lsp::config().enabled {
            return Err("LSP diagnostics is disabled in Settings".to_string());
        }
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("missing required argument: path")?
            .to_string();
        let work = tauri::async_runtime::spawn_blocking(move || {
            lsp::diagnostics_for_file(&path, lsp::DIAG_WAIT_TOOL, lsp::SETTLE_MIN_TOOL)
        });
        return tokio::select! {
            res = work => res.map_err(|e| format!("tool task failed: {e}"))?,
            _ = wait_for_abort(abort_flag.as_ref()) => {
                Err("aborted by user".to_string())
            }
        };
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
    // GGUF Lab (§28 шаг 6): inspect/cut/test — команда сама знает, как
    // стримить прогресс; cut/test мутирующие (гарды perm.rs отработали
    // ДО этого вызова — гардалы ставятся до PreToolUse-хуков).
    // Stop обязан отвечать сразу и здесь (аудит 07.10 A1-10: единственная
    // ветка диспетчера без select! — Stop висел минуты, операция писала
    // гигабайты после отмены прогона). При отмене дёргаем кооперативный
    // GGUF_CANCEL — циклы операции выходят между чанками и чистят tmp, —
    // и гасим тестовый сервер (health-поллинг gguf_test умирает мгновенно)
    if name == "gguf_inspect" || name == "gguf_cut" || name == "gguf_test" {
        let work = crate::gguf::run_agent_tool(&app, &name, &args);
        return tokio::select! {
            res = work => res,
            _ = wait_for_abort(abort_flag.as_ref()) => {
                crate::gguf::gguf_cancel();
                let _ = crate::gguf::gguf_serve_stop();
                Err("aborted by user".to_string())
            }
        };
    }
    // Инструменты блокирующие (shell_run — до 300 сек, fs-вызовы — ФС):
    // исполняем в отдельном потоке, иначе главный поток окна замирает на
    // весь таймаут. Stop обязан отвечать сразу: select! с abort — как у
    // computer/browser-веток выше (аудит: зависший fs-вызов держал шаг
    // агента без ответа даже после Stop)
    let work = tauri::async_runtime::spawn_blocking({
        // Клон Arc для closure: сам флаг нужен живым в select! ниже.
        // Имя инструмента клонируется: после ветки исполнения LSP-фидбек
        // сверяет name == "fs_write" на исходном значении
        let name_for_work = name.clone();
        let abort_for_work = abort_flag.clone();
        move || tools::execute_tool_with_abort(&name_for_work, &arguments, abort_for_work.as_deref())
    });
    let mut result: String = tokio::select! {
        res = work => res.map_err(|e| format!("tool task failed: {e}"))??,
        _ = wait_for_abort(abort_flag.as_ref()) => {
            return Err("aborted by user".to_string());
        }
    };
    // LSP-фидбек после правки: диагностики правленного файла дописываются к
    // результату fs_write в том же turn'е (модель видит ошибки сразу). Лучшее
    // усилие в blocking-пуле: любая ошибка LSP молча возвращает результат как есть
    if name == "fs_write" && lsp::feedback_enabled() {
        let for_feedback = result.clone();
        result = tauri::async_runtime::spawn_blocking(move || lsp::edit_feedback(&for_feedback))
            .await
            .unwrap_or(result);
    }
    Ok(result)
}

/// Текущий конфиг Browser Use (для вкладки настроек)
#[tauri::command(async)]
pub fn browser_get_config() -> browser::BrowserConfig {
    browser::config()
}

/// Сохранить конфиг Browser Use: в файл + в снапшот; смена пути к браузеру
/// или headless сбрасывает текущее соединение, чтобы настройки применились
#[tauri::command(async)]
pub async fn browser_set_config(
    app: tauri::AppHandle,
    config: browser::BrowserConfig,
) -> Result<(), String> {
    // kill_all ждёт wait() на каждом живом браузере, запись конфига может
    // тянуть сетевой профиль — всё в blocking-пул. State в 'static-замыкание
    // не утащить — реестр берём из app внутри
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let old = browser::config();
        save_json_config(&app, "browser.json", &config)?;
        let exe_changed = old.executable != config.executable;
        let headless_changed = old.headless != config.headless;
        browser::set_config(config);
        if exe_changed || headless_changed {
            app.state::<browser::BrowserRegistry>().kill_all();
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("browser config task failed: {e}"))?
}

#[tauri::command(async)]
pub fn computer_get_config() -> computer::ComputerConfig {
    computer::config()
}

#[tauri::command(async)]
pub async fn computer_set_config(
    app: tauri::AppHandle,
    config: computer::ComputerConfig,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_json_config(&app, "computer.json", &config)?;
        computer::set_config(config);
        Ok(())
    })
    .await
    .map_err(|e| format!("computer config task failed: {e}"))?
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
pub async fn imagegen_set_config(
    app: tauri::AppHandle,
    config: imagegen::ImageGenConfig,
) -> Result<(), String> {
    // На диск ключ уходит зашифрованным (как ключи settings/profiles),
    // в памяти остаётся открытым текстом для запросов к провайдеру
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("imagegen config task failed: {e}"))?
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
pub async fn websearch_set_config(
    app: tauri::AppHandle,
    config: websearch::WebSearchConfig,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("websearch config task failed: {e}"))?
}

// ---------- LSP-диагностики (инструмент diagnostics, настройки) ----------

#[tauri::command(async)]
pub fn lsp_get_config() -> lsp::LspConfig {
    lsp::config()
}

#[tauri::command(async)]
pub async fn lsp_set_config(
    app: tauri::AppHandle,
    config: lsp::LspConfig,
) -> Result<(), String> {
    // Запись lsp.json — ФС на возможном сетевом профиле: blocking-пул
    // (класс crypto_status); снапшот обновляется только после записи,
    // упавший сет-колл не оставляет UI врать об активном тумблере
    tauri::async_runtime::spawn_blocking(move || {
        save_json_config(&app, "lsp.json", &config)?;
        lsp::set_config(config);
        Ok(())
    })
    .await
    .map_err(|e| format!("lsp config task failed: {e}"))?
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
pub async fn sound_delete(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = sound_path(&app)?;
        for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("custom.") {
                let _ = fs::remove_file(e.path());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("sound delete task failed: {e}"))?
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
/// Фронт синхронизирует режим разрешений, корни проекта и правила прав
/// перед первым инструментом прогона (fire-and-forget из handleSend)
#[tauri::command(async)]
pub async fn perm_set(
    app: tauri::AppHandle,
    mode: String,
    roots: Vec<String>,
    rules: Option<perm::PermRules>,
) -> Result<(), String> {
    use tauri::Manager;
    let mode = match mode.as_str() {
        "plan" => perm::PermMode::Plan,
        "ask" => perm::PermMode::Ask,
        "edit" => perm::PermMode::Edit,
        "full" => perm::PermMode::Full,
        other => return Err(format!("unknown permission mode: {other}")),
    };
    // Волна E1: валидация правил fail-closed — битое правило отвергает весь
    // perm_set, защита «not synchronized» держит мутации до починки списка
    let rules = rules.unwrap_or_default();
    let known = known_tool_names();
    for r in &rules.allow {
        perm::validate_rule(r, true, &known)?;
    }
    for r in rules.deny.iter().chain(rules.always_ask.iter()) {
        perm::validate_rule(r, false, &known)?;
    }
    // Канонизация корней и config-dir — один раз здесь (FS-работа в
    // blocking-пул; на сетевом корне висела бы до таймаута), а не на каждый
    // fs_* вызов. config-dir — самозащита конфига (волна E3)
    let roots_for_canon = roots.clone();
    let app_for_cfg = app.clone();
    let (roots_canon, config_dir) = tauri::async_runtime::spawn_blocking(move || {
        let roots_canon = perm::canonicalize_roots(&roots_for_canon);
        let config_dir = app_for_cfg
            .path()
            .app_config_dir()
            .ok()
            .map(|d| perm::norm_canonical_path(&d.to_string_lossy()));
        (roots_canon, config_dir)
    })
    .await
    .map_err(|e| format!("perm task failed: {e}"))?;
    perm::set(perm::PermState {
        mode,
        roots,
        roots_canon,
        synced: true,
        rules,
        config_dir,
    });
    Ok(())
}

/// Реестр builtin-имён для валидации правил (волна E1): собирается из тех же
/// источников, что get_tool_schemas — новый источник схем = добавить сюда.
/// mcp-имена правилами допускаются по форме (сервер может быть ещё офлайн)
fn known_tool_names() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let mut push = |schemas: &serde_json::Value| {
        let items: Vec<&serde_json::Value> = match schemas {
            serde_json::Value::Array(arr) => arr.iter().collect(),
            v if v.is_object() => vec![v],
            _ => vec![],
        };
        for s in items {
            if let Some(n) = s["function"]["name"].as_str() {
                set.insert(n.to_string());
            }
        }
    };
    push(&tools::tool_schemas());
    push(&tools::vault_tool_schemas());
    push(&crate::memory::memory_tool_schemas());
    push(&browser::browser_tool_schemas());
    push(&computer::computer_tool_schemas());
    push(&websearch::websearch_tool_schema());
    push(&imagegen::imagegen_tool_schema());
    push(&lsp::lsp_tool_schema());
    push(&crate::gguf::gguf_tool_schemas());
    for s in frontend_tool_schemas() {
        if let Some(n) = s["function"]["name"].as_str() {
            set.insert(n.to_string());
        }
    }
    // Волна F4: discover-инструмент в схемах появляется условно (есть
    // MCP-серверы) — в реестр валидации добавляем всегда
    set.insert("mcp_tool_discover".to_string());
    set
}

#[tauri::command(async)]
pub fn get_tool_schemas(
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
    deferred: Option<bool>,
) -> serde_json::Value {
    // Волна F4: deferred-схемы (вердикт владельца — ON по умолчанию)
    let deferred = deferred.unwrap_or(true);
    let builtin = tools::tool_schemas();
    let vault = tools::vault_tool_schemas();
    let mut merged = mcp_registry.tool_schemas_merged(builtin, deferred);
    if let Some(arr) = merged.as_array_mut() {
        if let Some(extra) = vault.as_array() {
            arr.extend(extra.iter().cloned());
        }
        // Долговременная память: факты (фронт фильтрует по своему тумблеру)
        if let Some(extra) = crate::memory::memory_tool_schemas().as_array() {
            arr.extend(extra.iter().cloned());
        }
        // Волна F4: discover-инструмент — когда есть хотя бы один MCP-сервер
        if !mcp_registry.0.lock().unwrap_or_else(|p| p.into_inner()).is_empty() {
            arr.push(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "mcp_tool_discover",
                    "description": "Search deferred MCP tools by keyword (matches tool names and descriptions). Returns the FULL schemas of matching tools (max 10). Call it when an MCP tool you need has a DEFERRED schema.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "Keywords, e.g. \"github issue\" or \"screenshot\"" }
                        },
                        "required": ["query"]
                    }
                }
            }));
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
        // LSP-диагностики: только при включённом тумблере
        if lsp::config().enabled {
            arr.push(lsp::lsp_tool_schema());
        }
        // GGUF Lab: inspect/cut/test (cut/test — mutating в perm.rs+toolFilter)
        if let Some(extra) = crate::gguf::gguf_tool_schemas().as_array() {
            arr.extend(extra.iter().cloned());
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
        // Скиллы как форк-прогон ([P12]): исполнение на фронтенде; доступные
        // скиллы перечислены модели в system-блоке (whenToUse/описание)
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "skill_run",
                "description": "Run a configured skill as an isolated subagent run: it executes the skill instruction with its own context and tool allowlist and returns the complete result. Available skills (id + when to use one) are listed in the system prompt — do not guess ids.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "skill": {
                            "type": "string",
                            "description": "Skill id from the available-skills list, e.g. \"wiki\""
                        },
                        "args": {
                            "type": "string",
                            "description": "Task material appended to the skill instruction: the code, topic or text the skill should process"
                        }
                    },
                    "required": ["skill"]
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
pub async fn load_sessions(app: tauri::AppHandle) -> Result<Option<String>, String> {
    // sessions.json может быть многометровым, профиль AppData — сетевым:
    // чтение в blocking-пул (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "sessions.json")?;
        if !path.exists() {
            return Ok(None);
        }
        fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("sessions load task failed: {e}"))?
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
    let root = root.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // Проект может жить на сетевом ресурсе: stat корня — такой же
        // сетевой вызов, как чтение файла, и обязан жить в blocking-пуле
        // (класс crypto_status), иначе отвалившийся SMB вешает tokio-воркер
        // на каждом переключении проекта
        let dir = std::path::Path::new(&root).join(".nocturn");
        if !dir.is_dir() {
            return Ok(None);
        }
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
pub async fn save_project_sessions(root: String, data: String) -> Result<(), String> {
    // Проект может жить на сетевом ресурсе: create_dir_all + запись —
    // в blocking-пул (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        let dir = project_store_dir(&root, true)?;
        crate::fsutil::atomic_write(&dir.join("sessions.json"), data.as_bytes())
    })
    .await
    .map_err(|e| format!("project sessions save task failed: {e}"))?
}

/// Обои чата: разрешить вебвью читать выбранное изображение через
/// asset-протокол (по образцу ambient_video_register)
#[tauri::command(async)]
pub async fn wallpaper_register(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // exists() на отвалившемся сетевом диске висит до SMB-таймаута:
    // проверка пути + allow_file — в blocking-пул, не на tokio-воркер
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("wallpaper register task failed: {e}"))?
}

/// Ambient: разрешить вебвью читать выбранное пользователем видео через
/// asset-протокол. Скоуп расширяется ТОЧКОЙ на выбранный файл (allow_file) —
/// никаких широких "**"-разрешений; расширение проверяем по whitelist.
#[tauri::command(async)]
pub async fn ambient_video_register(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // exists() на сетевом пути висит до SMB-таймаута — см. wallpaper_register
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("ambient video register task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perm_gates_before_pre_tool_use_hooks() {
        // Волна G: механический регресс порядка гардалов run_tool — perm-слой
        // решает РАНЬШЕ PreToolUse-хуков, заблокированный Plan-вызов не должен
        // запускать shell-команды хуков. Тест привязан к текущему форматированию
        // (стиль зеркала toolFilter.test.ts): сдвинешь порядок — упадёт громко
        const SRC: &str = include_str!("tooling.rs");
        let perm = SRC
            .find("perm::decide(&state")
            .expect("perm::decide call site");
        let hooks = SRC
            .find("hooks::run_event_with_abort(")
            .expect("PreToolUse call site");
        assert!(perm < hooks, "perm must gate before PreToolUse hooks");
    }

    #[test]
    fn mcp_error_routing_markers_exist_in_producer() {
        // Стык mcp.rs↔tooling.rs склеен ТЕКСТОМ ошибки: tooling маршрутизирует
        // oauth-refresh (401) и реконнект (404/-32001) по подстрокам, которые
        // производит format! в mcp.rs. Правка формата одной стороны без
        // другой = молчаливое отключение авто-refresh/реконнекта (аудит
        // 2026-10-04). Тест привязан к литералам — рассинхрон упадёт громко
        const MCP: &str = include_str!("mcp.rs");
        const SELF: &str = include_str!("tooling.rs");
        for (produced, routed) in [("HTTP {}: {}", "HTTP 401"), ("HTTP {}: {}", "HTTP 404")] {
            assert!(MCP.contains(produced), "mcp.rs must produce {produced:?}");
            assert!(SELF.contains(routed), "tooling.rs must route on {routed:?}");
        }
        // Сессионная семантика — уже типизированная: mcp::is_session_expired
        // обязан существовать, чтобы новые ветки не возвращались к подстрокам
        assert!(MCP.contains("pub fn is_session_expired"));
    }

    #[test]
    fn frontend_tool_schemas_are_wellformed() {
        let schemas = frontend_tool_schemas();
        let name_of = |v: &serde_json::Value| v["function"]["name"].as_str().unwrap().to_string();
        let names: Vec<String> = schemas.iter().map(name_of).collect();
        assert!(names.contains(&"subagent_run".to_string()));
        assert!(names.contains(&"workflow_run".to_string()));
        assert!(names.contains(&"plan_update".to_string()));
        assert!(names.contains(&"ask_user".to_string()));
        assert!(names.contains(&"skill_run".to_string()));

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

    #[test]
    fn hook_context_appends_pre_and_post() {
        // Регресс: additionalContext PreToolUse-хуков парсился, но терялся —
        // к результату дописывался только PostToolUse
        assert_eq!(append_hook_context("res".into(), &[], &[]), "res");
        assert_eq!(
            append_hook_context("res".into(), &["pre1".to_string()], &[]),
            "res\n\n[pre-hook context]\npre1"
        );
        // Пост-формат не изменился против прежней склейки
        assert_eq!(
            append_hook_context("res".into(), &[], &["post1".to_string()]),
            "res\n\n[hook context]\npost1"
        );
        assert_eq!(
            append_hook_context(
                "res".into(),
                &["p1".to_string(), "p2".to_string()],
                &["q1".to_string()],
            ),
            "res\n\n[pre-hook context]\np1\np2\n[hook context]\nq1"
        );
    }

    // Золотой вектор whitelist импорта мелодий: расширение → MIME data URL
    #[test]
    fn sound_mime_golden() {
        assert_eq!(sound_mime("MP3"), Some("audio/mpeg"));
        assert_eq!(sound_mime("wav"), Some("audio/wav"));
        assert_eq!(sound_mime("ogg"), Some("audio/ogg"));
        assert_eq!(sound_mime("m4a"), Some("audio/mp4"));
        assert_eq!(sound_mime("flac"), Some("audio/flac"));
        assert_eq!(sound_mime("exe"), None);
        assert_eq!(sound_mime(""), None);
    }
}
