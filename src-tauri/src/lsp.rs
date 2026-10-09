//! LSP-диагностики для агента: языковые серверы как фидбек-луп после правок.
//!
//! После fs_write код-файла агент раньше узнавал об ошибках компиляции только
//! из отдельного shell-вызова (tsc/cargo check) — дорогой шаг и лишние токены.
//! Здесь агент получает diagnostics прямо в результате правки: редактирование
//! → диагностики в том же turn'е → модель чинит сразу.
//!
//! Реализация — минимальный LSP-клиент поверх stdio (JSON-RPC с
//! Content-Length-фреймингом): initialize → initialized → didOpen/didChange
//! (полная синхронизация) → подписка на publishDiagnostics. Серверы спавнятся
//! лениво (первый diagnostics-вызов по языку), один на семейство расширений,
//! живут до выхода приложения или смены конфига. Никаких ответов не ждём:
//! сервер разбирает stdin последовательно, порядок initialize → didOpen
//! гарантирует корректную обработку без round-trip'а.
//!
//! Безопасность: инструмент read-only с path-контролем perm-слоя (в
//! fs-наборе perm.rs) — вне корней проекта и в sensitive-путях отказ, как у
//! fs_read. Диагностики никогда не ломают результат fs_write: авто-фидбек
//! best-effort, любая ошибка LSP молча пропускается.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};
use std::time::Duration;
use url::Url;

/// Потолок на один файл в памяти: больше — не открываем (гигантские бандлы
/// языковой сервер всё равно не осмыслит, а память уйдёт навсегда)
const FILE_READ_LIMIT: u64 = 2 * 1024 * 1024;
/// Потолок одного LSP-сообщения (publishDiagnostics мегапроектов)
const MESSAGE_CAP: usize = 16 * 1024 * 1024;
/// Ожидание publishDiagnostics: явный вызов инструмента (сервер мог
/// индексировать проект с нуля)
pub const DIAG_WAIT_TOOL: Duration = Duration::from_secs(10);
/// Ожидание авто-фидбека после fs_write: правка не должна стоить пользователю
/// секунд простоя ради «нет ошибок»
const DIAG_WAIT_FEEDBACK: Duration = Duration::from_secs(4);
/// Максимум диагностик в ответе модели (остальное сжимаем в «… и ещё N»)
const DIAGS_OUTPUT_CAP: usize = 40;
/// Максимум живых серверов: LRU-выселение (spawn нового при полном реестре
/// убивает самого старого)
const MAX_SERVERS: usize = 4;

// ---------------------------------------------------------------------------
// Конфигурация (вкладка «LSP-диагностики» в настройках, файл lsp.json)
// ---------------------------------------------------------------------------

/// Один пользовательский сервер: расширения ([".ts", ".tsx"]) + команда
/// PartialEq — сравнение старого/нового конфига в set_config (перезапуск)
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerEntry {
    pub extensions: Vec<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspConfig {
    /// Opt-in, как browser/computer: спавн языковых серверов без согласия
    /// пользователя (процессы + память) не делаем молча
    #[serde(default)]
    pub enabled: bool,
    /// Авто-диагностики в результате fs_write (фидбек-луп); выключение
    /// оставляет только явный инструмент diagnostics
    #[serde(default = "default_true")]
    pub auto_feedback: bool,
    /// Пусто — встроенные дефолты; непусто — ЗАМЕНЯЕТ дефолты целиком
    /// (частичный оверрайд путал бы, какой сервер реально отвечает)
    #[serde(default)]
    pub servers: Vec<LspServerEntry>,
}

fn default_true() -> bool {
    true
}

impl Default for LspConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_feedback: true,
            servers: Vec::new(),
        }
    }
}

static CONFIG: OnceLock<RwLock<LspConfig>> = OnceLock::new();

pub fn config() -> LspConfig {
    CONFIG
        .get_or_init(|| RwLock::new(LspConfig::default()))
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

pub fn set_config(cfg: LspConfig) {
    let lock = CONFIG.get_or_init(|| RwLock::new(LspConfig::default()));
    let changed_commands = {
        let cur = lock.read().unwrap_or_else(|p| p.into_inner());
        cur.enabled != cfg.enabled
            || cur.servers != cfg.servers
    };
    *lock.write().unwrap_or_else(|p| p.into_inner()) = cfg;
    // Смена набора серверов — старые процессы с прежними командами больше не
    // имеют смысла; следующий вызов переспавнит по новому конфигу
    if changed_commands {
        kill_all();
    }
}

/// Встроенные семейства: расширение → команда по умолчанию. Приоритет
/// разрешения: пользовательский конфиг, затем этот список по порядку
const FAMILIES: &[(&[&str], &str, &[&str])] = &[
    (
        &[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
        "typescript-language-server",
        &["--stdio"],
    ),
    (&[".rs"], "rust-analyzer", &[]),
    (&[".py"], "pyright-langserver", &["--stdio"]),
    (&[".go"], "gopls", &[]),
    (&[".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".cxx"], "clangd", &[]),
];

/// LSP languageId по расширению (серверы используют для парсера)
fn language_id(ext: &str) -> &'static str {
    match ext {
        ".ts" | ".mts" | ".cts" => "typescript",
        ".tsx" => "typescriptreact",
        ".jsx" => "javascriptreact",
        ".js" | ".mjs" | ".cjs" => "javascript",
        ".rs" => "rust",
        ".py" => "python",
        ".go" => "go",
        ".cpp" | ".cc" | ".hpp" | ".hh" | ".cxx" => "cpp",
        _ => "c",
    }
}

/// Разрешение сервера для расширения (ext с точкой, регистр не важен):
/// пользовательский конфиг перекрывает встроенные семейства
fn resolve_server(ext: &str) -> Option<LspServerEntry> {
    let ext = ext.to_ascii_lowercase();
    let cfg = config();
    for s in &cfg.servers {
        if s.extensions.iter().any(|e| e.to_ascii_lowercase() == ext) && !s.command.trim().is_empty() {
            return Some(s.clone());
        }
    }
    if !cfg.servers.is_empty() {
        // Непустой пользовательский список замещает дефолты целиком
        return None;
    }
    for (exts, command, args) in FAMILIES {
        if exts.contains(&ext.as_str()) {
            return Some(LspServerEntry {
                extensions: exts.iter().map(|s| s.to_string()).collect(),
                command: command.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
            });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Фрейминг JSON-RPC (Content-Length)
// ---------------------------------------------------------------------------

/// Чтение одного LSP-сообщения: заголовки до пустой строки, затем ровно
/// Content-Length байт. EOF → None (сервер умер). Потолок MESSAGE_CAP:
/// сервер, шлющий гигабайты одним сообщением, не должен раздувать память
fn read_message(r: &mut dyn BufRead) -> std::io::Result<Option<Vec<u8>>> {
    /// Суммарный потолок заголовочной секции: построчный 4 КБ ограничивает
    /// память одной строки, но сервер, льющий мусор без '\n' или бесконечную
    /// серию заголовков, раньше крутил поток-читатель в CPU-цикле до EOF
    /// (аудит 07.10 A2-12)
    const HEADER_SECTION_CAP: usize = 64 * 1024;
    let mut content_length: Option<usize> = None;
    let mut header_bytes: usize = 0;
    loop {
        let mut line = Vec::new();
        // read_until('\n') с потолком: заголовочная строка больше 4 КБ —
        // патологический сервер, рвём соединение
        let n = r.take(4096).read_until(b'\n', &mut line)?;
        if n == 0 {
            return Ok(None); // EOF
        }
        header_bytes += n;
        if header_bytes > HEADER_SECTION_CAP {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "LSP header section too large",
            ));
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            break;
        }
        if let Some(v) = text
            .split_once(':')
            .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        {
            content_length = Some(v);
        }
        // take(4096) съел ровно прочитанное — новый take продолжит с той же
        // позиции (read_until прочитал до '\n' в пределах 4096)
    }
    let Some(len) = content_length else {
        // Сообщение без Content-Length не по стандарту — пропускаем пустоту
        return Ok(Some(Vec::new()));
    };
    if len > MESSAGE_CAP {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "LSP message too large",
        ));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    Ok(Some(body))
}

// ---------------------------------------------------------------------------
// Реестр живых серверов
// ---------------------------------------------------------------------------

/// Ожидание «устаканившихся» диагностик: rust-analyzer публикует серией
/// (пустая → синтаксис → семантика+flycheck), решение по ПЕРВОЙ публикации
/// давало ложное «чисто» посреди серии. Серия закончена, если grace-окно не
/// принесло ни новой публикации, ни активного $/progress (flycheck/индексация
/// ходят через workDoneProgress), и прошло минимальное окно наблюдения;
/// общий дедлайн страхует
const PUBLISH_GRACE: Duration = Duration::from_millis(1200);
/// Минимальное окно наблюдения после didOpen: семантика rust-analyzer часто
/// приходит через несколько секунд после мгновенной синтаксической публикации
pub const SETTLE_MIN_TOOL: Duration = Duration::from_secs(8);
const SETTLE_MIN_FEEDBACK: Duration = Duration::from_secs(3);

/// Ключ URI в карте диагностик. rust-analyzer (и другие url-crate серверы)
/// канонизируют эхо-URI: диск `C:` уходит в нижний регистр — точный матч
/// строкой на Windows никогда не сходился. Ключи нормализуем обеих сторон
fn uri_key(uri: &str) -> String {
    if cfg!(windows) {
        uri.to_ascii_lowercase()
    } else {
        uri.to_string()
    }
}

struct FileDiags {
    /// Счётчик публикаций для URI: вызов фиксирует seq ДО didOpen/didChange
    /// и ждёт seq > зафиксированного — признак «свежей» публикации
    seq: u64,
    items: Vec<Value>,
    last: std::time::Instant,
}

struct ServerHandle {
    /// None после закрытия stdin при выселении/kill
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Child>,
    opened: Mutex<HashMap<String, i32>>,
    diags: Mutex<HashMap<String, FileDiags>>,
    /// Последний отправленный/загруженный rootUri: didChangeWorkspaceFolders
    /// только при фактической смене — повторные added-события запускали у
    /// серверов индексацию заново
    current_root: Mutex<Option<String>>,
    /// Активные workDoneProgress-токены → момент последней активности:
    /// «устаканилось» = нет свежей активности ни по публикациям, ни по прогрессу
    progress: Mutex<HashMap<String, std::time::Instant>>,
    /// Хвост stderr: серверы пишут туда причину падения, без неё отказ
    /// «сервер умер» неотладуем (e2e на rust-analyzer показал ровно это)
    stderr_tail: Arc<Mutex<String>>,
    cv: Condvar,
    dead: AtomicBool,
    /// Порядок выселения LRU
    born: std::time::Instant,
}

impl ServerHandle {
    fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
            || self
                .child
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .try_wait()
                .map(|s| s.is_some())
                .unwrap_or(true)
    }

    fn send(&self, msg: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().map_err(|e| e.to_string())?;
        let Some(w) = guard.as_mut() else {
            return Err("lsp server stdin closed".into());
        };
        write!(w, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
        w.write_all(&body).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    fn current_seq(&self, uri: &str) -> u64 {
        self.diags
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&uri_key(uri))
            .map(|d| d.seq)
            .unwrap_or(0)
    }

    /// Ждать УСТАКАНИВШУЮСЯ свежую публикацию для uri: seq > since, затем
    /// тишина по публикациям и $/progress в течение grace и минимальное окно
    /// наблюдения. publishDiagnostics с пустым массивом — тоже публикация:
    /// «чисто» нельзя отличить от «молчит» иначе как по факту публикации
    fn wait_settled(
        &self,
        uri: &str,
        since: u64,
        timeout: Duration,
        min_observation: Duration,
    ) -> bool {
        let start = std::time::Instant::now();
        let deadline = start + timeout;
        let mut guard = self.diags.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            let fresh = guard
                .get(&uri_key(uri))
                .is_some_and(|d| d.seq > since && d.last.elapsed() >= PUBLISH_GRACE);
            let progress_quiet = self
                .progress
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .values()
                .all(|t| t.elapsed() >= PUBLISH_GRACE);
            if fresh && progress_quiet && start.elapsed() >= min_observation {
                return true;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                // Дедлайн: свежая публикация была, но тишины не настало —
                // отдаём последнюю версию, лучше старее, чем ничего
                return guard
                    .get(&uri_key(uri))
                    .is_some_and(|d| d.seq > since);
            }
            let wait = deadline
                .min(now + PUBLISH_GRACE)
                .saturating_duration_since(now);
            let (g, _res) = self
                .cv
                .wait_timeout(guard, wait)
                .unwrap_or_else(|p| p.into_inner());
            guard = g;
        }
    }

    fn items(&self, uri: &str) -> Vec<Value> {
        self.diags
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&uri_key(uri))
            .map(|d| d.items.clone())
            .unwrap_or_default()
    }

    /// didOpen при первом касании, далее didChange (полная синхронизация —
    /// не считаем диффы: файл только что записан, текст уже в руке)
    fn notify_content(&self, uri: &str, lang: &str, text: &str) -> Result<(), String> {
        let mut opened = self.opened.lock().map_err(|e| e.to_string())?;
        match opened.get_mut(uri) {
            None => {
                let version = 1;
                opened.insert(uri.to_string(), version);
                drop(opened);
                self.send(&json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/didOpen",
                    "params": {
                        "textDocument": {
                            "uri": uri, "languageId": lang, "version": version, "text": text
                        }
                    }
                }))
            }
            Some(v) => {
                *v += 1;
                let version = *v;
                drop(opened);
                self.send(&json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/didChange",
                    "params": {
                        "textDocument": { "uri": uri, "version": version },
                        "contentChanges": [{ "text": text }]
                    }
                }))
            }
        }
    }
}

fn spawn_process(command: &str, args: &[String]) -> std::io::Result<Child> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // CREATE_NO_WINDOW: консольный .exe из GUI-процесса мигал бы окном
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        // Своя процесс-группа (pgid == pid): гашение идёт через
        // proc::kill_tree → kill(-pgid), который гасит и внуков
        // npx-обёрток; сам по себе process_group внуков не гасит
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    // cmd /C-фолбэк нужен только на Windows (.cmd-файлы); на unix лишний
    // match — needless_match, поэтому ветка целиком под cfg(windows)
    #[cfg(windows)]
    match cmd.spawn() {
        Ok(c) => Ok(c),
        Err(direct_err) => {
            {
                // typescript-language-server и компания — .cmd-файлы:
                // CreateProcess их не исполняет, как в mcp.rs — cmd /C с
                // raw_arg (фикс BatBadBut: args экранирует std)
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let mut c = Command::new("cmd");
                c.raw_arg("/C").raw_arg(command).args(args);
                c.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map_err(|_| direct_err)
            }
        }
    }
    #[cfg(not(windows))]
    cmd.spawn()
}

/// (ключ сервера, хендл): ключ = команда+args, дедуп переспавна того же
type ServerRegistry = Vec<(String, Arc<ServerHandle>)>;

static REGISTRY: OnceLock<Mutex<ServerRegistry>> = OnceLock::new();

fn registry() -> &'static Mutex<Vec<(String, Arc<ServerHandle>)>> {
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

fn spawn_handle(entry: &LspServerEntry, root: &str) -> Result<Arc<ServerHandle>, String> {
    let mut child = spawn_process(&entry.command, &entry.args)
        .map_err(|e| format!("cannot start LSP server \"{}\": {e}", entry.command))?;
    let stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("lsp server has no stdin".into());
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("lsp server has no stdout".into());
        }
    };
    // stderr нужно вычитывать, иначе сервер, пишущий много диагностики запуска,
    // блокируется на записи в полный пайп (класс ложно-зависших MCP-серверов);
    // храним только хвост — для сообщения об упавшем сервере
    let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(|l| l.ok()) {
                let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
                // Хвост 8 КБ: старые строки вытесняем
                if t.len() + line.len() > 8 * 1024 {
                    t.clear();
                }
                t.push_str(&line);
                t.push('\n');
            }
        });
    }

    let handle = Arc::new(ServerHandle {
        stdin: Mutex::new(Some(Box::new(stdin))),
        child: Mutex::new(child),
        opened: Mutex::new(HashMap::new()),
        diags: Mutex::new(HashMap::new()),
        current_root: Mutex::new(Some(root.to_string())),
        progress: Mutex::new(HashMap::new()),
        stderr_tail: Arc::clone(&stderr_tail),
        cv: Condvar::new(),
        dead: AtomicBool::new(false),
        born: std::time::Instant::now(),
    });

    // Читатель stdout: публикуем только publishDiagnostics; на ЗАПРОСЫ
    // сервера (id + method — client/registerCapability, window/workDoneProgress/
    // create и т.п.) отвечаем null-результатом, иначе строгие серверы
    // (rust-analyzer) ждут ответа и не публикуют диагностики. Собственные
    // ответы (id без method) нам не нужны — initialize не ждём: сервер
    // разбирает stdin последовательно, didOpen гарантированно после init
    let diags = Arc::clone(&handle);
    let dead_flag = Arc::clone(&handle);
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        loop {
            match read_message(&mut reader) {
                Ok(Some(bytes)) if bytes.is_empty() => continue,
                Ok(Some(bytes)) => {
                    let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else {
                        continue;
                    };
                    let is_request =
                        msg.get("id").is_some() && msg.get("method").is_some();
                    if is_request {
                        let _ = diags.send(&json!({
                            "jsonrpc": "2.0",
                            "id": msg["id"].clone(),
                            "result": Value::Null,
                        }));
                        continue;
                    }
                    if msg.get("method").and_then(|m| m.as_str()) == Some("$/progress") {
                        // Активность воркспейсных задач (flycheck, индексация,
                        // загрузка): пока они не стихнут, публикация может
                        // быть не финальной. Токен бывает строкой и числом
                        let params = &msg["params"];
                        let token = params["token"]
                            .as_str()
                            .map(String::from)
                            .or_else(|| params["token"].as_i64().map(|t| t.to_string()))
                            .unwrap_or_default();
                        let kind = params["value"]["kind"].as_str().unwrap_or("");
                        let mut act =
                            diags.progress.lock().unwrap_or_else(|p| p.into_inner());
                        if kind == "end" {
                            act.remove(&token);
                        } else if !token.is_empty() {
                            act.insert(token, std::time::Instant::now());
                        }
                        diags.cv.notify_all();
                        continue;
                    }
                    if msg.get("method").and_then(|m| m.as_str())
                        != Some("textDocument/publishDiagnostics")
                    {
                        continue;
                    }
                    let params = &msg["params"];
                    let Some(uri) = params["uri"].as_str().map(String::from) else {
                        continue;
                    };
                    let items = params["diagnostics"].as_array().cloned().unwrap_or_default();
                    let key = uri_key(&uri);
                    {
                        let mut map = diags.diags.lock().unwrap_or_else(|p| p.into_inner());
                        let entry = map
                            .entry(key)
                            .or_insert(FileDiags { seq: 0, items: Vec::new(), last: std::time::Instant::now() });
                        entry.seq += 1;
                        entry.items = items;
                        entry.last = std::time::Instant::now();
                    }
                    diags.cv.notify_all();
                }
                Ok(None) | Err(_) => {
                    // EOF или битый фрейминг — сервер умер; ждущие «свежую
                    // публикацию» иначе висели бы до таймаута
                    dead_flag.dead.store(true, Ordering::Relaxed);
                    diags.cv.notify_all();
                    break;
                }
            }
        }
    });

    // Рукопожатие: initialize сразу с корнем воркспейса (не после спавна —
    // didChangeWorkspaceFolders не покрывает стартовый каталог) + initialized.
    // Ответ не читаем — см. комментарий к читателю
    let root_uri = path_to_uri(root).ok();
    handle
        .send(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "rootUri": root_uri.clone().map(|u: String| Value::String(u)).unwrap_or(Value::Null),
                "workspaceFolders": root_uri.map(|u: String| json!([{ "uri": u, "name": root }])).unwrap_or(Value::Null),
                "capabilities": {
                    "workspace": { "workspaceFolders": true, "configuration": false },
                    "textDocument": { "synchronization": { "didSave": false } }
                },
            }
        }))
        .map_err(|e| {
            // Гашение деревом (аудит 07.10 A2-10): npx-обёртки и cmd-шим
            // порождают внуков, std Child::kill сигналит только прямому
            // потомку — выживший внук держал пайпы и reader-поток
            let pid = handle.child.lock().unwrap_or_else(|p| p.into_inner()).id();
            crate::proc::kill_tree(pid);
            let _ = handle.child.lock().unwrap_or_else(|p| p.into_inner()).wait();
            format!("lsp initialize failed: {e}")
        })?;
    let _ = handle.send(&json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}));
    Ok(handle)
}

fn ensure_server(entry: &LspServerEntry, root: &str) -> Result<Arc<ServerHandle>, String> {
    let key = format!("{}\u{1}{}", entry.command, entry.args.join("\u{1}"));
    let mut reg = registry().lock().map_err(|e| e.to_string())?;
    // A2-9 (аудит 07.10): мёртвые записи выносим ДО поиска — раньше мёртвая
    // same-key запись навсегда заслоняла живой хендл (find брал первую по
    // порядку), и каждый вызов diagnostics пересоздавал сервер с полной
    // индексацией, пока мёртвую не выселял LRU (до MAX_SERVERS спавнов)
    reg.retain(|(_, h)| !h.is_dead());
    if let Some((_, h)) = reg.iter().find(|(k, _)| *k == key) {
        return Ok(Arc::clone(h));
    }
    // LRU-выселение: реестр полон ЖИВЫХ серверов — самый старый умирает
    if reg.len() >= MAX_SERVERS {
        if let Some((_, oldest)) = reg.iter().min_by_key(|(_, h)| h.born) {
            let idx = reg
                .iter()
                .position(|(_, h)| Arc::ptr_eq(h, oldest))
                .unwrap_or(0);
            let (_, victim) = reg.remove(idx);
            victim.dead.store(true, Ordering::Relaxed);
            if let Ok(mut g) = victim.stdin.lock() {
                *g = None; // закрытие stdin: серверы обычно выходят сами
            }
            // Деревом: см. комментарий initialize-ветки выше
            let mut child = victim.child.lock().unwrap_or_else(|p| p.into_inner());
            crate::proc::kill_tree(child.id());
            let _ = child.wait();
        }
    }
    let handle = spawn_handle(entry, root)?;
    reg.push((key, Arc::clone(&handle)));
    Ok(handle)
}

/// Погасить все живые серверы (выход приложения, смена конфига)
pub fn kill_all() {
    let Ok(mut reg) = registry().lock() else { return };
    for (_, h) in reg.drain(..) {
        h.dead.store(true, Ordering::Relaxed);
        if let Ok(mut g) = h.stdin.lock() {
            *g = None;
        }
        // Деревом: см. комментарий initialize-ветки выше
        let mut child = h.child.lock().unwrap_or_else(|p| p.into_inner());
        crate::proc::kill_tree(child.id());
        let _ = child.wait();
    }
}

// ---------------------------------------------------------------------------
// Клиент: diagnostics для файла
// ---------------------------------------------------------------------------

/// Корень воркспейса: подъём от файла до маркера проекта (до 12 уровней).
/// rust-analyzer без Cargo.toml и tsserver без tsconfig молча не работают,
/// поэтому маркеры важны; без маркеров — каталог файла
pub fn find_workspace_root(path: &str) -> String {
    const MARKERS: &[&str] = &[
        "Cargo.toml", "package.json", "pyproject.toml", "go.mod", ".git",
        "tsconfig.json", "setup.py", "requirements.txt", "CMakeLists.txt",
    ];
    let mut dir = match std::path::Path::new(path).parent() {
        Some(d) => d.to_path_buf(),
        None => return ".".into(),
    };
    for _ in 0..12 {
        if MARKERS.iter().any(|m| dir.join(m).exists()) {
            return dir.to_string_lossy().to_string();
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    match std::path::Path::new(path).parent() {
        Some(d) => d.to_string_lossy().to_string(),
        None => ".".into(),
    }
}

fn path_to_uri(path: &str) -> Result<String, String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err(format!("path must be absolute: {path}"));
    }
    Url::from_file_path(p)
        .map(|u| u.to_string())
        .map_err(|_| format!("cannot convert path to URI: {path}"))
}

fn severity_label(sev: Option<i64>) -> &'static str {
    match sev {
        Some(1) => "error",
        Some(2) => "warning",
        Some(3) => "info",
        Some(4) => "hint",
        _ => "diag",
    }
}

/// Единый формат ответа: severity-сортировка, однострочные сообщения, кап.
/// Модель читает это как текст — файл:строка:колонка, ярлык серьёзности
pub fn format_diagnostics(items: &[Value]) -> String {
    let mut rows: Vec<(i64, i64, i64, String)> = Vec::new();
    for d in items {
        let line = d["range"]["start"]["line"].as_i64().unwrap_or(0);
        let col = d["range"]["start"]["character"].as_i64().unwrap_or(0);
        let sev = d["severity"].as_i64().unwrap_or(0);
        let mut message = d["message"]
            .as_str()
            .unwrap_or("(no message)")
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        crate::truncate_at_char_boundary(&mut message, 240);
        let source = d["source"].as_str().unwrap_or("");
        let code = match d["code"].as_str() {
            Some(s) => s.to_string(),
            None => d["code"].as_i64().map(|c| c.to_string()).unwrap_or_default(),
        };
        let mut text = String::new();
        if !source.is_empty() {
            text.push_str(source);
            text.push_str(": ");
        }
        text.push_str(&message);
        if !code.is_empty() {
            text.push_str(&format!(" ({code})"));
        }
        rows.push((sev, line, col, text));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let total = rows.len();
    let mut out = String::new();
    for (sev, line, col, text) in rows.iter().take(DIAGS_OUTPUT_CAP) {
        out.push_str(&format!(
            "L{}:{} {}: {}\n",
            line + 1,
            col + 1,
            severity_label(Some(*sev)),
            text
        ));
    }
    if total > DIAGS_OUTPUT_CAP {
        out.push_str(&format!("… and {} more\n", total - DIAGS_OUTPUT_CAP));
    }
    out
}

/// Диагностики одного файла: публичная точка и для инструмента, и для
/// авто-фидбека. Блокирующий вызов (spawn/чтение/ожидание публикации) —
/// из spawn_blocking. min_observation — минимальное окно наблюдения после
/// didOpen: семантика часто приходит через секунды после синтаксической
/// публикации, мгновенный ответ ловил бы только её
pub fn diagnostics_for_file(
    path: &str,
    timeout: Duration,
    min_observation: Duration,
) -> Result<String, String> {
    if !config().enabled {
        return Err("LSP diagnostics is disabled in Settings".into());
    }
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .ok_or_else(|| format!("file has no extension: {path}"))?;
    let Some(entry) = resolve_server(&ext) else {
        return Err(format!(
            "no language server configured for {ext} (see Settings → LSP diagnostics)"
        ));
    };
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot stat {path:?}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path:?} is not a regular file"));
    }
    if meta.len() > FILE_READ_LIMIT {
        return Err(format!(
            "file too large for diagnostics: {} bytes (limit {FILE_READ_LIMIT})",
            meta.len()
        ));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path:?}: {e}"))?;
    let uri = path_to_uri(path)?;
    let root = find_workspace_root(path);
    let handle = ensure_server(&entry, &root)?;

    // didChangeWorkspaceFolders — только при фактической смене воркспейса
    // (стартовый корень уже в initialize): повторные added-события запускали
    // у серверов индексацию заново
    if let Ok(root_uri) = path_to_uri(&root) {
        let mut cur = handle
            .current_root
            .lock()
            .map_err(|e| e.to_string())?;
        if cur.as_deref() != Some(root.as_str()) {
            handle
                .send(&json!({
                    "jsonrpc": "2.0",
                    "method": "workspace/didChangeWorkspaceFolders",
                    "params": { "event": { "added": [{ "uri": root_uri, "name": root }], "removed": [] } }
                }))
                .map_err(|e| format!("lsp workspace change failed: {e}"))?;
            *cur = Some(root);
        }
    }

    let since = handle.current_seq(&uri);
    handle.notify_content(&uri, language_id(&ext), &text)?;
    if !handle.wait_settled(&uri, since, timeout, min_observation) {
        // Сервер умер, не опубликовав: ждущие не висят (dead-флаг бампает
        // condvar), но публикации нет — честный отказ вместо пустого ответа.
        // Хвост stderr — единственное место, где сервер объясняет падение
        if handle.is_dead() {
            let tail = handle
                .stderr_tail
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            let note = if tail.trim().is_empty() {
                String::new()
            } else {
                format!("\nserver stderr:\n{}", tail.trim())
            };
            return Err(format!(
                "LSP server \"{}\" exited before publishing diagnostics{note}",
                entry.command
            ));
        }
        return Err(format!(
            "no diagnostics published within {}s — server may still be indexing; retry",
            timeout.as_secs()
        ));
    }
    let items = handle.items(&uri);
    if items.is_empty() {
        return Ok("No diagnostics — file is clean.".to_string());
    }
    Ok(format_diagnostics(&items))
}

// ---------------------------------------------------------------------------
// Схема инструмента + авто-фидбек fs_write
// ---------------------------------------------------------------------------

pub fn lsp_tool_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "diagnostics",
            "description": "Get compiler/linter diagnostics (errors, warnings) for a source file from its language server (LSP). Call it right after editing or creating a code file (fs_write) to catch type and compile errors immediately, and before finishing a coding task on every file you changed. Much cheaper than running the whole build via shell_run.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute file path to check" }
                },
                "required": ["path"]
            }
        }
    })
}

/// Авто-фидбек включён? (дешёвая проверка до клонирования результата fs_write)
pub fn feedback_enabled() -> bool {
    let cfg = config();
    cfg.enabled && cfg.auto_feedback
}

/// Обогащение результата fs_write диагностиками правленного файла.
/// ВСЁ best-effort: битый JSON, выключенный LSP, отсутствие сервера, таймаут —
/// результат правки возвращается без изменений. Правка не должна падать или
/// молчать из-за проблем обвязки диагностики
pub fn edit_feedback(fs_write_result: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<Value>(fs_write_result) else {
        return fs_write_result.to_string();
    };
    let Some(path) = parsed["path"].as_str() else {
        return fs_write_result.to_string();
    };
    let text = match diagnostics_for_file(path, DIAG_WAIT_FEEDBACK, SETTLE_MIN_FEEDBACK) {
        Ok(t) => t,
        Err(_) => return fs_write_result.to_string(),
    };
    format!("{fs_write_result}\n\n[lsp diagnostics for {path}]\n{text}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Глобалы lsp (CONFIG/REGISTRY) общие на процесс тестов: set_config при
    /// смене команд дренажит реестр через kill_all — тесты, трогающие глобалы,
    /// сериализуются, иначе чужой set_config убивал живой хендл посреди теста
    /// (класс «глобал-стейт в параллельных тестах», правило 26 промта аудита)
    static GLOBALS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn read_message_parses_framing() {
        let body = br#"{"jsonrpc":"2.0"}"#;
        let mut buf = Vec::new();
        buf.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
        buf.extend_from_slice(body);
        let mut cursor = std::io::Cursor::new(buf);
        let msg = read_message(&mut cursor).unwrap().unwrap();
        assert_eq!(msg, body.to_vec());
    }

    #[test]
    fn read_message_skips_other_headers_and_eof_is_none() {
        let body = b"{}";
        let mut buf = Vec::new();
        buf.extend_from_slice(b"Content-Type: application/vscode-jsonrpc; charset=utf8\r\n");
        buf.extend_from_slice(format!("content-length: {}\r\n\r\n", body.len()).as_bytes());
        buf.extend_from_slice(body);
        let mut cursor = std::io::Cursor::new(buf);
        assert_eq!(read_message(&mut cursor).unwrap().unwrap(), body.to_vec());
        // EOF без заголовков
        assert!(read_message(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn read_message_rejects_oversize() {
        let mut buf = Vec::new();
        buf.extend_from_slice(format!("Content-Length: {}\r\n\r\n", MESSAGE_CAP + 1).as_bytes());
        let mut cursor = std::io::Cursor::new(buf);
        assert!(read_message(&mut cursor).is_err());
    }

    #[test]
    fn read_message_rejects_header_flood() {
        // A2-12 (аудит 07.10): сервер, льющий заголовки без пустой строки,
        // раньше крутил читатель вечно — суммарный потолок секции рвёт
        let mut buf = Vec::new();
        for i in 0..4096 {
            buf.extend_from_slice(format!("X-Fill-{i}: 0123456789abcdef\r\n").as_bytes());
        }
        let mut cursor = std::io::Cursor::new(buf);
        let err = read_message(&mut cursor).unwrap_err();
        assert!(err.to_string().contains("header section too large"));
    }

    /// Dummy-процесс-«сервер»: живёт, ничего не говорит — только чтобы у
    /// реестра был настоящий Child (is_dead/kill_tree работают по нему)
    fn dummy_entry() -> LspServerEntry {
        if cfg!(windows) {
            LspServerEntry {
                extensions: vec![".rs".into()],
                command: "ping".into(),
                args: vec!["-n".into(), "120".into(), "127.0.0.1".into()],
            }
        } else {
            LspServerEntry {
                extensions: vec![".rs".into()],
                command: "sleep".into(),
                args: vec!["120".into()],
            }
        }
    }

    #[test]
    fn ensure_server_replaces_dead_entry_without_respawn_loop() {
        // A2-9 (аудит 07.10): мёртвая same-key запись не должна заслонять
        // живой хендл — ensure_server обязан заменить её ровно один раз,
        // а живой переиспользовать (раньше каждый вызов спавнил новый сервер)
        let _globals = GLOBALS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let entry = dummy_entry();
        let h1 = ensure_server(&entry, &root).unwrap();
        {
            let mut child = h1.child.lock().unwrap_or_else(|p| p.into_inner());
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(h1.is_dead(), "dummy must be reaped");
        let h2 = ensure_server(&entry, &root).unwrap();
        assert!(!Arc::ptr_eq(&h1, &h2), "dead entry must be replaced");
        let h3 = ensure_server(&entry, &root).unwrap();
        assert!(Arc::ptr_eq(&h2, &h3), "live handle must be reused");
        kill_all();
    }

    #[test]
    fn language_ids_cover_families() {
        assert_eq!(language_id(".ts"), "typescript");
        assert_eq!(language_id(".tsx"), "typescriptreact");
        assert_eq!(language_id(".jsx"), "javascriptreact");
        assert_eq!(language_id(".rs"), "rust");
        assert_eq!(language_id(".py"), "python");
        assert_eq!(language_id(".go"), "go");
        assert_eq!(language_id(".cpp"), "cpp");
        assert_eq!(language_id(".c"), "c");
    }

    #[test]
    fn resolve_server_defaults_and_user_override() {
        let _globals = GLOBALS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Пользовательский список пуст → дефолты
        set_config(LspConfig::default());
        let ts = resolve_server(".TS").expect("default ts server");
        assert_eq!(ts.command, "typescript-language-server");
        assert!(resolve_server(".unknown").is_none());

        // Непустой пользовательский список замещает дефолты целиком
        set_config(LspConfig {
            enabled: true,
            auto_feedback: true,
            servers: vec![LspServerEntry {
                extensions: vec![".rs".into()],
                command: "my-ra".into(),
                args: vec![],
            }],
        });
        assert_eq!(resolve_server(".rs").unwrap().command, "my-ra");
        // ts больше не резолвится: замещение, а не слияние
        assert!(resolve_server(".ts").is_none());
        set_config(LspConfig::default());
    }

    #[test]
    fn format_diagnostics_sorts_and_caps() {
        let items = vec![
            json!({"range": {"start": {"line": 9, "character": 0}}, "severity": 2, "message": "warn msg", "source": "tsc"}),
            json!({"range": {"start": {"line": 0, "character": 4}}, "severity": 1, "message": "err\nsecond line", "code": "E0001"}),
        ];
        let out = format_diagnostics(&items);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        // error выше warning, несмотря на порядок входа
        assert!(lines[0].starts_with("L1:5 error:"));
        assert!(lines[0].contains("err") && !lines[0].contains('\n'));
        assert!(lines[1].starts_with("L10:1 warning:"));
        assert!(lines[1].starts_with("L10:1 warning: tsc: warn msg"));
        // Пустой набор — пустой вывод (решение «чисто/нечисто» принимает вызов)
        assert_eq!(format_diagnostics(&[]), "");
    }

    #[test]
    fn format_diagnostics_caps_output() {
        let items: Vec<Value> = (0..60)
            .map(|i| {
                json!({"range": {"start": {"line": i, "character": 0}}, "severity": 1, "message": "x"})
            })
            .collect();
        let out = format_diagnostics(&items);
        assert_eq!(out.lines().count(), DIAGS_OUTPUT_CAP + 1); // кап + строка «… and N more»
        assert!(out.contains("and 20 more"));
    }

    #[test]
    fn workspace_root_finds_marker() {
        let dir = std::env::temp_dir().join(format!("haloui-lsp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("proj/src/deep")).unwrap();
        std::fs::write(dir.join("proj/Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        std::fs::write(dir.join("proj/src/deep/a.rs"), "fn main() {}").unwrap();
        let root = find_workspace_root(&dir.join("proj/src/deep/a.rs").to_string_lossy());
        assert_eq!(root, dir.join("proj").to_string_lossy().to_string());
        // Файл без маркеров → каталог файла
        let loose = dir.join("loose");
        std::fs::create_dir_all(&loose).unwrap();
        std::fs::write(loose.join("b.txt"), "").unwrap();
        let root2 = find_workspace_root(&loose.join("b.txt").to_string_lossy());
        assert_eq!(root2, loose.to_string_lossy().to_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_to_uri_windows_and_relative() {
        assert!(path_to_uri("relative/file.rs").is_err());
        let abs = std::env::temp_dir().join("uri-check.rs");
        let uri = path_to_uri(&abs.to_string_lossy()).unwrap();
        assert!(uri.starts_with("file://"));
    }

    #[test]
    fn tool_schema_wellformed() {
        let s = lsp_tool_schema();
        assert_eq!(s["function"]["name"], "diagnostics");
        assert!(s["function"]["parameters"]["properties"]["path"].is_object());
        assert_eq!(
            s["function"]["parameters"]["required"],
            serde_json::json!(["path"])
        );
    }

    #[test]
    fn edit_feedback_passes_through_on_garbage() {
        assert_eq!(edit_feedback("not json"), "not json");
        assert_eq!(edit_feedback("{\"no\":\"path\"}"), "{\"no\":\"path\"}");
    }

    #[test]
    fn edit_feedback_disabled_is_noop() {
        let _globals = GLOBALS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_config(LspConfig::default()); // enabled = false
        let res = edit_feedback("{\"path\":\"C:\\\\x.rs\"}");
        assert!(!res.contains("lsp diagnostics"));
    }

    /// Полный раундтрип с настоящим rust-analyzer: спавн, didOpen,
    /// publishDiagnostics, парсинг ошибки типов. #[ignore] — сервер не у всех
    /// в PATH, а первый запуск индексирует воркспейс (секунды); прогон вручную:
    ///   cargo test -p nocturn lsp_e2e -- --ignored --nocapture
    /// (тест выполнялся на реальном rust-analyzer при вводе фичи)
    #[test]
    #[ignore]
    fn lsp_e2e_rust_analyzer_reports_type_error() {
        let ra = find_on_path("rust-analyzer");
        let Some(ra) = ra else {
            eprintln!("skipped: rust-analyzer not on PATH");
            return;
        };
        let dir = std::env::temp_dir().join(format!("haloui-lsp-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"lsp-e2e\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("src/main.rs"),
            "fn main() {\n    let x: i32 = \"not a number\";\n    let _ = x;\n}\n",
        )
        .unwrap();

        set_config(LspConfig {
            enabled: true,
            auto_feedback: true,
            servers: vec![LspServerEntry {
                extensions: vec![".rs".into()],
                command: ra,
                args: vec![],
            }],
        });
        let file = dir.join("src/main.rs").to_string_lossy().to_string();
        let out = diagnostics_for_file(
            &file,
            std::time::Duration::from_secs(120),
            std::time::Duration::from_secs(15),
        )
        .expect("diagnostics roundtrip must succeed");
        eprintln!("--- server output ---\n{out}");
        assert!(out.contains("error"), "expected a type error, got: {out}");
        assert!(out.contains("i32") || out.contains("expected"), "got: {out}");

        set_config(LspConfig::default());
        kill_all();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Поиск исполняемого в PATH (where/which недоступны одинаково на всех ОС)
    fn find_on_path(name: &str) -> Option<String> {
        let exe = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        let path = std::env::var("PATH").ok()?;
        std::env::split_paths(&path)
            .map(|d| d.join(&exe))
            .find(|p| p.is_file())
            .map(|p| p.to_string_lossy().to_string())
    }
}
