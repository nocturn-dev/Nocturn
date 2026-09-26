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

fn load(path: &Path) -> Result<MemoryStore, String> {
    if !path.exists() {
        return Ok(MemoryStore::default());
    }
    let data = crate::fsutil::read_capped_string(path, 0)?;
    serde_json::from_str(&data).map_err(|e| format!("memory file corrupted: {e}"))
}

fn save(path: &Path, store: &MemoryStore) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(path, json.as_bytes())
}

/// Новый факт: дедуп по тексту (обновляем время), потолок длины и количества.
/// Возвращает текст для модели (было ли обновление, сколько фактов всего).
pub(crate) fn add_fact(path: &Path, raw_text: &str) -> Result<String, String> {
    let mut text = raw_text.trim().to_string();
    if text.is_empty() {
        return Err("empty fact text".to_string());
    }
    crate::truncate_at_char_boundary(&mut text, MAX_TEXT_LEN);
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
            id: format!("m-{}", crate::fsutil::uuid_v4_short()),
            text,
            ts: now,
        });
        if store.facts.len() > MAX_FACTS {
            store.facts.remove(0);
        }
        false
    };
    save(path, &store)?;
    Ok(format!(
        "{} Total facts: {}.",
        if updated { "Fact updated." } else { "Fact saved." },
        store.facts.len()
    ))
}

pub(crate) fn recall_facts(path: &Path, query: &str) -> Result<String, String> {
    let store = load(path)?;
    if store.facts.is_empty() {
        return Ok("Memory is empty.".to_string());
    }
    let q = query.trim().to_lowercase();
    let mut facts: Vec<&MemoryFact> = store.facts.iter().collect();
    if !q.is_empty() {
        facts.retain(|f| f.text.to_lowercase().contains(&q));
        if facts.is_empty() {
            return Ok("No matching facts.".to_string());
        }
    }
    // Новейшие первыми — модель видит актуальные формулировки
    facts.sort_by_key(|f| std::cmp::Reverse(f.ts));
    let lines: Vec<String> = facts
        .iter()
        .take(40)
        .map(|f| format!("- {}", f.text))
        .collect();
    Ok(lines.join("\n"))
}

pub(crate) fn delete_fact(path: &Path, id: &str) -> Result<(), String> {
    let mut store = load(path)?;
    let before = store.facts.len();
    store.facts.retain(|f| f.id != id);
    if store.facts.len() == before {
        return Err(format!("unknown fact id: {id}"));
    }
    save(path, &store)
}

pub(crate) fn clear_all(path: &Path) -> Result<(), String> {
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
pub fn memory_list(app: tauri::AppHandle) -> Result<Vec<MemoryFact>, String> {
    let path = crate::settings::config_file(&app, "memory.json")?;
    let mut facts = load(&path)?.facts;
    facts.sort_by_key(|f| std::cmp::Reverse(f.ts));
    Ok(facts)
}

#[tauri::command(async)]
pub fn memory_add(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let path = crate::settings::config_file(&app, "memory.json")?;
    add_fact(&path, &text).map(|_| ())
}

#[tauri::command(async)]
pub fn memory_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = crate::settings::config_file(&app, "memory.json")?;
    delete_fact(&path, &id)
}

#[tauri::command(async)]
pub fn memory_clear(app: tauri::AppHandle) -> Result<(), String> {
    let path = crate::settings::config_file(&app, "memory.json")?;
    clear_all(&path)
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
        assert!(delete_fact(&path, &id).is_err());
        clear_all(&path).unwrap();
        assert!(recall_facts(&path, "").unwrap().contains("empty"));
        let _ = fs::remove_file(&path);
    }
}
