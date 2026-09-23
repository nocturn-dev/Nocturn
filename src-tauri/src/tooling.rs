//! Исполнение инструментов агента (run_tool), схемы инструментов,
//! серверный слой прав (perm_set/perm_get), конфиги browser/computer/imagegen,
//! звуки уведомлений, keep-awake, история сессий.

use crate::crypto;
use crate::notes::notes_dir;
use crate::perm;
use crate::settings::{config_file, rejects_sensitive_path, save_json_config};
use crate::{browser, computer, hooks, imagegen, mcp, tools};
use base64::engine::general_purpose::STANDARD as B64;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::path::PathBuf;
/// M2: исполнение инструмента агента (вызывается из агентного цикла / для тестов).
/// Имена mcp__<server>__<tool> маршрутизируются в подключённый MCP-сервер.
/// По пути прогоняются хуки PreToolUse (может заблокировать) и PostToolUse
/// (additionalContext дописывается к результату).
#[tauri::command]
pub async fn run_tool(
    app: tauri::AppHandle,
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
    browser_registry: tauri::State<'_, browser::BrowserRegistry>,
    name: String,
    arguments: String,
) -> Result<String, String> {
    use tauri::Manager;

    let args: serde_json::Value =
        serde_json::from_str(&arguments).map_err(|e| format!("invalid arguments JSON: {e}"))?;

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
        for out in tauri::async_runtime::spawn_blocking(move || {
            hooks::run_event(&cfg_dir, "PreToolUse", &tool_name, &payload)
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
    }

    // Серверный слой прав: бэкенд не «глухой исполнитель» — дубль фронт-логики
    // разрешений (App.tsx). Err уходит модели как обычная ошибка инструмента.
    // shell_run — без path-контроля (cwd опционален); для fs_* берём путь из args.
    let perm_path = if name.starts_with("fs_") {
        args.get("path").and_then(|v| v.as_str())
    } else {
        None
    };
    perm::decide(&perm::current(), &name, perm_path)?;

    let notes = notes_dir(&app)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let result = execute_tool_inner(
        mcp_registry,
        browser_registry,
        name.clone(),
        args.clone(),
        notes,
        data_dir,
    )
    .await?;

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

/// Собственно диспетчеризация инструмента (без хуков)
pub async fn execute_tool_inner(
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
    browser_registry: tauri::State<'_, browser::BrowserRegistry>,
    name: String,
    args: serde_json::Value,
    notes_dir: std::path::PathBuf,
    data_dir: std::path::PathBuf,
) -> Result<String, String> {
    let arguments = args.to_string();
    // Computer-инструменты: скриншот быстрый, мышь/клавиатура — блокирующие
    if name.starts_with("computer_") {
        if !computer::config().enabled {
            return Err("Computer Use is disabled in Settings".to_string());
        }
        return tauri::async_runtime::spawn_blocking(move || {
            computer::execute_computer_tool(&name, &arguments)
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }

    // Browser-инструменты: соединение лениво запускается, блокирующий
    // CDP-вызов — в отдельном потоке. Дублируем проверку тумблера:
    // модель могла получить схемы до выключения
    if name.starts_with("browser_") {
        if !browser::config().enabled {
            return Err("Browser Use is disabled in Settings".to_string());
        }
        if name == "browser_close" {
            browser_registry.kill_all();
            return Ok("Browser closed.".to_string());
        }
        let conn = browser_registry.get_or_launch()?;
        let args: serde_json::Value = serde_json::from_str(&arguments)
            .map_err(|e| format!("invalid arguments JSON: {e}"))?;
        return tauri::async_runtime::spawn_blocking(move || {
            browser::execute_on(&conn, &name, &args)
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }

    if let Some((server_raw, tool_raw)) = mcp::split_prefixed_name(&name) {
        let server = server_raw.to_string();
        let tool = tool_raw.to_string();
        // Соединение берём синхронно (дешёвый Arc), блокирующий вызов — в потоке
        let conn = {
            let map = mcp_registry.0.lock().map_err(|e| e.to_string())?;
            map.get(&server)
                .cloned()
                .ok_or_else(|| format!("MCP server \"{server}\" is not connected"))?
        };
        let args: serde_json::Value = serde_json::from_str(&arguments)
            .map_err(|e| format!("invalid arguments JSON: {e}"))?;
        return tauri::async_runtime::spawn_blocking(move || {
            conn.call_tool(&tool, args)
                .map_err(|e| format!("mcp {server}.{tool}: {e}"))
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }
    // Vault-инструменты (заметки): чтение, не мутируют — исполним в потоке
    if name.starts_with("vault_") {
        return tauri::async_runtime::spawn_blocking(move || {
            tools::execute_vault_tool(&notes_dir, &name, &arguments)
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }
    // Генерация изображений: асинхронный HTTP, дубль-проверка тумблера
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
        return imagegen::generate(&data_dir, &prompt, size.as_deref()).await;
    }
    // Инструменты блокирующие (shell_run — до 300 сек): исполняем в
    // отдельном потоке, иначе главный поток окна замирает на весь таймаут
    tauri::async_runtime::spawn_blocking(move || tools::execute_tool(&name, &arguments))
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
            cfg.api_key = plain;
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
pub fn sound_import(app: tauri::AppHandle, src: String) -> Result<String, String> {
    rejects_sensitive_path(&src)?;
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
    let bytes = fs::read(&src_path).map_err(|e| e.to_string())?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("audio file is larger than 5 MB".into());
    }
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
pub fn sound_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
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
    std::thread::spawn(move || {
        let mut last_frame = String::new();
        while BROWSER_VIEW_ACTIVE.load(Ordering::SeqCst) {
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
            let _ = app.emit("browser-frame", payload);
            std::thread::sleep(Duration::from_millis(pause));
        }
    });
    Ok(())
}

#[tauri::command(async)]
pub fn browser_view_stop() {
    BROWSER_VIEW_ACTIVE.store(false, Ordering::SeqCst);
}

/// Размер вьюпорта агентовского браузера (null/null — вернуть как есть)
#[tauri::command(async)]
pub fn browser_view_size(app: tauri::AppHandle, w: Option<i64>, h: Option<i64>) -> Result<(), String> {
    use tauri::Manager;
    let conn = {
        let reg = app.state::<browser::BrowserRegistry>();
        let guard = reg.0.lock().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    };
    if let Some(conn) = conn {
        conn.set_viewport(w, h)?;
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
pub fn perm_set(mode: String, roots: Vec<String>) -> Result<(), String> {
    let mode = match mode.as_str() {
        "plan" => perm::PermMode::Plan,
        "ask" => perm::PermMode::Ask,
        "edit" => perm::PermMode::Edit,
        "full" => perm::PermMode::Full,
        other => return Err(format!("unknown permission mode: {other}")),
    };
    perm::set(perm::PermState { mode, roots, synced: true });
    Ok(())
}

/// Текущее состояние прав: { mode: "ask"…, roots: [...] } — для отладки
/// и восстановления состояния на фронте
#[tauri::command(async)]
pub fn perm_get() -> serde_json::Value {
    let state = perm::current();
    serde_json::json!({ "mode": state.mode, "roots": state.roots })
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
                "description": "Run a subagent: an isolated agent with its own role, context and tool allowlist. It returns a final report. Use for research, coding subtasks, review (critic) or repo navigation. Depth is 1 — a subagent cannot spawn subagents.",
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
                        }
                    },
                    "required": ["role", "task"]
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
pub fn save_sessions(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let path = config_file(&app, "sessions.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
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
}
