//! MCP (Model Context Protocol) — клиент внешних инструментов-серверов.
//!
//! Транспорт stdio: HaloUI запускает сервер дочерним процессом и общается
//! с ним JSON-RPC 2.0, по одному сообщению на строку (newline-delimited).
//! Рукопожатие: initialize → notifications/initialized → tools/list;
//! вызов инструмента: tools/call.
//!
//! Клиент маршрутизирует ответы по id запроса: фоновый читатель кладёт
//! результат в pending-канал, ждущий поток забирает его с таймаутом —
//! без блокировки главного потока и без зависаний при молчаливом сервере.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Описание MCP-сервера в конфиге (mcp.json в папке настроек).
/// Формат совместим с claude_desktop_config.json по полям command/args/env.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Инструмент, обнаруженный на сервере
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
}

/// Состояние сервера для фронтового статуса
#[derive(Debug, Clone, Serialize)]
pub struct McpServerStatus {
    pub name: String,
    pub connected: bool,
    pub tools: Vec<McpToolInfo>,
}

/// Таймауты: рукопожатие может быть долгим (npx качает пакет), вызов — ещё дольше
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// Карта ожидающих JSON-RPC запросов: id → одноразовый канал ответа
type PendingMap = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// Живое соединение с одним MCP-сервером.
pub struct McpConnection {
    pub server: String,
    pub tools: Mutex<Vec<McpToolInfo>>,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    pending: PendingMap,
    last_stderr: Arc<Mutex<String>>,
}

impl McpConnection {
    /// Запуск процесса сервера + рукопожатие
    pub fn connect(cfg: &McpServerConfig) -> Result<Arc<Self>, String> {
        let mut child = Command::new(&cfg.command)
            .args(&cfg.args)
            .envs(&cfg.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {e}", cfg.command))?;

        let stdout = child
            .stdout
            .take()
            .ok_or("no stdout from server")?;
        let stderr = child.stderr.take().ok_or("no stderr from server")?;

        match Self::from_child(&cfg.name, child, stdout, stderr) {
            Ok(conn) => Ok(conn),
            Err(e) => Err(e),
        }
    }

    /// Принятие уже запущенного процесса: фоновый читатель + рукопожатие.
    /// Отдельно от connect() — чтобы e2e-тест мог поднять «сервер» сам.
    pub fn from_child(
        server: &str,
        mut child: Child,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
    ) -> Result<Arc<Self>, String> {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let last_stderr: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

        // Читатель stdout: маршрутизирует ответы по id, уведомления игнорирует
        let pending_reader = Arc::clone(&pending);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue; // мусорная строка (баннеры и т.п.)
                };
                let Some(id) = v.get("id").and_then(|i| i.as_u64()) else {
                    continue; // notification без id
                };
                if let Some(tx) = pending_reader.lock().ok().and_then(|mut p| p.remove(&id)) {
                    if let Some(err) = v.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown MCP error")
                            .to_string();
                        let _ = tx.send(Err(msg));
                    } else {
                        let _ = tx.send(Ok(v.get("result").cloned().unwrap_or(Value::Null)));
                    }
                }
            }
        });

        // Читатель stderr: серверы пишут туда логи; копим последнюю строку —
        // она попадёт в сообщение об ошибке, если рукопожатие провалится
        let last_err = Arc::clone(&last_stderr);
        std::thread::spawn(move || {
            // FIX: flatten() крутится вечно, если итератор постоянно отдаёт Err
            // (поток битого UTF-8 без '\n'). map_while гасит цикл на первом Err.
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut buf) = last_err.lock() {
                    *buf = line;
                }
            }
        });

        // FIX: при отсутствии stdin child раньше дропался без kill/wait —
        // процесс-сервер оставался жить зомби и держал порт.
        let stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("no stdin to server".to_string());
            }
        };

        let conn = Arc::new(Self {
            server: server.to_string(),
            tools: Mutex::new(Vec::new()),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
            pending,
            last_stderr,
        });

        // Рукопожатие: initialize → notifications/initialized → tools/list
        let init = conn
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "Nocturn", "version": env!("CARGO_PKG_VERSION") }
                }),
                INIT_TIMEOUT,
            )
            .map_err(|e| conn.kill_and_describe(format!("initialize failed: {e}")))?;
        let _ = init; // capabilities сервера пока не нужны
        let _ = conn.notify("notifications/initialized", json!({}));

        let tools = conn
            .request("tools/list", json!({}), LIST_TIMEOUT)
            .map_err(|e| conn.kill_and_describe(format!("tools/list failed: {e}")))?;
        let parsed: Vec<McpToolInfo> = tools
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        Some(McpToolInfo {
                            name: t.get("name")?.as_str()?.to_string(),
                            description: t
                                .get("description")
                                .and_then(|d| d.as_str())
                                .unwrap_or("")
                                .to_string(),
                            input_schema: t
                                .get("inputSchema")
                                .cloned()
                                .unwrap_or_else(|| json!({"type": "object"})),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        *conn.tools.lock().unwrap_or_else(|p| p.into_inner()) = parsed;

        Ok(conn)
    }

    /// JSON-RPC запрос с ожиданием ответа по id.
    /// Публичен: e2e-тесты проверяют таймаут на неизвестных методах.
    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id, tx);

        if let Err(e) = self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        })) {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            return Err(format!("write failed: {e}"));
        }

        match rx.recv_timeout(timeout) {
            Ok(res) => res,
            Err(_) => {
                self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                Err(format!(
                    "timeout after {}s (server did not respond to {method})",
                    timeout.as_secs()
                ))
            }
        }
    }

    /// Уведомление — без id, ответа не ждём
    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stdin = self.stdin.lock().unwrap_or_else(|p| p.into_inner());
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
    }

    /// Вызов инструмента: склеиваем text-блоки content в одну строку для модели
    pub fn call_tool(&self, tool: &str, arguments: Value) -> Result<String, String> {
        let result = self.request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
            CALL_TIMEOUT,
        )?;

        let mut out = String::new();
        if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
            for item in content {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(text);
                    }
                }
            }
        }
        if result.get("isError").and_then(|e| e.as_bool()) == Some(true) {
            return Err(if out.is_empty() {
                "tool reported an error".to_string()
            } else {
                out
            });
        }
        if out.is_empty() {
            return Ok("(empty result)".to_string());
        }
        Ok(out)
    }

    fn stderr_tail(&self) -> String {
        self.last_stderr.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn kill_and_describe(&self, msg: String) -> String {
        self.kill();
        let tail = self.stderr_tail();
        if tail.is_empty() {
            msg
        } else {
            format!("{msg}; server stderr: {tail}")
        }
    }

    pub fn kill(&self) {
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).wait();
    }
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        // Явный kill в Drop — на случай удаления соединения из реестра
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).wait();
    }
}

/// Реестр живых соединений: имя сервера → соединение
#[derive(Default)]
pub struct McpRegistry(pub Mutex<HashMap<String, Arc<McpConnection>>>);

impl McpRegistry {
    pub fn kill_all(&self) {
        for (_, conn) in self.0.lock().unwrap_or_else(|p| p.into_inner()).drain() {
            conn.kill();
        }
    }

    /// Схемы инструментов подключённых серверов с префиксом mcp__<server>__<tool>.
    /// Мердж в OpenAI-совместимый список делает их прозрачными для агентного цикла.
    pub fn tool_schemas_merged(&self, builtin: Value) -> Value {
        let mut list = builtin
            .as_array()
            .cloned()
            .unwrap_or_default();
        let registry = self.0.lock().unwrap_or_else(|p| p.into_inner());
        for (server, conn) in registry.iter() {
            for tool in conn.tools.lock().unwrap_or_else(|p| p.into_inner()).iter() {
                list.push(json!({
                    "type": "function",
                    "function": {
                        "name": format!("mcp__{}__{}", server, tool.name),
                        "description": if tool.description.is_empty() {
                            format!("MCP tool {}.{}", server, tool.name)
                        } else {
                            format!("[MCP:{}] {}", server, tool.description)
                        },
                        "parameters": tool.input_schema
                    }
                }));
            }
        }
        Value::Array(list)
    }
}

/// Разбор имени вида mcp__<server>__<tool>
pub fn split_prefixed_name(prefixed: &str) -> Option<(&str, &str)> {
    let rest = prefixed.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some((server, tool))
}

// ---------------------------------------------------------------------------
// Конфигурация и Tauri-команды: mcp.json в папке настроек + управление
// соединениями. Схемы инструментов подключённых серверов мерджатся в
// get_tool_schemas (см. lib.rs) — агентный цикл на фронте не меняется.
// ---------------------------------------------------------------------------

fn mcp_config_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))?;
    Ok(dir.join("mcp.json"))
}

pub fn load_servers(app: &tauri::AppHandle) -> Result<Vec<McpServerConfig>, String> {
    let path = mcp_config_file(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("mcp.json corrupted: {e}"))
}

fn save_servers(
    app: &tauri::AppHandle,
    servers: &[McpServerConfig],
) -> Result<(), String> {
    let path = mcp_config_file(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Список настроенных серверов (конфиг, не соединения)
#[tauri::command(async)]
pub fn mcp_list_servers(app: tauri::AppHandle) -> Result<Vec<McpServerConfig>, String> {
    load_servers(&app)
}

/// Сохранить конфиг серверов (кнопка в настройках)
#[tauri::command(async)]
pub fn mcp_save_servers(
    app: tauri::AppHandle,
    servers: Vec<McpServerConfig>,
) -> Result<(), String> {
    // Имя — ключ реестра соединений и префикс инструмента: только безопасные символы
    for s in &servers {
        let ok = !s.name.is_empty()
            && s.name.chars().all(|c| {
                c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'
            });
        if !ok {
            return Err(format!(
                "invalid server name \"{}\": use latin letters, digits, _ - .",
                s.name
            ));
        }
        if s.command.trim().is_empty() {
            return Err(format!("server \"{}\": command is empty", s.name));
        }
    }
    save_servers(&app, &servers)
}

/// Подключить сервер: рукопожатие + tools/list. Повторный вызов для живого
/// соединения просто возвращает его инструменты.
#[tauri::command(async)]
pub fn mcp_connect(
    app: tauri::AppHandle,
    registry: tauri::State<'_, McpRegistry>,
    name: String,
) -> Result<Vec<McpToolInfo>, String> {
    {
        let map = registry.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(conn) = map.get(&name) {
            return Ok(conn.tools.lock().unwrap_or_else(|p| p.into_inner()).clone());
        }
    }
    let cfg = load_servers(&app)?
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("MCP server \"{name}\" is not configured"))?;
    if !cfg.enabled {
        return Err(format!("MCP server \"{name}\" is disabled"));
    }
    let conn = McpConnection::connect(&cfg)?;
    let tools = conn.tools.lock().unwrap_or_else(|p| p.into_inner()).clone();
    registry.0.lock().unwrap_or_else(|p| p.into_inner()).insert(name, conn);
    Ok(tools)
}

/// Отключить сервер и завершить его процесс
#[tauri::command(async)]
pub fn mcp_disconnect(
    registry: tauri::State<'_, McpRegistry>,
    name: String,
) -> Result<(), String> {
    if let Some(conn) = registry.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&name) {
        conn.kill();
    }
    Ok(())
}

/// Живые соединения и их инструменты (для вкладки MCP в настройках)
#[tauri::command(async)]
pub fn mcp_status(registry: tauri::State<'_, McpRegistry>) -> Vec<McpServerStatus> {
    let map = registry.0.lock().unwrap_or_else(|p| p.into_inner());
    map.iter()
        .map(|(name, conn)| McpServerStatus {
            name: name.clone(),
            connected: true,
            tools: conn.tools.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        })
        .collect()
}

/// Автоконнект всех включённых серверов при старте приложения.
/// Ошибки отдельных серверов не роняют остальные — просто не подключены.
#[tauri::command(async)]
pub fn mcp_autoconnect(
    app: tauri::AppHandle,
    registry: tauri::State<'_, McpRegistry>,
) -> Result<usize, String> {
    let configs = load_servers(&app)?;
    let mut to_connect: Vec<McpServerConfig> = Vec::new();
    let mut connected = 0;
    for cfg in configs {
        if !cfg.enabled {
            continue;
        }
        let already = registry.0.lock().unwrap_or_else(|p| p.into_inner()).contains_key(&cfg.name);
        if already {
            connected += 1;
            continue;
        }
        to_connect.push(cfg);
    }
    // Параллельный коннект: медленный старт одного сервера (npx) не тянет
    // за собой остальных; таймаут остаётся на каждом соединении
    let handles: Vec<_> = to_connect
        .into_iter()
        .map(|cfg| std::thread::spawn(move || (cfg.name.clone(), McpConnection::connect(&cfg))))
        .collect();
    for h in handles {
        if let Ok((name, Ok(conn))) = h.join() {
            registry
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(name, conn);
            connected += 1;
        }
    }
    Ok(connected)
}

// ---------------------------------------------------------------------------
// Тестовый «сервер»: минимальный MCP-эхо на stdio.
// Запускается тем же бинарём с флагом --mcp-echo-helper — так e2e-тест
// гоняет настоящий клиент против настоящего процесса, без внешних зависимостей.
// ---------------------------------------------------------------------------

pub fn run_echo_helper() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        // Notification (без id) — ответа не требует
        let Some(id) = v.get("id") else { continue };
        let id = id.clone();
        let resp = match method {
            "initialize" => json!({
                "jsonrpc": "2.0", "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "echo", "version": "0.0.1" }
                }
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0", "id": id,
                "result": { "tools": [ {
                    "name": "echo",
                    "description": "Echoes the input text",
                    "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } }
                } ] }
            }),
            "tools/call" => {
                let args = &v["params"]["arguments"];
                let text = args
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default();
                json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [ { "type": "text", "text": format!("echo: {text}") } ] }
                })
            }
            _ => continue,
        };
        let mut out = stdout.lock();
        let _ = writeln!(out, "{resp}");
        let _ = out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_prefixed_name_parses() {
        assert_eq!(
            split_prefixed_name("mcp__git__status"),
            Some(("git", "status"))
        );
        assert_eq!(split_prefixed_name("fs_read"), None);
        assert_eq!(split_prefixed_name("mcp__nounderscore"), None);
        assert_eq!(split_prefixed_name("mcp____tool"), None);
    }
    // Полный e2e-цикл клиента (рукопожатие → tools/list → tools/call) —
    // в tests/mcp_e2e.rs: он спавнит отдельный bin mcp_echo_helper,
    // который недоступен из юнит-тестов (CARGO_BIN_EXE ставится только там).
}
