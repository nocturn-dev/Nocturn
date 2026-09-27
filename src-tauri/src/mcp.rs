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
use std::io::{BufRead, BufReader, Read, Write};
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
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Транспорт: None/"stdio" — дочерний процесс; "http"/"sse" — удалённый
    /// сервер (streamable HTTP: POST JSON-RPC, ответ JSON или SSE-поток).
    /// Легаси-транспорт HTTP+SSE (2024-11-05) не реализован — метка "sse"
    /// принята для совместимости конфигов, ходит тем же streamable HTTP
    #[serde(default)]
    pub transport: Option<String>,
    /// Endpoint удалённого сервера (только для transport http/sse)
    #[serde(default)]
    pub url: String,
    /// Заголовки запроса (Authorization: Bearer … и т.п.) — токены доступа.
    /// Полный OAuth-танец не делаем: статические заголовки покрывают большинство
    /// hosted-серверов, рефреш-токены — отдельная история
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

fn default_true() -> bool {
    true
}

/// Удалённый сервер (транспорт http/sse с непустым url)
pub fn is_remote(cfg: &McpServerConfig) -> bool {
    matches!(cfg.transport.as_deref(), Some("http") | Some("sse"))
        && !cfg.url.trim().is_empty()
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
/// Потолок записи в stdin: сервер, переставший читать пайп, блокировал
/// write_all навсегда (буфер пайпа полон) — request не возвращал ни ответ,
/// ни таймаут, воркер утекал на каждый вызов
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Карта ожидающих JSON-RPC запросов: id → одноразовый канал ответа
type PendingMap = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// Живое соединение с одним MCP-сервером.
pub struct McpConnection {
    pub server: String,
    pub tools: Mutex<Vec<McpToolInfo>>,
    /// Arc: писатель выносится в отдельный поток с таймаутом (write_line)
    stdin: Arc<Mutex<ChildStdin>>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    pending: PendingMap,
    last_stderr: Arc<Mutex<String>>,
}

/// Прямой запуск серверного процесса (пайпы на stdin/stdout/stderr)
fn spawn_server(cfg: &McpServerConfig) -> std::io::Result<Child> {
    let mut cmd = Command::new(&cfg.command);
    cmd.args(&cfg.args)
        .envs(&cfg.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // CREATE_NO_WINDOW: консольный .exe из GUI-процесса рождал видимую
    // консоль-вспышку (mcp_autoconnect при старте — пачка окон)
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn()
}

/// Windows-fallback: npx/uvx и компания — это .cmd-файлы, CreateProcess их
/// не исполняет («program not found»). Запуск через cmd /C; command идёт
/// raw_arg'ом — .arg() закавычил бы команду с пробелами («python -u
/// server.py») в единый токен, и cmd не нашёл файл (как в hooks.rs).
/// args экранирует std — фикс BatBadBut гарантирован MSRV 1.88
#[cfg(windows)]
fn spawn_via_cmd(cfg: &McpServerConfig) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("cmd")
        .raw_arg("/C")
        .raw_arg(&cfg.command)
        .args(&cfg.args)
        .envs(&cfg.env)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

impl McpConnection {
    /// Запуск процесса сервера + рукопожатие.
    /// Windows: CreateProcess не исполняет .cmd/.bat (npx, uvx — это .cmd),
    /// а канонические MCP-конфиги пишут "command": "npx" — при фейле прямого
    /// запуска ретраим через `cmd /C` (как hooks.rs).
    pub fn connect(cfg: &McpServerConfig) -> Result<Arc<Self>, String> {
        let mut child = match spawn_server(cfg) {
            Ok(c) => c,
            Err(direct_err) => {
                #[cfg(windows)]
                {
                    match spawn_via_cmd(cfg) {
                        Ok(c) => c,
                        Err(_) => return Err(direct_err.to_string()),
                    }
                }
                #[cfg(not(windows))]
                {
                    return Err(direct_err.to_string());
                }
            }
        };

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

        // Читатель stdout: маршрутизирует ответы по id, уведомления игнорирует.
        // Байтовый цикл с лимитом строки: сервер, шлющий гигабайты без '\n',
        // раздувал память без ограничений (BufReader::lines() не имеет потолка)
        const LINE_CAP: usize = 8 * 1024 * 1024; // 8 МБ на одну JSON-строку
        let pending_reader = Arc::clone(&pending);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut line: Vec<u8> = Vec::with_capacity(4096);
            let handle_line = |line: &[u8], pending: &PendingMap| {
                let Ok(v) = serde_json::from_slice::<Value>(line) else {
                    return; // мусорная строка (баннеры и т.п.)
                };
                let Some(id) = v.get("id").and_then(|i| i.as_u64()) else {
                    return; // notification без id
                };
                if let Some(tx) = pending.lock().ok().and_then(|mut p| p.remove(&id)) {
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
            };
            for byte in reader.bytes() {
                let Ok(b) = byte else { break };
                if b == b'\n' {
                    handle_line(&line, &pending_reader);
                    line.clear();
                    continue;
                }
                // Сверх лимита байты отбрасываем, но строку дочитываем до '\n'
                if line.len() < LINE_CAP {
                    line.push(b);
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
            stdin: Arc::new(Mutex::new(stdin)),
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
        // Запись в отдельном потоке с таймаутом: write_all блокируется
        // навсегда, когда сервер перестал читать stdin и буфер пайпа полон
        let stdin = Arc::clone(&self.stdin);
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let res = (|| -> Result<(), std::io::Error> {
                let mut s = stdin.lock().unwrap_or_else(|p| p.into_inner());
                s.write_all(line.as_bytes())?;
                s.flush()
            })();
            let _ = tx.send(res.map_err(|e| e.to_string()));
        });
        match rx.recv_timeout(WRITE_TIMEOUT) {
            Ok(res) => res,
            Err(_) => {
                // Соединение мертво: гасим процесс — заблокированный писатель
                // получит EPIPE и поток завершится, а не утечёт навсегда
                self.kill();
                Err(format!(
                    "write to server stdin timed out after {}s — server stopped reading, connection killed",
                    WRITE_TIMEOUT.as_secs()
                ))
            }
        }
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
        #[cfg(windows)]
        {
            // Дерево процессов: fallback cmd /C npx … оставляет внука (node)
            // живым — Child::kill терминирует только cmd.exe, сирота держит
            // порты и унаследованные пайпы (читатель stdout не получает EOF)
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let pid = self
                .child
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .id();
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        let mut child = self.child.lock().unwrap_or_else(|p| p.into_inner());
        let _ = child.kill();
        // wait(): на Unix без reap'а дочерний процесс остаётся зомби
        // до выхода приложения
        let _ = child.wait();
    }
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        // Явный kill в Drop — на случай удаления соединения из реестра
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).wait();
    }
}

// ---------------------------------------------------------------------------
// Удалённый MCP (streamable HTTP): POST JSON-RPC на endpoint, ответ — JSON
// или SSE-поток. Сессия — заголовок Mcp-Session-Id из ответа initialize.
// Асинхронный reqwest: вызовы идут из execute_tool_inner напрямую, без
// spawn_blocking (в отличие от блокирующего stdio-транспорта)
// ---------------------------------------------------------------------------

pub struct RemoteConnection {
    pub server: String,
    pub tools: Mutex<Vec<McpToolInfo>>,
    url: String,
    headers: HashMap<String, String>,
    session: Mutex<Option<String>>,
    next_id: AtomicU64,
}

/// Вытащить JSON-RPC-ответ из тела: JSON — как есть; SSE — строка `data:` с
/// нашим id (сервер вправе слать и уведомления/запросы — игнорируем)
fn extract_rpc_response(body: &str, id: u64) -> Result<Value, String> {
    let looks_sse = body.trim_start().starts_with("event:") || body.contains("\ndata:");
    if !looks_sse {
        return serde_json::from_str(body).map_err(|e| format!("bad JSON from remote MCP: {e}"));
    }
    let mut fallback: Option<Value> = None;
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(v) = serde_json::from_str::<Value>(data.trim()) else { continue };
        if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
            return Ok(v);
        }
        // Ответ без id быть не может, но мусорный сервер пусть не роняет нас
        if (v.get("result").is_some() || v.get("error").is_some()) && fallback.is_none() {
            fallback = Some(v);
        }
    }
    fallback.ok_or_else(|| "remote MCP stream ended without a response".to_string())
}

fn parse_rpc_result(v: Value) -> Result<Value, String> {
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!("remote MCP error: {msg}"));
    }
    Ok(v.get("result").cloned().unwrap_or_else(|| json!({})))
}

fn parse_tools(v: &Value) -> Vec<McpToolInfo> {
    v.get("tools")
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
        .unwrap_or_default()
}

impl RemoteConnection {
    /// Рукопожатие + tools/list. Сессия запоминается из заголовка ответа
    pub async fn connect(cfg: &McpServerConfig) -> Result<Arc<McpHandle>, String> {
        let url = cfg.url.trim().to_string();
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(format!("remote MCP url must be http(s): {url}"));
        }
        let conn = Arc::new(RemoteConnection {
            server: cfg.name.clone(),
            tools: Mutex::new(Vec::new()),
            url,
            headers: cfg.headers.clone(),
            session: Mutex::new(None),
            next_id: AtomicU64::new(0),
        });
        let init = conn
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": { "name": "Nocturn", "version": env!("CARGO_PKG_VERSION") }
                }),
                INIT_TIMEOUT,
            )
            .await
            .map_err(|e| format!("initialize failed: {e}"))?;
        let _ = init;
        conn.notify("notifications/initialized", json!({}))
            .await
            .map_err(|e| format!("initialized notification failed: {e}"))?;
        let tools_res = conn
            .request("tools/list", json!({}), LIST_TIMEOUT)
            .await
            .map_err(|e| format!("tools/list failed: {e}"))?;
        let parsed = parse_tools(&tools_res);
        *conn.tools.lock().unwrap_or_else(|p| p.into_inner()) = parsed;
        Ok(Arc::new(McpHandle::Remote(conn)))
    }

    /// JSON-RPC запрос: POST → JSON или SSE → ответ по id.
    /// Session-id запоминаем при первом появлении (initialize)
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let v = self
            .post_rpc(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            }), timeout)
            .await?;
        let v = extract_rpc_response(&v, id)?;
        parse_rpc_result(v)
    }

    /// Уведомление — без id; сервер отвечает 202 Accepted
    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.post_rpc(
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
            Duration::from_secs(15),
        )
        .await
        .map(|_| ())
    }

    async fn post_rpc(&self, body: &Value, timeout: Duration) -> Result<String, String> {
        let client = crate::network::apply(
            reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(15)),
        )?
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;
        let mut req = client
            .post(&self.url)
            .header("Content-Type", "application/json")
            // streamable HTTP: сервер сам выбирает формат ответа
            .header("Accept", "application/json, text/event-stream")
            .json(body);
        for (k, v) in &self.headers {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::try_from(k.as_str()),
                reqwest::header::HeaderValue::try_from(v.as_str()),
            ) {
                req = req.header(name, val);
            }
        }
        if let Some(sid) = self.session.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            req = req.header("Mcp-Session-Id", sid);
        }
        let resp = tokio::time::timeout(timeout, req.send())
            .await
            .map_err(|_| format!("timeout after {}s (remote MCP did not respond)", timeout.as_secs()))?
            .map_err(|e| format!("remote MCP request failed: {e}"))?;
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            *self.session.lock().unwrap_or_else(|p| p.into_inner()) = Some(sid.to_string());
        }
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("failed to read remote MCP response: {e}"))?;
        if !status.is_success() {
            // 202 Accepted на уведомления — не ошибка (некоторые серверы шлют 202)
            if status.as_u16() == 202 {
                return Ok(String::new());
            }
            let snippet: String = text.chars().take(200).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), snippet));
        }
        Ok(text)
    }

    /// Вызов инструмента: та же склейка text-блоков, что у stdio
    pub async fn call_tool(&self, tool: &str, arguments: Value) -> Result<String, String> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
                CALL_TIMEOUT,
            )
            .await?;
        Ok(extract_content_text(&result))
    }
}

/// Склейка text-блоков MCP content (общая для stdio и remote)
fn extract_content_text(result: &Value) -> String {
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
    out
}

/// Реестр живых соединений: имя сервера → соединение
#[derive(Default)]
/// Arc внутри — реестр клонируется в spawn_blocking: коннект/рукопожатие
/// MCP-сервера (до ~45 с) не должен оккупировать воркер tokio
pub struct McpRegistry(pub Arc<Mutex<HashMap<String, Arc<McpHandle>>>>);

/// Соединение с сервером: локальный процесс (stdio) или удалённый (HTTP).
/// Общая поверхность — список тулов, kill, вызов инстру (async для обоих:
/// stdio-вызов уходит в spawn_blocking в роутинге)
pub enum McpHandle {
    Stdio(Arc<McpConnection>),
    Remote(Arc<RemoteConnection>),
}

impl McpHandle {
    pub fn server(&self) -> &str {
        match self {
            McpHandle::Stdio(c) => &c.server,
            McpHandle::Remote(r) => &r.server,
        }
    }

    pub fn tools_clone(&self) -> Vec<McpToolInfo> {
        match self {
            McpHandle::Stdio(c) => c.tools.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            McpHandle::Remote(r) => r.tools.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        }
    }

    pub fn kill(&self) {
        // Удалённому серверу нечего гасить: нет процесса, нет сессии-сироты
        if let McpHandle::Stdio(c) = self {
            c.kill();
        }
    }

    pub async fn call_tool(&self, tool: &str, arguments: Value) -> Result<String, String> {
        match self {
            McpHandle::Stdio(c) => {
                // tool не живёт дольше метода — в 'static замыкание уходит String
                let tool = tool.to_string();
                let c = c.clone();
                tauri::async_runtime::spawn_blocking(move || c.call_tool(&tool, arguments))
                    .await
                    .map_err(|e| format!("tool task failed: {e}"))?
            }
            McpHandle::Remote(r) => r.call_tool(tool, arguments).await,
        }
    }
}

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
        for (server, handle) in registry.iter() {
            for tool in handle.tools_clone() {
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
    crate::fsutil::atomic_write(&path, json.as_bytes())
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
        if is_remote(s) {
            // Удалённый сервер: команда не нужна, но endpoint — обязателен
            let url = s.url.trim();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(format!(
                    "server \"{}\": remote transport needs an http(s) URL",
                    s.name
                ));
            }
        } else if s.command.trim().is_empty() {
            return Err(format!("server \"{}\": command is empty", s.name));
        }
    }
    save_servers(&app, &servers)
}

/// Подключить сервер: рукопожатие + tools/list. Повторный вызов для живого
/// соединения просто возвращает его инструменты.
/// Тело — в spawn_blocking: рукопожатие держит воркер десятки секунд.
#[tauri::command(async)]
pub async fn mcp_connect(
    app: tauri::AppHandle,
    registry: tauri::State<'_, McpRegistry>,
    name: String,
) -> Result<Vec<McpToolInfo>, String> {
    let registry = registry.0.clone();
    // Транспорт решаем до dispatch: удалённый сервер ходит async напрямую,
    // локальный процесс — в spawn_blocking (рукопожатие до десятков секунд)
    let cfg = load_servers(&app)?
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("MCP server \"{name}\" is not configured"))?;
    if !cfg.enabled {
        return Err(format!("MCP server \"{name}\" is disabled"));
    }
    if is_remote(&cfg) {
        if let Some(existing) = registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&name)
        {
            return Ok(existing.tools_clone());
        }
        let handle = RemoteConnection::connect(&cfg).await?;
        let mut map = registry.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = map.get(&name) {
            return Ok(existing.tools_clone());
        }
        let tools = handle.tools_clone();
        map.insert(name, handle);
        return Ok(tools);
    }
    tauri::async_runtime::spawn_blocking(move || mcp_connect_impl(app, registry, name))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn mcp_connect_impl(
    app: tauri::AppHandle,
    registry: Arc<Mutex<HashMap<String, Arc<McpHandle>>>>,
    name: String,
) -> Result<Vec<McpToolInfo>, String> {
    if let Some(conn) = registry
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&name)
    {
        return Ok(conn.tools_clone());
    }
    let cfg = load_servers(&app)?
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("MCP server \"{name}\" is not configured"))?;
    if !cfg.enabled {
        return Err(format!("MCP server \"{name}\" is disabled"));
    }
    let conn = McpConnection::connect(&cfg)?;
    let handle = Arc::new(McpHandle::Stdio(conn));
    let mut map = registry.lock().unwrap_or_else(|p| p.into_inner());
    // Двойная проверка: параллельный mcp_autoconnect/mcp_connect мог вставить
    // соединение, пока мы соединялись. Лишний процесс гасим, чужой возвращаем —
    // иначе второй insert перезаписал бы живое соединение
    if let Some(existing) = map.get(&name) {
        handle.kill();
        return Ok(existing.tools_clone());
    }
    let tools = handle.tools_clone();
    map.insert(name, handle);
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
        .map(|(name, handle)| McpServerStatus {
            name: name.clone(),
            connected: true,
            tools: handle.tools_clone(),
        })
        .collect()
}

/// Автоконнект всех включённых серверов при старте приложения.
/// Ошибки отдельных серверов не роняют остальные — просто не подключены.
/// stdio — в spawn_blocking (join потоков коннекта держит воркер до ~45 с),
/// удалённые — параллельно async-фьючами
#[tauri::command(async)]
pub async fn mcp_autoconnect(
    app: tauri::AppHandle,
    registry: tauri::State<'_, McpRegistry>,
) -> Result<usize, String> {
    let registry = registry.0.clone();
    mcp_autoconnect_impl(app, registry).await
}

async fn mcp_autoconnect_impl(
    app: tauri::AppHandle,
    registry: Arc<Mutex<HashMap<String, Arc<McpHandle>>>>,
) -> Result<usize, String> {
    let configs = load_servers(&app)?;
    let mut connected = 0;
    let mut stdio_cfgs: Vec<McpServerConfig> = Vec::new();
    let mut remote_cfgs: Vec<McpServerConfig> = Vec::new();
    for cfg in configs {
        if !cfg.enabled {
            continue;
        }
        let already = registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(&cfg.name);
        if already {
            connected += 1;
            continue;
        }
        if is_remote(&cfg) {
            remote_cfgs.push(cfg);
        } else {
            stdio_cfgs.push(cfg);
        }
    }
    // stdio: параллельный коннект в потоках (как раньше) — медленный старт
    // одного сервера (npx) не тянет за собой остальных
    let reg_stdio = registry.clone();
    let stdio_task = tauri::async_runtime::spawn_blocking(move || {
        let handles: Vec<_> = stdio_cfgs
            .into_iter()
            .map(|cfg| {
                std::thread::spawn(move || {
                    let res = McpConnection::connect(&cfg);
                    (cfg.name, res.map(|c| Arc::new(McpHandle::Stdio(c))))
                })
            })
            .collect();
        let mut n = 0usize;
        for h in handles {
            if let Ok((name, Ok(handle))) = h.join() {
                let mut map = reg_stdio.lock().unwrap_or_else(|p| p.into_inner());
                if map.contains_key(&name) {
                    handle.kill();
                    n += 1;
                    continue;
                }
                map.insert(name, handle);
                n += 1;
            }
        }
        n
    })
    .await
    .map_err(|e| format!("join error: {e}"))?;
    connected += stdio_task;

    // remote: параллельные async-рукопожатия
    let mut futs = Vec::new();
    for cfg in remote_cfgs {
        let reg = registry.clone();
        futs.push(async move {
            let name = cfg.name.clone();
            let res = RemoteConnection::connect(&cfg).await;
            (name, res, reg)
        });
    }
    let results = futures_util::future::join_all(futs).await;
    for (name, res, reg) in results {
        if let Ok(handle) = res {
            let mut map = reg.lock().unwrap_or_else(|p| p.into_inner());
            if map.contains_key(&name) {
                continue;
            }
            map.insert(name, handle);
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

    #[test]
    fn extract_rpc_response_parses_json_sse_and_reports_missing() {
        // Голый JSON — как есть
        let v = extract_rpc_response(r#"{"jsonrpc":"2.0","id":3,"result":{"x":1}}"#, 3).unwrap();
        assert_eq!(v["result"]["x"], 1);
        // SSE: наш id среди посторонних событий (уведомления без id игнорируем)
        let body = "event: message
data: {\"jsonrpc\":\"2.0\",\"method\":\"ping\"}

event: message
data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}
";
        let v = extract_rpc_response(body, 7).unwrap();
        assert_eq!(v["result"]["ok"], true);
        // Ответа нет — ошибка, а не вечное ожидание
        assert!(extract_rpc_response("event: message
data: {\"jsonrpc\":\"2.0\",\"method\":\"ping\"}", 9).is_err());
    }

    #[test]
    fn parse_rpc_result_maps_error() {
        let v: Value = serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}}"#).unwrap();
        assert!(parse_rpc_result(v).unwrap_err().contains("boom"));
        let v: Value = serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"result":{"content":[]}}"#).unwrap();
        assert!(parse_rpc_result(v).is_ok());
    }
    // Полный e2e-цикл клиента (рукопожатие → tools/list → tools/call) —
    // в tests/mcp_e2e.rs: он спавнит отдельный bin mcp_echo_helper,
    // который недоступен из юнит-тестов (CARGO_BIN_EXE ставится только там).
}
