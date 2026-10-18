//! Долговременная память агента: факты о пользователе/проектах в
//! app_config_dir/memory.json. Отдельно от vault-заметок: список заметок
//! плоский, авторские заметки затопили бы авто-факты; здесь — структура,
//! потолки и точечное удаление. Приватность: факты локальны, модель
//! инструктирована не сохранять секреты; пользователь видит и удаляет всё.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Формулировка факта — одно предложение; потолок защищает контекст от
/// простыни (truncate по границе символа — кириллица/эмодзи)
const MAX_TEXT_LEN: usize = 512;
/// Хранилище старше — теряет смысл; при переполнении вытесняется старейший
const MAX_FACTS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFact {
    pub id: String,
    pub text: String,
    /// Миллисекунды: показывается в UI как «когда запомнено»
    pub ts: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MemoryStore {
    #[serde(default)]
    pub facts: Vec<MemoryFact>,
}

/// Сериализация load-модифицируй-save: память зовётся и из агентного цикла,
/// и из UI — параллельные вызовы перезаписывали изменения друг друга (314)
static MEMORY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn load(path: &Path) -> Result<MemoryStore, String> {
    if !path.exists() {
        return Ok(MemoryStore::default());
    }
    let data = crate::fsutil::read_capped_string(path, 0)?;
    // битый файл блокировал и add, и list навсегда.
    // Сохраняем как .bak и стартуем с пустого — новые факты живут
    serde_json::from_str(&data).map_err(|e| {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(path, &bak);
        format!("memory file corrupted (saved as {}): {e}", bak.display())
    })
}

fn save(path: &Path, store: &MemoryStore) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(path, json.as_bytes())
}

/// Похоже ли на секрет: известные префиксы ключей (sk-, ghp-, Bearer и др.),
/// маркеры присваивания параметров аутентификации и плотные 24+ символы base64-алфавита
fn looks_like_secret(text: &str) -> bool {
    const LITERAL_PREFIXES: &[&str] = &[
        "sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat",
        "AKIA", "ASIA", "xoxb-", "xoxp-", "xoxe-", "xoxr-", "xoxa-",
        "glpat-", "glsoat-", "sk-ant-", "AIza", "ya29.", "eyJ",
        "hf_", "npm_",
        "BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY", "BEGIN OPENSSH PRIVATE KEY", "BEGIN EC PRIVATE KEY",
        "ssh-rsa", "ssh-ed25519",
    ];
    if LITERAL_PREFIXES.iter().any(|p| text.contains(p)) {
        return true;
    }

    let lower = text.to_lowercase();
    const LOWER_MARKERS: &[&str] = &[
        "bearer ", "basic ",
        "token=", "token:", "token :",
        "api_key=", "api_key:", "api_key :",
        "apikey=", "apikey:", "apikey :",
        "password=", "password:", "password :",
        "passwd=", "passwd:",
        "secret=", "secret:", "secret :",
    ];
    for m in LOWER_MARKERS {
        if let Some(pos) = lower.find(m) {
            let after = lower[pos + m.len()..].trim_start();
            let val_token = after
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(|c| c == '"' || c == '\'' || c == ',' || c == ';');
            if val_token.len() >= 8 {
                return true;
            }
        }
    }

    text.split_whitespace().any(|w| {
        let clean = w.trim_matches(|c| {
            c == '"' || c == '\'' || c == ',' || c == ';' || c == '(' || c == ')' || c == '[' || c == ']'
        });
        if clean.len() >= 24
            && clean.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '=')
        {
            let has_digit = clean.chars().any(|c| c.is_ascii_digit());
            let has_special = clean.chars().any(|c| c == '-' || c == '_' || c == '=');
            has_digit || has_special || clean.len() >= 32
        } else {
            false
        }
    })
}

pub(crate) fn add_fact(path: &Path, raw_text: &str) -> Result<String, String> {
    let _serial = MEMORY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut text = raw_text.trim().to_string();
    if text.is_empty() {
        return Err("empty fact text".to_string());
    }
    // инструкция модели «NEVER save secrets» — не граница.
    // Типичные форматы ключей в факте — отказ: memory_recall вернул бы секрет
    // в контекст любого последующего запроса
    if looks_like_secret(&text) {
        return Err(
            "refused: the fact looks like a secret (API key / token pattern); memory never stores secrets"
                .to_string(),
        );
    }
    let mut truncated = false;
    if text.len() > MAX_TEXT_LEN {
        crate::truncate_at_char_boundary(&mut text, MAX_TEXT_LEN);
        truncated = true;
    }
    let mut store = load(path)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // Дедуп по нижнему регистру (не eq_ignore_ascii_case: кириллица/эмодзи)
    let norm = text.to_lowercase();
    let updated = if let Some(have) = store
        .facts
        .iter_mut()
        .find(|f| f.text.trim().to_lowercase() == norm)
    {
        have.ts = now;
        true
    } else {
        store.facts.push(MemoryFact {
            // 64 бита энтропии: коллизия hex8 удаляла бы НЕ ТОТ факт (317)
            id: format!("m-{}{}", crate::fsutil::rand_hex8(), crate::fsutil::rand_hex8()),
            text,
            ts: now,
        });
        if store.facts.len() > MAX_FACTS {
            // remove(0) вытеснял первый элемент вектора,
            // а не старейший — дедуп обновляет ts, но не позицию
            if let Some(oldest) = store.facts.iter().min_by_key(|f| f.ts).cloned() {
                store.facts.retain(|f| f.id != oldest.id);
            }
        }
        false
    };
    save(path, &store)?;
    Ok(format!(
        "{}{} Total facts: {}.",
        if updated { "Fact updated." } else { "Fact saved." },
        if truncated { " (truncated to limit)." } else { "" },
        store.facts.len()
    ))
}

pub(crate) fn recall_facts(path: &Path, query: &str) -> Result<String, String> {
    let _serial = MEMORY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let store = load(path)?;
    if store.facts.is_empty() {
        return Ok("Memory is empty.".to_string());
    }
    // подстрока целиком не матчит «dark themes» против
    // «prefers dark themes» в другом порядке — требуем все слова запроса
    let mut facts: Vec<&MemoryFact> = store.facts.iter().collect();
    let q = query.trim().to_lowercase();
    if !q.is_empty() {
        let words: Vec<&str> = q.split_whitespace().collect();
        facts.retain(|f| {
            let t = f.text.to_lowercase();
            words.iter().all(|w| t.contains(w))
        });
        if facts.is_empty() {
            return Ok("No matching facts.".to_string());
        }
    }
    // Новейшие первыми — модель видит актуальные формулировки
    facts.sort_by_key(|f| std::cmp::Reverse(f.ts));
    // модель должна знать, что выдача урезана
    let hidden = facts.len().saturating_sub(40);
    let mut out = facts
        .iter()
        .take(40)
        .map(|f| format!("- {}", f.text))
        .collect::<Vec<_>>()
        .join("\n");
    if hidden > 0 {
        out.push_str(&format!("\n(+{hidden} older facts not shown)"));
    }
    Ok(out)
}

pub(crate) fn delete_fact(path: &Path, id: &str) -> Result<(), String> {
    let _serial = MEMORY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut store = load(path)?;
    let before = store.facts.len();
    store.facts.retain(|f| f.id != id);
    // двойной клик «удалить» отдавал ошибку как сбой.
    // Идемпотентно: отсутствие id — успешный no-op
    if store.facts.len() == before {
        return Ok(());
    }
    save(path, &store)
}

pub(crate) fn clear_all(path: &Path) -> Result<(), String> {
    let _serial = MEMORY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    save(path, &MemoryStore::default())
}

// ---------- Инструменты агента ----------

/// Схемы memory-инструментов: отдаются всегда, фронт фильтрует по тумблеру
/// «Память проектов» (removeMemory в toolFilter) — сервер не знает prefs
pub fn memory_tool_schemas() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "memory_save",
                "description": "Save a durable fact about the user or their projects to long-term memory — one concise sentence. Use for stable preferences, constraints and important context, even when the user did not explicitly ask. NEVER save secrets (API keys, passwords, tokens).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "The fact as one short sentence, e.g. \"User prefers dark themes and ru locale\"" }
                    },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "memory_recall",
                "description": "Search long-term memory facts by keyword. Empty query returns the newest facts. Recent facts are already injected into context at session start — use this for older or specific ones.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Keyword to match against stored facts" }
                    },
                    "required": ["query"]
                }
            }
        }
    ])
}

/// Исполнение memory-инструмента; путь до memory.json передаёт вызывающий
pub fn execute_memory_tool(
    memory_file: &Path,
    name: &str,
    arguments: &str,
) -> Result<String, String> {
    let args: serde_json::Value =
        serde_json::from_str(arguments).map_err(|e| format!("invalid arguments JSON: {e}"))?;
    match name {
        "memory_save" => {
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or("missing required argument: text")?;
            add_fact(memory_file, text)
        }
        "memory_recall" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or("missing required argument: query")?;
            recall_facts(memory_file, query)
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

// ---------- Команды для UI (раздел «Память») ----------

#[tauri::command(async)]
pub async fn memory_list(app: tauri::AppHandle) -> Result<Vec<MemoryFact>, String> {
    // memory.json целиком читается и парсится на каждый вызов — blocking-пул
    // (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::settings::config_file(&app, "memory.json")?;
        let mut facts = load(&path)?.facts;
        facts.sort_by_key(|f| std::cmp::Reverse(f.ts));
        Ok(facts)
    })
    .await
    .map_err(|e| format!("memory list task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn memory_add(app: tauri::AppHandle, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::settings::config_file(&app, "memory.json")?;
        add_fact(&path, &text).map(|_| ())
    })
    .await
    .map_err(|e| format!("memory add task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn memory_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::settings::config_file(&app, "memory.json")?;
        delete_fact(&path, &id)
    })
    .await
    .map_err(|e| format!("memory delete task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn memory_clear(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::settings::config_file(&app, "memory.json")?;
        clear_all(&path)
    })
    .await
    .map_err(|e| format!("memory clear task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        // Уникальный файл на тест: тесты идут параллельно, общий путь
        // устраивал гонку (один тест чистил файл под ногами другого)
        let dir = std::env::temp_dir().join(format!(
            "haloui-memory-{}-{}",
            name,
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("memory.json")
    }

    #[test]
    fn add_recall_dedupe_roundtrip() {
        let path = tmp("dedupe");
        let _ = fs::remove_file(&path);
        assert!(recall_facts(&path, "").unwrap().contains("empty"));

        add_fact(&path, "Пользователь prefers dark themes").unwrap();
        add_fact(&path, "Проект Nocturn на Tauri 2").unwrap();
        // Дедуп: тот же факт (регистр/пробелы) — не создаёт второй записи
        let out = add_fact(&path, "  пользователь PREFERS DARK THEMES ")
            .unwrap();
        assert!(out.contains("updated"));
        let all = recall_facts(&path, "").unwrap();
        assert_eq!(all.matches("- ").count(), 2);
        // Поиск по подстроке, регистронезависимо
        assert!(recall_facts(&path, "tauri").unwrap().contains("Nocturn"));
        assert!(recall_facts(&path, "несуществующее").unwrap().contains("No matching"));
        // Пустая формулировка — ошибка
        assert!(add_fact(&path, "   ").is_err());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn text_truncated_and_cap_enforced() {
        let path = tmp("cap");
        let _ = fs::remove_file(&path);
        let long = "ё".repeat(2000);
        add_fact(&path, &long).unwrap();
        let store = load(&path).unwrap();
        assert_eq!(store.facts.len(), 1);
        assert!(store.facts[0].text.chars().count() <= MAX_TEXT_LEN);
        for i in 0..(MAX_FACTS + 5) {
            add_fact(&path, &format!("fact number {i} unique")).unwrap();
        }
        let store = load(&path).unwrap();
        assert_eq!(store.facts.len(), MAX_FACTS);
        // Старейший (fact 0) вытеснен
        assert!(!serde_json::to_string(&store).unwrap().contains("fact number 0 unique"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn delete_and_clear() {
        let path = tmp("delete");
        let _ = fs::remove_file(&path);
        add_fact(&path, "первый").unwrap();
        add_fact(&path, "второй").unwrap();
        let id = load(&path).unwrap().facts[0].id.clone();
        delete_fact(&path, &id).unwrap();
        // 316: удаление несуществующего — успешный no-op, а не ошибка
    assert!(delete_fact(&path, &id).is_ok());
        clear_all(&path).unwrap();
        assert!(recall_facts(&path, "").unwrap().contains("empty"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn looks_like_secret_rejects_api_tokens_and_allows_facts() {
        let path = tmp("secrets");
        let _ = fs::remove_file(&path);

        assert!(add_fact(&path, "user token is sk-proj-1234567890abcdef").is_err());
        assert!(add_fact(&path, "my github ghp_123456789012345678901234567890").is_err());
        assert!(add_fact(&path, "Authorization: Bearer secret_token_value_xyz").is_err());
        assert!(add_fact(&path, "database password: supersecret1234").is_err());
        assert!(add_fact(&path, "api_key=abcdef1234567890").is_err());
        assert!(add_fact(&path, "-----BEGIN RSA PRIVATE KEY-----").is_err());
        assert!(add_fact(&path, "token is aHR0cHM6Ly9leGFtcGxlLmNvbS9hcGk=").is_err());

        assert!(add_fact(&path, "Пользователь предпочитает темную тему и Rust").is_ok());
        assert!(add_fact(&path, "User lives in Prague and prefers metric system").is_ok());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn corrupted_memory_file_creates_backup() {
        let path = tmp("corrupt");
        let _ = fs::remove_file(&path);
        let bak = path.with_extension("json.bak");
        let _ = fs::remove_file(&bak);

        std::fs::write(&path, "{ invalid json corrupt").unwrap();
        let loaded = load(&path);
        assert!(loaded.is_err());
        assert!(bak.exists());

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&bak);
    }
}
