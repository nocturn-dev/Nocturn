//! Browser Use: управление настоящим браузером через CDP (Chrome DevTools Protocol).
//!
//! HaloUI запускает headless Edge/Chrome (есть на любой Windows) с
//! --remote-debugging-port и общается с ним по WebSocket: Page.navigate,
//! Runtime.evaluate, Page.captureScreenshot, Input.insertText.
//! Скриншот делается ровно в том viewport'е (1280x800, scale 1), в котором
//! живёт страница, — поэтому координаты кликов из скриншота совпадают 1:1.
//!
//! Модель агента получает компактный набор инструментов browser_*:
//! navigate / read / screenshot / click / type / scroll / close.
//! Соединение ленивое: первый browser_*-вызов запускает браузер.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

const VIEWPORT_W: u32 = 1280;
const VIEWPORT_H: u32 = 800;
const SCREENSHOT_QUALITY: u8 = 70; // jpeg — компромисс размер/качество для vision
const READ_TEXT_LIMIT: usize = 20_000; // текст страницы в ответе инструмента
const NAV_TIMEOUT: Duration = Duration::from_secs(20);
const WS_READ_TIMEOUT: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// Конфигурация (вкладка «Browser Use» в настройках)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BrowserConfig {
    /// Browser Use по умолчанию выключен — включается явно в настройках
    #[serde(default = "default_browser_enabled")]
    pub enabled: bool,
    /// true — headless (окна браузера не видно); false — видимый браузер
    #[serde(default = "default_true")]
    pub headless: bool,
    /// Свой путь к браузеру; пусто — автопоиск Edge/Chrome
    #[serde(default)]
    pub executable: String,
}

fn default_true() -> bool {
    true
}

fn default_browser_enabled() -> bool {
    false
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            headless: true,
            executable: String::new(),
        }
    }
}

/// Глобальный снапшот конфига: читается на каждом tool-вызове
/// (set_config обновляет его и пишет в browser.json)
pub static CONFIG: Mutex<Option<BrowserConfig>> = Mutex::new(None);

pub fn config() -> BrowserConfig {
    CONFIG.lock().unwrap().clone().unwrap_or_default()
}

pub fn set_config(cfg: BrowserConfig) {
    *CONFIG.lock().unwrap() = Some(cfg);
}

// ---------------------------------------------------------------------------
// Реестр: один управляемый браузер на приложение
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct BrowserRegistry(pub Mutex<Option<Arc<BrowserConnection>>>);

impl BrowserRegistry {
    /// Текущее живое соединение или запуск нового (ленивая инициализация)
    pub fn get_or_launch(&self) -> Result<Arc<BrowserConnection>, String> {
        let mut slot = self.0.lock().unwrap();
        if let Some(conn) = slot.as_ref() {
            if !conn.is_dead() && conn.child_alive() {
                return Ok(Arc::clone(conn));
            }
            // Мёртвое соединение убираем — новый вызов перезапустит браузер
            if let Some(old) = slot.take() {
                old.kill();
            }
        }
        let conn = Arc::new(BrowserConnection::launch()?);
        *slot = Some(Arc::clone(&conn));
        Ok(conn)
    }

    pub fn kill_all(&self) {
        if let Some(conn) = self.0.lock().unwrap().take() {
            conn.kill();
        }
    }
}

// ---------------------------------------------------------------------------
// Поиск и запуск браузера
// ---------------------------------------------------------------------------

/// Путь к браузеру: настройка из вкладки Browser Use, переменная окружения
/// HALOUI_BROWSER, потом автопоиск Edge/Chrome
fn find_browser_executable() -> Option<String> {
    let cfg_exec = config().executable;
    if !cfg_exec.trim().is_empty() {
        if std::path::Path::new(cfg_exec.trim()).exists() {
            return Some(cfg_exec.trim().to_string());
        }
        return None; // Пользователь задал путь, но файла нет — не ищем другой
    }
    if let Ok(p) = std::env::var("HALOUI_BROWSER") {
        if !p.trim().is_empty() {
            return Some(p);
        }
    }
    const CANDIDATES: &[&str] = &[
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];
    for c in CANDIDATES {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    // Не-Windows: бинарники из PATH
    for name in ["google-chrome", "chromium", "chromium-browser", "msedge"] {
        if which_exists(name) {
            return Some(name.to_string());
        }
    }
    None
}

fn which_exists(name: &str) -> bool {
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        if dir.join(name).exists() {
            return true;
        }
    }
    false
}

/// Свободный TCP-порт на localhost (для --remote-debugging-port)
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("cannot bind: {e}"))?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

/// GET http://127.0.0.1:{port}/json/list → тело ответа (plain HTTP, без TLS).
/// Важно: читаем ровно Content-Length байт — Edge держит keep-alive и
/// не закрывает соединение по Connection: close, поэтому read_to_end
/// упёрся бы в таймаут, не дождавшись EOF.
fn http_get_json(port: u16, path: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("cannot connect to CDP port: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    // Читаем до конца заголовков
    let header_end = loop {
        let n = stream
            .read(&mut chunk)
            .map_err(|e| format!("cannot read CDP response: {e}"))?;
        if n == 0 {
            return Err("CDP connection closed before headers".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    // Content-Length: сколько байт тела осталось дочитать
    let headers = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let content_length: usize = headers
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse().ok())?
        })
        .ok_or("no Content-Length in CDP response")?;
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        let n = stream
            .read(&mut chunk)
            .map_err(|e| format!("cannot read CDP response: {e}"))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(String::from_utf8_lossy(&body).to_string())
}

/// Ждём, пока CDP-порт поднимется, и возвращаем ws-URL первой page-цели
fn wait_for_page_ws_url(port: u16) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    #[allow(unused_assignments)]
    let mut last_err = String::new();
    loop {
        match http_get_json(port, "/json/list") {
            Ok(body) => match serde_json::from_str::<Value>(&body) {
                Ok(targets) => {
                    let found = targets.as_array().and_then(|arr| {
                        arr.iter()
                            .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
                            .and_then(|t| {
                                t.get("webSocketDebuggerUrl")
                                    .and_then(|v| v.as_str())
                                    .map(String::from)
                            })
                    });
                    if let Some(ws) = found {
                        return Ok(ws);
                    }
                    last_err = format!("no page target in /json/list: {body}");
                }
                Err(e) => last_err = format!("bad JSON from /json/list: {e}; body: {body}"),
            },
            Err(e) => last_err = e,
        }
        if Instant::now() > deadline {
            return Err(format!(
                "browser CDP endpoint did not respond in 20s; last error: {last_err}"
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// ---------------------------------------------------------------------------
// Соединение с браузером
// ---------------------------------------------------------------------------

pub struct BrowserConnection {
    child: Mutex<Child>,
    ws: Mutex<WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>>,
    next_id: AtomicU64,
    /// id просроченных запросов: их поздние ответы молча пропускаются
    abandoned: Mutex<HashSet<u64>>,
    dead: Mutex<bool>,
}

impl BrowserConnection {
    /// Запуск headless-браузера и подключение к его CDP-порту
    pub fn launch() -> Result<Self, String> {
        let exe = find_browser_executable().ok_or(
            "Browser not found: install Edge or Chrome, or set HALOUI_BROWSER to the browser executable.",
        )?;
        let port = free_port()?;
        // Уникальный профиль на запуск: общий каталог заставляет Edge/Chrome
        // молча пересылать новый процесс уже запущенному экземпляру
        // (single-instance) — CDP-порт тогда вообще не открывается
        let profile = std::env::temp_dir().join(format!("haloui-browser-{port}"));
        let cfg = config();
        let port_arg = format!("--remote-debugging-port={port}");
        let profile_arg = format!("--user-data-dir={}", profile.display());
        let size_arg = format!("--window-size={VIEWPORT_W},{VIEWPORT_H}");
        let mut browser_args: Vec<&str> = vec![
            &port_arg,
            &profile_arg,
            "--no-first-run",
            "--no-default-browser-check",
            "--force-device-scale-factor=1",
            &size_arg,
            "about:blank",
        ];
        if cfg.headless {
            browser_args.insert(0, "--headless=new");
        }
        let child = Command::new(&exe)
            .args(&browser_args)
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to spawn browser {exe}: {e}"))?;

        // При любой ошибке запуска гасим процесс — браузер-сирота
        // держит порт и профиль и ломает все следующие запуски
        let built = Self::build(child, port, &profile);
        if built.is_err() {
            let _ = fs::remove_dir_all(&profile);
        }
        built
    }

    fn build(child: Child, port: u16, _profile: &std::path::Path) -> Result<Self, String> {
        let mut child = child;
        let ws_url = match wait_for_page_ws_url(port) {
            Ok(u) => u,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let (ws, _resp) = match tungstenite::connect(ws_url.as_str()) {
            Ok(x) => x,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("cannot connect to browser WebSocket: {e}"));
            }
        };

        let conn = Self {
            child: Mutex::new(child),
            ws: Mutex::new(ws),
            next_id: AtomicU64::new(1),
            abandoned: Mutex::new(HashSet::new()),
            dead: Mutex::new(false),
        };

        // Viewport должен точно совпадать со скриншотом — на нём строится клик
        if let Err(e) = conn.request(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": VIEWPORT_W,
                "height": VIEWPORT_H,
                "deviceScaleFactor": 1,
                "mobile": false
            }),
        ) {
            conn.kill();
            return Err(e);
        }
        Ok(conn)
    }

    fn is_dead(&self) -> bool {
        *self.dead.lock().unwrap()
    }

    fn mark_dead(&self) {
        *self.dead.lock().unwrap() = true;
    }

    /// Жив ли процесс браузера
    fn child_alive(&self) -> bool {
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    /// CDP-запрос с ожиданием ответа по id. Использование строго последовательное:
    ///.Mutex сериализует, параллельные вызовы инструментов просто подождут.
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_impl(method, params, WS_READ_TIMEOUT, true)
    }

    /// «Мягкий» запрос для фоновой трансляции: короткий таймаут и просрочка
    /// НЕ помечает соединение мёртвым — иначе фоновый кадр во время загрузки
    /// страницы убивал соединение и ломал инструменты агента.
    fn request_soft(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_impl(method, params, Duration::from_secs(3), false)
    }

    fn request_impl(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        fatal: bool,
    ) -> Result<Value, String> {
        if self.is_dead() || !self.child_alive() {
            return Err("browser connection is closed".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({ "id": id, "method": method, "params": params });

        let mut ws = self.ws.lock().unwrap();
        // Таймаут чтения: WouldBlock просто завершает ожидание read(),
        // внутренний буфер tungstenite сохраняет частичные кадры
        if let tungstenite::stream::MaybeTlsStream::Plain(stream) = ws.get_ref() {
            stream
                .set_read_timeout(Some(Duration::from_millis(250)))
                .ok();
        }
        ws.send(Message::text(msg.to_string()))
            .map_err(|e| {
                self.mark_dead();
                format!("browser write failed: {e}")
            })?;

        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() > deadline {
                self.abandoned.lock().unwrap().insert(id);
                if fatal {
                    self.mark_dead();
                    return Err(format!("browser did not respond to {method} in {}s", timeout.as_secs()));
                }
                return Err(format!("{method} timed out (soft)"));
            }
            let message = match ws.read() {
                Ok(m) => m,
                // Таймаут чтения сокета: на Unix — WouldBlock, на Windows —
                // TimedOut (os error 10060). Оба = «пока тихо», ждём дедлайна
                Err(tungstenite::Error::Io(e))
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    continue;
                }
                Err(e) => {
                    self.mark_dead();
                    return Err(format!("browser read failed: {e}"));
                }
            };
            let Message::Text(text) = message else {
                continue; // бинарные/ping/pong игнорируем
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            match v.get("id").and_then(|i| i.as_u64()) {
                Some(resp_id) if resp_id == id => {
                    if let Some(err) = v.get("error") {
                        return Err(format!(
                            "{method} failed: {}",
                            err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown")
                        ));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
                Some(resp_id) => {
                    // Поздний ответ просроченного запроса — пропускаем
                    self.abandoned.lock().unwrap().remove(&resp_id);
                }
                None => {} // события CDP (без id) — не нужны, readyState опрашиваем
            }
        }
    }

    /// Runtime.evaluate с возвратом значения выражения
    fn evaluate(&self, expression: &str) -> Result<Value, String> {
        let result = self.request(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true, "awaitPromise": false }),
        )?;
        let r = &result["result"];
        if result.get("exceptionDetails").is_some() {
            return Err(format!(
                "page JS error: {}",
                r.get("description").and_then(|d| d.as_str()).unwrap_or("exception")
            ));
        }
        Ok(r.get("value").cloned().unwrap_or(Value::Null))
    }

    /// Ждём загрузки страницы (document.readyState == complete).
    /// Таймаут не фатален: часть сайтов грузится вечно, отдаём страницу как есть.
    fn wait_ready(&self) -> Result<String, String> {
        let deadline = Instant::now() + NAV_TIMEOUT;
        loop {
            let state = self.evaluate("document.readyState")?
                .as_str().unwrap_or("unknown").to_string();
            if state == "complete" {
                return Ok(String::new());
            }
            if Instant::now() > deadline {
                return Ok(format!(" (note: page still loading, readyState={state})"));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// Строковое описание страницы для ответа инструмента
    fn describe(&self) -> Result<String, String> {
        let desc = self.evaluate(
            "(() => { const el = document.activeElement; \
             return (document.title ? `title: ${document.title}\\n` : '') + \
             `url: ${location.href}\\n` + `readyState: ${document.readyState}`; })()"
        )?;
        Ok(desc.as_str().unwrap_or("").to_string())
    }

    /// Кадр живого просмотра (JPEG base64) + текущий URL — для панели.
    /// Мягкие запросы: просрочка не убивает соединение (фоновой поток)
    pub fn view_frame(&self) -> Result<(String, String), String> {
        let res = self.request_soft(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 50 }),
        )?;
        let data = res
            .get("data")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        if data.is_empty() {
            return Err("empty frame".into());
        }
        let url = self
            .request_soft(
                "Runtime.evaluate",
                json!({ "expression": "location.href", "returnByValue": true, "awaitPromise": false }),
            )
            .ok()
            .and_then(|r| {
                r.get("result")
                    .and_then(|x| x.get("value"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .unwrap_or_default();
        Ok((data, url))
    }

    /// Размер вьюпорта для панели (None/None — вернуть как есть)
    pub fn set_viewport(&self, w: Option<i64>, h: Option<i64>) -> Result<(), String> {
        match (w, h) {
            (Some(w), Some(h)) => {
                self.request(
                    "Emulation.setDeviceMetricsOverride",
                    json!({ "width": w, "height": h, "deviceScaleFactor": 0, "mobile": false }),
                )?;
            }
            _ => {
                self.request("Emulation.clearDeviceMetricsOverride", json!({}))?;
            }
        }
        Ok(())
    }
}

impl Drop for BrowserConnection {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap().kill();
        let _ = self.child.lock().unwrap().wait();
    }
}

impl BrowserConnection {
    fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
        let _ = self.child.lock().unwrap().wait();
    }
}

// ---------------------------------------------------------------------------
// Инструменты агента browser_*
// ---------------------------------------------------------------------------

/// OpenAI-схемы browser-инструментов (мерджатся в get_tool_schemas)
pub fn browser_tool_schemas() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "browser_navigate",
                "description": "Open a URL in the managed headless browser. Waits for page load. Returns page title, URL and readiness.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "Full URL, e.g. https://example.com" }
                    },
                    "required": ["url"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "browser_read",
                "description": "Read visible text of the current page (truncated to 20k chars).",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "browser_screenshot",
                "description": "Take a JPEG screenshot of the viewport (1280x800). Returns an image you can see. Click coordinates must be taken from the last screenshot.",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "browser_click",
                "description": "Click at the given viewport coordinates (CSS pixels, same coordinate system as the screenshot). Returns the clicked element description.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "x": { "type": "integer", "description": "X coordinate" },
                        "y": { "type": "integer", "description": "Y coordinate" }
                    },
                    "required": ["x", "y"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "browser_type",
                "description": "Optionally click at coordinates, type text into the focused element, and optionally press Enter.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "Text to type" },
                        "x": { "type": "integer", "description": "Optional X coordinate to click first" },
                        "y": { "type": "integer", "description": "Optional Y coordinate to click first" },
                        "submit": { "type": "boolean", "description": "Press Enter after typing" }
                    },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "browser_scroll",
                "description": "Scroll the page vertically by dy pixels (positive = down).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "dy": { "type": "integer", "description": "Pixels to scroll" }
                    },
                    "required": ["dy"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "browser_close",
                "description": "Close the managed browser and end the session.",
                "parameters": { "type": "object", "properties": {} }
            }
        }
    ])
}

/// Навигация разрешена только на http/https: file:, data:, javascript: и пр.
/// позволяют добраться до локальных ресурсов или исполнить скрипт — запрещены.
fn is_navigable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Исполнение browser-инструмента на живом соединении (вызывается из lib.rs).
pub fn execute_on(conn: &BrowserConnection, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "browser_navigate" => {
            let url = arg_str(args, "url")?;
            if !is_navigable_url(&url) {
                return Err("only http/https URLs are allowed".to_string());
            }
            let result = conn.request(
                "Page.navigate",
                json!({ "url": url }),
            )?;
            if let Some(err) = result.get("errorText").and_then(|e| e.as_str()) {
                return Err(format!("navigation failed: {err}"));
            }
            let note = conn.wait_ready()?;
            Ok(format!("Navigated to {url}. {}", conn.describe()? + &note))
        }
        "browser_read" => {
            // innerText требует лэйаута — в headless бывает пуст; фолбэк textContent
            let text = conn.evaluate(
                "document.body ? (document.body.innerText || document.body.textContent || '') : ''",
            )?;
            let mut text = text.as_str().unwrap_or("").to_string();
            if text.len() > READ_TEXT_LIMIT {
                crate::truncate_at_char_boundary(&mut text, READ_TEXT_LIMIT);
                text.push_str("\n...[truncated]");
            }
            Ok(format!("{}\n\n--- page text ---\n{}", conn.describe()?, text))
        }
        "browser_screenshot" => {
            let result = conn.request(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": SCREENSHOT_QUALITY }),
            )?;
            let data = result
                .get("data")
                .and_then(|d| d.as_str())
                .ok_or("screenshot: no data in response")?;
            Ok(json!({
                "ok": true,
                "viewport": format!("{VIEWPORT_W}x{VIEWPORT_H}"),
                "dataUrl": format!("data:image/jpeg;base64,{data}")
            })
            .to_string())
        }
        "browser_click" => {
            let (x, y) = (arg_int(args, "x")?, arg_int(args, "y")?);
            let desc = conn.evaluate(&format!(
                "(() => {{ const el = document.elementFromPoint({x},{y}); \
                 if (!el) return 'no element at point'; \
                 const d = el.tagName + (el.id ? '#'+el.id : '') + \
                 (el.textContent ? ' «' + el.textContent.trim().slice(0,60) + '»' : ''); \
                 el.click(); return 'clicked: ' + d; }})()"
            ))?;
            Ok(desc.as_str().unwrap_or("clicked").to_string())
        }
        "browser_type" => {
            let text = arg_str(args, "text")?;
            if let (Some(x), Some(y)) = (arg_int_opt(args, "x"), arg_int_opt(args, "y")) {
                conn.evaluate(&format!(
                    "(() => {{ const el = document.elementFromPoint({x},{y}); \
                     if (!el) return 'no element at point'; el.click(); \
                     if (el.focus) el.focus(); return 'focused'; }})()"
                ))?;
            }
            conn.request(
                "Input.insertText",
                json!({ "text": text }),
            )?;
            if args.get("submit").and_then(|s| s.as_bool()) == Some(true) {
                conn.request(
                    "Input.dispatchKeyEvent",
                    json!({ "type": "rawKeyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r" }),
                )?;
                conn.request(
                    "Input.dispatchKeyEvent",
                    json!({ "type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 }),
                )?;
            }
            Ok(format!("typed {}", text.len()))
        }
        "browser_scroll" => {
            let dy = arg_int(args, "dy")?;
            conn.evaluate(&format!("window.scrollBy(0, {dy})"))?;
            Ok(format!("scrolled by {dy}"))
        }
        other => Err(format!("unknown browser tool: {other}")),
    }
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or(format!("missing required argument: {key}"))
}

fn arg_int(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(|v| v.as_i64())
        .ok_or(format!("missing required argument: {key}"))
}

fn arg_int_opt(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn browser_schemas_valid() {
        let v = browser_tool_schemas();
        let arr = v.as_array().expect("schemas must be an array");
        assert_eq!(arr.len(), 7);
        for schema in arr {
            assert_eq!(schema["type"], "function");
            let name = schema["function"]["name"].as_str().unwrap();
            assert!(name.starts_with("browser_"), "{name}");
        }
    }

    #[test]
    fn navigable_url_http_https_only() {
        assert!(is_navigable_url("https://example.com"));
        assert!(is_navigable_url("http://example.com/page"));
        assert!(!is_navigable_url("file:///C:/x"));
        assert!(!is_navigable_url("data:text/html,<h1>hi</h1>"));
        assert!(!is_navigable_url("javascript:alert(1)"));
        assert!(!is_navigable_url(""));
    }

    /// Мини-HTTP-сервер для e2e-теста: отдаёт одну тестовую страницу.
    /// Валидация is_navigable_url пропускает только http/https, поэтому старый
    /// трюк с data:-URL больше не проходит — поднимаем настоящий локальный
    /// сервер. Порт 0 → реальный свободный порт; accept крутится в фоновом
    /// потоке; остановка — AtomicBool + неблокирующий accept с коротким сном
    /// (если тест запаниковал, поток просто умирает вместе с процессом).
    fn spawn_test_http_server() -> (u16, Arc<AtomicBool>) {
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("cannot bind test http server");
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stop);
        std::thread::spawn(move || {
            listener.set_nonblocking(true).ok();
            loop {
                if stop_flag.load(Ordering::SeqCst) {
                    return; // тест закончен — гасим сервер
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(50)); // «таймаут accept»
                    continue;
                };
                // На Windows принятый сокет наследует неблокирующий режим
                // слушателя — возвращаем блокирующий, иначе read выйдет с
                // WouldBlock раньше, чем браузер успеет отправить запрос
                stream.set_nonblocking(false).ok();
                stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
                // Запрос читаем до конца заголовков ("\r\n\r\n") — у GET тела нет
                let mut req: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            req.extend_from_slice(&chunk[..n]);
                            if req.windows(4).position(|w| w == b"\r\n\r\n").is_some() {
                                break;
                            }
                        }
                    }
                }
                // Кириллица — строго UTF-8, поэтому charset в Content-Type
                let body = "<html><title>HaloUI Test</title><h1>Привет</h1>\
                            <button onclick='document.title=\"clicked\"'>go</button></html>";
                let len = body.len();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {len}\r\n\
                     Connection: close\r\n\r\n\
                     {body}"
                );
                let _ = stream.write_all(resp.as_bytes());
                // Сокет закроется при drop: Connection: close обязателен, иначе
                // браузер висит в keep-alive (см. комментарий к http_get_json)
            }
        });
        (port, stop)
    }

    /// Полный e2e против реального браузера, если он установлен.
    /// Нет браузера (CI/чистая машина) — тест молча пропускается.
    #[test]
    fn browser_e2e_if_available() {
        if find_browser_executable().is_none() {
            return;
        }
        // is_navigable_url пускает только http/https — вместо старого data:-URL
        // навигируемся на локальный HTTP-сервер с той же тестовой страницей
        let (port, stop_server) = spawn_test_http_server();
        let registry = BrowserRegistry::default();
        let conn = registry.get_or_launch().expect("browser must launch");
        let nav = execute_on(
            &conn,
            "browser_navigate",
            &json!({ "url": format!("http://127.0.0.1:{port}/") }),
        )
        .expect("navigate must succeed");
        assert!(nav.contains("HaloUI Test"), "got: {nav}");

        let read = execute_on(&conn, "browser_read", &json!({})).unwrap();
        assert!(read.contains("Привет"), "got: {read}");

        // Скриншот: валидный JSON с dataUrl jpeg
        let shot = execute_on(&conn, "browser_screenshot", &json!({})).unwrap();
        let parsed: Value = serde_json::from_str(&shot).unwrap();
        let data_url = parsed["dataUrl"].as_str().unwrap();
        assert!(data_url.starts_with("data:image/jpeg;base64,"));

        // Клик в фиксированную точку страницы: попадёт ли он в конкретный
        // элемент — заранее не знаем и не проверяем, важно лишь, что не падает
        let click = execute_on(&conn, "browser_click", &json!({ "x": 20, "y": 160 }))
            .expect("click must succeed");
        assert!(click.contains("clicked") || click.contains("no element"));

        // В execute_on нет ветки browser_close — гасим реестр напрямую,
        // как делает продакшн-путь в lib.rs
        registry.kill_all();

        // Сценарий прошёл — останавливаем тестовый сервер
        stop_server.store(true, Ordering::SeqCst);
    }
}
