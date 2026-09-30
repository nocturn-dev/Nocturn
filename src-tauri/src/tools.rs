//! M2: Реестр инструментов агента.
//! Каждый инструмент: OpenAI JSON Schema (для запроса к модели) + execute().

use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

const FS_READ_LIMIT: u64 = 256 * 1024; // 256 КБ на чтение файла
const SHELL_DEFAULT_TIMEOUT: u64 = 60; // сек

/// OpenAI-совместимые определения инструментов (для body["tools"]).
/// Дерево статично — строится один раз (OnceLock) и клонируется: json!-литерал
/// на каждый вызов (старт сессии, субагент) — лишняя работа компилятора JSON
pub fn tool_schemas() -> Value {
    static CACHE: OnceLock<Value> = OnceLock::new();
    CACHE.get_or_init(build_tool_schemas).clone()
}

fn build_tool_schemas() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "fs_list",
                "description": "List files and directories at the given path. Returns names, types and sizes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "fs_read",
                "description": "Read a text file. Files larger than 256 KB are truncated.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "fs_grep",
                "description": "Search file CONTENTS under a directory (case-insensitive substring, like a lightweight grep). Returns matches as file:line: text. Use it to locate code, config values and docs in the project before reading whole files. Binary files, dependencies (.git, node_modules, target, dist) and files over 512 KB are skipped.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory to search in (recursive)" },
                        "query": { "type": "string", "description": "Text to find (case-insensitive)" },
                        "max_results": { "type": "integer", "description": "Max matches, 1-50, default 20" }
                    },
                    "required": ["path", "query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "fs_write",
                "description": "Write text to a file (creates or overwrites). Directories are created automatically.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path" },
                        "content": { "type": "string", "description": "Full file content" }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "fs_delete",
                "description": "Delete a file (directories are refused).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "shell_run",
                "description": "Run a shell command (PowerShell on Windows) and return stdout, stderr and exit code. Default timeout 60 seconds.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Command to execute" },
                        "cwd": { "type": "string", "description": "Working directory (optional)" },
                        "timeout_sec": { "type": "integer", "description": "Timeout in seconds, default 60, max 300" }
                    },
                    "required": ["command"]
                }
            }
        }
    ])
}

/// Исполнение инструмента по имени с JSON-аргументами.
/// Возвращает строку-результат (текст для модели).
/// Обёртка для тестов: без abort-флага
#[cfg(test)]
pub fn execute_tool(name: &str, arguments: &str) -> Result<String, String> {
    execute_tool_with_abort(name, arguments, None)
}

/// Как execute_tool, но с abort-флагом прогона: Stop убивает длинный
/// shell_run немедленно, вместо ожидания его собственного таймаута
pub fn execute_tool_with_abort(
    name: &str,
    arguments: &str,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    let args: Value = serde_json::from_str(arguments)
        .map_err(|e| format!("invalid arguments JSON: {e}"))?;

    match name {
        "fs_list" => {
            let path = arg_str(&args, "path")?;
            fs_list(Path::new(&path))
        }
        "fs_read" => {
            let path = arg_str(&args, "path")?;
            fs_read(Path::new(&path))
        }
        "fs_grep" => {
            let path = arg_str(&args, "path")?;
            let query = arg_str(&args, "query")?;
            let max = args.get("max_results").and_then(|v| v.as_u64()).unwrap_or(20).clamp(1, 50) as usize;
            fs_grep(Path::new(&path), &query, max)
        }
        "fs_write" => {
            let path = arg_str(&args, "path")?;
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("missing required argument: content")?;
            fs_write(Path::new(&path), content)
        }
        "fs_delete" => {
            let path = arg_str(&args, "path")?;
            fs_delete(Path::new(&path))
        }
        "shell_run" => {
            let command = arg_str(&args, "command")?;
            let cwd = args.get("cwd").and_then(|v| v.as_str()).map(String::from);
            let timeout = args
                .get("timeout_sec")
                .and_then(|v| v.as_u64())
                .unwrap_or(SHELL_DEFAULT_TIMEOUT)
                .clamp(1, 300);
            shell_run(&command, cwd.as_deref(), timeout, abort)
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or(format!("missing required argument: {key}"))
}

// ---------- Vault (заметки): граф знаний как источник контекста ----------

const VAULT_READ_LIMIT: usize = 64 * 1024;
const VAULT_RESULTS_LIMIT: usize = 12;
const VAULT_LIST_LIMIT: usize = 50;

/// Схемы vault-инструментов (добавляются к fs/shell)
pub fn vault_tool_schemas() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "vault_search",
                "description": "Search the user's knowledge vault (markdown notes with [[wiki links]]). Empty query lists all note titles. Use it to recall user's notes, ideas and task chains.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Substring to match against note titles and content" }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "vault_read",
                "description": "Read a note by file name (from vault_search). Returns content plus outgoing [[links]] and backlinks — follow them to walk the knowledge graph.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file": { "type": "string", "description": "Note file name, e.g. \"architecture.md\"" }
                    },
                    "required": ["file"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "vault_write",
                "description": "Create or overwrite a note in the user's vault (markdown with optional [[wiki links]]). Use for reports and summaries the user asked to keep in the vault.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file": { "type": "string", "description": "Note file name ending with .md, e.g. \"automations-report.md\"" },
                        "content": { "type": "string", "description": "Full note content" }
                    },
                    "required": ["file", "content"]
                }
            }
        }
    ])
}

/// Исполнение vault-инструмента; notes_dir передаётся вызывающей стороной
pub fn execute_vault_tool(
    notes_dir: &Path,
    name: &str,
    arguments: &str,
) -> Result<String, String> {
    let args: Value = serde_json::from_str(arguments)
        .map_err(|e| format!("invalid arguments JSON: {e}"))?;
    match name {
        "vault_search" => {
            let q = arg_str(&args, "query")?.to_lowercase();
            vault_search(notes_dir, &q)
        }
        "vault_read" => {
            let file = arg_str(&args, "file")?;
            vault_read(notes_dir, &file)
        }
        "vault_write" => {
            let file = arg_str(&args, "file")?;
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("missing required argument: content")?;
            vault_write(notes_dir, &file, content)
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

/// Файл заметки: только простое имя *.md (без путей и "..").
/// Единая проверка для vault-инструментов и lib.rs::notes_* (sanitize_note_file).
/// Плюс резервные имена устройств Win32 и символы, недопустимые в именах
/// Windows: `fs::rename` в `CON.md` падал с невнятной ошибкой, а заметки
/// с `:`/`?` не переносились vault-экспортом на NTFS
pub(crate) fn sanitize_note_name(file: &str) -> Result<String, String> {
    const RESERVED_WIN32: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
        "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    // stem — только через strip_suffix: прежний срез &file[..len-3]
    // вычислялся ДО проверки ends_with(".md") и паниковал на байте внутри
    // многобайтного символа (имя «файл» без суффикса — гарантированный
    // путь паники от данных модели)
    let stem = file.strip_suffix(".md").unwrap_or("");
    let bad = file.is_empty()
        || file.contains('/')
        || file.contains('\\')
        || file.contains("..")
        || !file.ends_with(".md")
        || file.chars().any(|c| {
            matches!(
                c,
                '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0' | '\u{1}'..='\u{1f}'
            )
        })
        || stem.is_empty()
        || stem.ends_with(['.', ' '])
        || RESERVED_WIN32.contains(&stem.to_ascii_lowercase().as_str());
    if bad {
        return Err(format!("invalid note file name: {file}"));
    }
    Ok(file.to_string())
}

/// Заголовок заметки: первая строка "# X", иначе имя файла без .md
/// (единая реализация в notes.rs — раньше дублировалась дословно)
fn vault_title(file: &str, content: &str) -> String {
    crate::notes::note_title_from_content(file, content)
}

/// Цели [[ссылок]] из текста: [[target]], [[target|alias]], [[target#anch]]
fn vault_outgoing_links(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let Some(end) = rest[start + 2..].find("]]") else { break };
        let raw = &rest[start + 2..start + 2 + end];
        let target = raw.split(['|', '#']).next().unwrap_or("").trim();
        if !target.is_empty() && !out.iter().any(|o| o == target) {
            out.push(target.to_string());
        }
        rest = &rest[start + 2 + end + 2..];
    }
    out
}

fn vault_search(notes_dir: &Path, query: &str) -> Result<String, String> {
    const SEARCH_READ_CAP: usize = 1024 * 1024;
    let mut rows: Vec<(bool, String, String)> = Vec::new(); // (по заголовку, файл, сниппет)
    let entries = fs::read_dir(notes_dir).map_err(|e| format!("cannot read notes: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") {
            continue;
        }
        // Кап на чтение — как у vault_read/notes_list: поиск не должен
        // тащить произвольно большие заметки целиком на каждый вызов
        let Ok(content) =
            crate::fsutil::read_capped_string(&entry.path(), SEARCH_READ_CAP)
        else {
            continue;
        };
        let title = vault_title(&name, &content);
        if query.is_empty() {
            rows.push((true, name, title));
            continue;
        }
        if title.to_lowercase().contains(query) {
            // Сниппет всё равно полезен: первая строка с вхождением
            let snippet = content
                .lines()
                .find(|l| l.to_lowercase().contains(query))
                .unwrap_or(&title)
                .trim();
            rows.push((true, name, snippet.chars().take(160).collect()));
        } else if content.to_lowercase().contains(query) {
            let snippet = content
                .lines()
                .find(|l| l.to_lowercase().contains(query))
                .unwrap_or("")
                .trim();
            rows.push((false, name, snippet.chars().take(160).collect()));
        }
    }
    // Совпадения по заголовку — выше
    rows.sort_by_key(|r| std::cmp::Reverse(r.0));
    if rows.is_empty() {
        return Ok(if query.is_empty() {
            "The vault is empty.".to_string()
        } else {
            format!("No notes matched \"{query}\".")
        });
    }
    let limit = if query.is_empty() {
        VAULT_LIST_LIMIT
    } else {
        VAULT_RESULTS_LIMIT
    };
    let mut out = String::new();
    for (i, (_, name, text)) in rows.iter().take(limit).enumerate() {
        out.push_str(&format!("{}. {} — {}\n", i + 1, name, text));
    }
    if rows.len() > limit {
        out.push_str(&format!("… and {} more\n", rows.len() - limit));
    }
    Ok(out)
}

/// Создать/перезаписать заметку (мутирующий — на фронте в списке правок)
fn vault_write(notes_dir: &Path, file: &str, content: &str) -> Result<String, String> {
    sanitize_note_name(file)?;
    let path = notes_dir.join(file);
    // atomic_write: как и notes_write — 0600 на Unix, без рваных файлов
    crate::fsutil::atomic_write(&path, content.as_bytes())
        .map_err(|e| format!("cannot write note: {e}"))?;
    Ok(json!({
        "ok": true,
        "file": file,
        "bytes": content.len(),
    })
    .to_string())
}

fn vault_read(notes_dir: &Path, file: &str) -> Result<String, String> {
    sanitize_note_name(file)?;
    let path = notes_dir.join(file);
    let bytes = fs::read(&path).map_err(|e| format!("cannot read note: {e}"))?;
    let mut content = String::from_utf8_lossy(&bytes).to_string();
    let truncated = content.len() > VAULT_READ_LIMIT;
    if truncated {
        crate::truncate_at_char_boundary(&mut content, VAULT_READ_LIMIT);
    }
    let title = vault_title(file, &content);
    let links = vault_outgoing_links(&content);

    // Обратные ссылки: какие заметки ссылаются на эту. Иглы строим ОДИН раз
    // (раньше format! аллоцировался на каждую заметку × каждую ссылку),
    // а чужие заметки читаем с потолком: случайный крупный .md в notes/
    // не должен целиком уходить в память при каждом vault_read
    let stem = file.strip_suffix(".md").unwrap_or(file);
    let mut needles: Vec<String> = links.iter().map(|l| format!("[[{l}")).collect();
    needles.push(format!("[[{title}"));
    needles.push(format!("[[{stem}"));
    const BACKLINK_READ_CAP: usize = 512 * 1024;
    let mut backlinks: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(notes_dir) {
        for entry in entries.flatten() {
            let other = entry.file_name().to_string_lossy().to_string();
            if other == file || !other.ends_with(".md") {
                continue;
            }
            let Ok(b) = crate::fsutil::read_capped_string(&entry.path(), BACKLINK_READ_CAP)
            else {
                continue;
            };
            if needles.iter().any(|n| b.contains(n.as_str())) {
                backlinks.push(other);
            }
        }
    }

    let mut out = String::new();
    if truncated {
        out.push_str("[note truncated]\n");
    }
    out.push_str(&content);
    if !links.is_empty() {
        out.push_str(&format!("\n\nOutgoing links: {}", links.join(", ")));
    }
    if !backlinks.is_empty() {
        out.push_str(&format!("\nBacklinks: {}", backlinks.join(", ")));
    }
    Ok(out)
}

fn fs_list(path: &Path) -> Result<String, String> {
    // Потолки как у серверного list_dir (files.rs): без них список на
    // node_modules/System32 уносил сотни КБ прямо в контекст модели
    use crate::files::{LIST_DIR_HARD_CAP, LIST_DIR_LIMIT};
    let entries = fs::read_dir(path).map_err(|e| format!("cannot list {path:?}: {e}"))?;
    let mut items: Vec<String> = Vec::new();
    let mut truncated = false;
    for entry in entries.flatten() {
        if items.len() >= LIST_DIR_HARD_CAP {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = if entry.path().is_dir() { "dir" } else { "file" };
        let size = entry
            .metadata()
            .map(|m| m.len())
            .unwrap_or(0);
        items.push(format!("{kind}\t{size}\t{name}"));
    }
    items.sort();
    if items.len() > LIST_DIR_LIMIT {
        items.truncate(LIST_DIR_LIMIT);
        truncated = true;
    }
    if items.is_empty() {
        return Ok("(empty directory)".to_string());
    }
    if truncated {
        items.push(format!(
            "… ({LIST_DIR_LIMIT} of more entries shown — be more specific with a subdirectory)"
        ));
    }
    Ok(format!("type\tsize\tname\n{}", items.join("\n")))
}

fn fs_read(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot stat {path:?}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path:?} is a directory, use fs_list"));
    }
    // Читаем только первые FS_READ_LIMIT байт: многогигабайтный лог не должен
    // целиком попадать в память до усечения
    let file = fs::File::open(path).map_err(|e| format!("cannot read {path:?}: {e}"))?;
    let mut limited = file.take(FS_READ_LIMIT);
    let mut data = Vec::new();
    limited
        .read_to_end(&mut data)
        .map_err(|e| format!("cannot read {path:?}: {e}"))?;
    if meta.len() > FS_READ_LIMIT {
        let text = String::from_utf8_lossy(&data);
        return Ok(format!(
            "[TRUNCATED: file is {} bytes, showing first {FS_READ_LIMIT} bytes]\n{text}",
            meta.len()
        ));
    }
    Ok(String::from_utf8_lossy(&data).to_string())
}

/// Предел на «до/после» в JSON-результате: дифф в UI не нужен больше 512 КБ на сторону.
const FS_WRITE_DIFF_LIMIT: u64 = 512 * 1024;

fn fs_write(path: &Path, content: &str) -> Result<String, String> {
    // FIX [perf]: раньше fs::read тянул в память ВЕСЬ файл (хоть гигабайт),
    // чтобы тут же выбросить его при превышении лимита. Размер берём из
    // metadata, содержимое читаем только когда оно влезает в diff.
    let before: Option<String> = fs::metadata(path).ok().and_then(|meta| {
        if !meta.is_file() {
            return None;
        }
        if meta.len() > FS_WRITE_DIFF_LIMIT {
            // Слишком большой для диффа — отметим усечение, не читая файл
            return Some(format!("[TRUNCATED: {} bytes]", meta.len()));
        }
        fs::read(path)
            .ok()
            .map(|data| String::from_utf8_lossy(&data).to_string())
    });
    let existed = before.is_some();

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("cannot create directory {dir:?}: {e}"))?;
    }
    fs::write(path, content).map_err(|e| format!("cannot write {path:?}: {e}"))?;

    // «После» уходит в контекст модели — обрезаем тем же лимитом, что и «до»,
    // иначе запись мегабайтного файла вернёт модели весь файл обратно
    let after: String = if content.len() as u64 > FS_WRITE_DIFF_LIMIT {
        // Общий хелпер lib.rs: раньше ручной цикл по байту 0xC0 дублировал его
        let mut clipped = content.to_string();
        crate::truncate_at_char_boundary(&mut clipped, FS_WRITE_DIFF_LIMIT as usize);
        format!("{}\n[TRUNCATED: {} bytes total]", clipped, content.len())
    } else {
        content.to_string()
    };

    Ok(json!({
        "ok": true,
        "path": path.display().to_string(),
        "bytes": content.len(),
        "created": !existed,
        "before": before,
        "after": after,
    })
    .to_string())
}

fn fs_delete(path: &Path) -> Result<String, String> {
    // Только обычные файлы: каталоги и ссылки не трогаем из чата
    let meta = fs::metadata(path).map_err(|e| format!("cannot stat {path:?}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path:?} is a directory — refusing to delete"));
    }
    fs::remove_file(path).map_err(|e| format!("cannot delete {path:?}: {e}"))?;
    Ok(json!({ "ok": true, "deleted": path.display().to_string() }).to_string())
}

/// Поиск по содержимому файлов (FTS-lite, Волна RAG-lite): рекурсивный обход
/// с потолками — без них агент мог бы замерить весь диск одной командой.
/// Бинарность — по нулевому байту в первой порции; зависимости скипаем по именам
fn fs_grep(dir: &Path, query: &str, max_results: usize) -> Result<String, String> {
    const FILE_CAP: u64 = 512 * 1024;
    const MAX_FILES: usize = 4000;
    const LINE_SNIPPET: usize = 200;
    const SKIP_DIRS: &[&str] = &[
        ".git", "node_modules", "target", "dist", "build", ".venv", "venv",
        "__pycache__", ".idea", ".vscode", "coverage", ".next", "vendor",
    ];
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err("empty search query".to_string());
    }
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    let mut scanned = 0usize;
    let mut truncated = false;
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            if ft.is_dir() {
                let name = e.file_name().to_string_lossy().to_string();
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(p);
                }
                continue;
            }
            if scanned >= MAX_FILES {
                truncated = true;
                break;
            }
            scanned += 1;
            let Ok(md) = e.metadata() else { continue };
            if md.len() == 0 || md.len() > FILE_CAP {
                continue;
            }
            let Ok(bytes) = fs::read(&p) else { continue };
            // Бинарный файл: нулевой байт в первых 8 КБ
            if bytes[..bytes.len().min(8192)].contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            // to_lowercase на строку — аллокация в горячем цикле, но альтернативы
            // (char-fold) сложнее и рискованнее; потолки FILE_CAP держат время
            // конечным. Мёртвый счётчик hits снят: считал и выбрасывался
            for (i, line) in text.lines().enumerate() {
                if out.len() >= max_results {
                    break;
                }
                // Exact-case префильтр: попадания в том же регистре (частый
                // случай в коде) обходят аллокацию to_lowercase на строку.
                // Семантика та же: to_lowercase сохраняет exact-case совпадение
                if line.contains(&q) || line.to_lowercase().contains(&q) {
                    let mut s = line.trim().to_string();
                    crate::truncate_at_char_boundary(&mut s, LINE_SNIPPET);
                    out.push(format!("{}:{}: {}", p.display(), i + 1, s));
                }
            }
        }
        if out.len() >= max_results || truncated {
            break;
        }
    }
    if out.is_empty() {
        return Ok(if truncated {
            format!("No matches (scan limit {MAX_FILES} files reached).")
        } else {
            "No matches.".to_string()
        });
    }
    let mut res = out.join("\n");
    if truncated {
        res.push_str(&format!("\n...[scan limit {MAX_FILES} files reached]"));
    }
    Ok(res)
}

fn shell_run(
    command: &str,
    cwd: Option<&str>,
    timeout_sec: u64,
    abort: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("powershell");
        // PowerShell 5.1 пишет в пайп в OEM-кодировке (cp866 на русской
        // Windows) — принудительно переводим консоль в UTF-8, иначе
        // русский вывод превращается в кракозябры
        let wrapped = format!(
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {}",
            command
        );
        c.args(["-NoProfile", "-NonInteractive", "-Command", &wrapped]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    if let Some(dir) = cwd {
        let p = PathBuf::from(dir);
        cmd.current_dir(&p);
    }

    // Запуск, параллельное чтение пайпов, таймаут с kill и сбор вывода —
    // единый примитив proc; abort-флаг позволяет Stop убить процесс сразу
    let out = crate::proc::run_command_opts(&mut cmd, Duration::from_secs(timeout_sec), None, abort)?;
    let (stdout, stderr) = (&out.stdout, &out.stderr);

    if out.timed_out {
        return Ok(format!(
            "TIMEOUT after {timeout_sec}s (process killed)\n--- stdout ---\n{}\n--- stderr ---\n{}",
            if stdout.is_empty() { "(empty)" } else { stdout },
            if stderr.is_empty() { "(empty)" } else { stderr },
        ));
    }
    Ok(format!(
        "exit code: {}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status.unwrap_or(-1),
        if stdout.is_empty() { "(empty)" } else { stdout },
        if stderr.is_empty() { "(empty)" } else { stderr },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haloui-test-{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fs_tools_roundtrip() {
        let dir = tmp_dir("fs");
        let file = dir.join("hello.txt");

        let write_args = json!({ "path": file, "content": "line1\nline2" }).to_string();
        let res = execute_tool("fs_write", &write_args).unwrap();
        let parsed: Value = serde_json::from_str(&res).expect("fs_write returns JSON");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["created"], true);
        assert_eq!(parsed["before"], Value::Null);
        assert_eq!(parsed["after"], "line1\nline2");

        // Вторая запись: before должен содержать прежнее содержимое
        let write2 = json!({ "path": file, "content": "line1\nCHANGED" }).to_string();
        let res = execute_tool("fs_write", &write2).unwrap();
        let parsed: Value = serde_json::from_str(&res).expect("fs_write returns JSON");
        assert_eq!(parsed["created"], false);
        assert_eq!(parsed["before"], "line1\nline2");
        assert_eq!(parsed["after"], "line1\nCHANGED");

        let read_args = json!({ "path": file }).to_string();
        let res = execute_tool("fs_read", &read_args).unwrap();
        assert!(res.contains("CHANGED"));

        let list_args = json!({ "path": dir }).to_string();
        let res = execute_tool("fs_list", &list_args).unwrap();
        assert!(res.contains("hello.txt"));
    }

    #[test]
    fn fs_read_truncates_large_files() {
        let dir = tmp_dir("big");
        let file = dir.join("big.txt");
        fs::write(&file, "x".repeat(300 * 1024)).unwrap();
        let read_args = json!({ "path": file }).to_string();
        let res = execute_tool("fs_read", &read_args).unwrap();
        assert!(res.starts_with("[TRUNCATED"));
    }

    #[test]
    fn fs_read_rejects_directory() {
        let dir = tmp_dir("dircheck");
        let read_args = json!({ "path": dir }).to_string();
        let res = execute_tool("fs_read", &read_args);
        assert!(res.is_err());
    }

    #[test]
    fn vault_search_and_read_roundtrip() {
        let dir = tmp_dir("vault");
        fs::write(
            dir.join("arch.md"),
            "# Архитектура\nСм. [[Задачи]] и [[design|дизайн]].\nГраф строится по ссылкам.\n",
        )
        .unwrap();
        fs::write(dir.join("tasks.md"), "# Задачи\nСписок дел.\n").unwrap();
        fs::write(dir.join("graph.md"), "# Граф\nСсылка на [[Архитектура]].\n").unwrap();
        fs::write(dir.join("random.md"), "Что-то про граф знаний.\n").unwrap();

        // Поиск по заголовку
        let res = execute_vault_tool(&dir, "vault_search", r#"{ "query": "задач" }"#).unwrap();
        assert!(res.contains("tasks.md"));
        // Поиск по содержимому
        let res = execute_vault_tool(&dir, "vault_search", r#"{ "query": "граф" }"#).unwrap();
        assert!(res.contains("arch.md") && res.contains("random.md"));
        // Пустой запрос — список всех
        let res = execute_vault_tool(&dir, "vault_search", r#"{ "query": "" }"#).unwrap();
        assert!(res.contains("random.md"));

        // Чтение: контент + исходящие ссылки + обратные
        let res = execute_vault_tool(&dir, "vault_read", r#"{ "file": "arch.md" }"#).unwrap();
        assert!(res.contains("Архитектура"));
        assert!(res.contains("Outgoing links: Задачи, design"));
        assert!(res.contains("Backlinks: graph.md"));

        // Путь внутрь имени — отказ
        let res = execute_vault_tool(&dir, "vault_read", r#"{ "file": "../x.md" }"#);
        assert!(res.is_err());
    }

    #[test]
    fn fs_grep_finds_content_and_skips_binaries() {
        let dir = tmp_dir("fs-grep");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("a.md"), "# Header
unique_needle here
").unwrap();
        fs::write(dir.join("sub/b.rs"), "fn main() { // another unique_needle
}").unwrap();
        fs::write(dir.join("node_modules/c.js"), "unique_needle in deps").unwrap();
        fs::write(dir.join("bin.dat"), [0u8, 1, 2]).unwrap();
        // Обратные слэши Windows-пути должны быть экранированы в JSON-строке
        let path_json = dir.display().to_string().replace('\\', "\\\\");
        let res = execute_tool("fs_grep", &format!(r#"{{"path":"{}","query":"unique_needle"}}"#, path_json)).unwrap();
        assert!(res.contains("a.md:2"));
        assert!(res.contains("b.rs:1"));
        // зависимости и бинарники не сканируются
        assert!(!res.contains("deps"));
        // регистронезависимость
        let res2 = execute_tool("fs_grep", &format!(r#"{{"path":"{}","query":"UNIQUE_NEEDLE"}}"#, path_json)).unwrap();
        assert!(res2.contains("a.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shell_run_echo() {
        let res = execute_tool("shell_run", r#"{"command":"echo haloui-test"}"#).unwrap();
        assert!(res.contains("haloui-test"), "got: {res}");
        assert!(res.contains("exit code: 0"));
    }

    #[test]
    fn shell_run_timeout_kills_process() {
        let res = execute_tool("shell_run", r#"{"command":"Start-Sleep -Seconds 30","timeout_sec":1}"#);
        assert!(res.is_ok());
        assert!(res.unwrap().contains("TIMEOUT"));
    }

    #[test]
    fn shell_run_large_output_no_false_timeout() {
        // Регресс: команда выдаёт больше буфера пайпа (~64 КБ). Раньше stdout/
        // stderr не читались до завершения — процесс блокировался на записи и
        // try_wait не видел завершения, давая ложный TIMEOUT.
        let command = if cfg!(windows) {
            "'x' * 200000"
        } else {
            "head -c 200000 /dev/zero | tr '\\0' 'x'"
        };
        let args = json!({ "command": command, "timeout_sec": 15 }).to_string();
        let res = execute_tool("shell_run", &args).unwrap();
        assert!(res.contains("exit code: 0"), "got: {res}");
        assert!(!res.contains("TIMEOUT"), "got: {res}");
    }

    #[test]
    fn unknown_tool_rejected() {
        let res = execute_tool("rm_rf_everything", "{}");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("unknown tool"));
    }

    #[test]
    fn invalid_arguments_rejected() {
        let res = execute_tool("fs_read", "not json");
        assert!(res.is_err());
        let res = execute_tool("fs_read", "{}");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("missing required argument"));
    }

    #[test]
    fn tool_schemas_valid() {
        let v = tool_schemas();
        let arr = v.as_array().expect("schemas must be an array");
        // fs_list, fs_read, fs_grep, fs_write, fs_delete, shell_run
        assert_eq!(arr.len(), 6);
        for schema in arr {
            assert_eq!(schema["type"], "function");
            assert!(schema["function"]["name"].is_string());
            assert!(schema["function"]["parameters"].is_object());
        }
    }
}
