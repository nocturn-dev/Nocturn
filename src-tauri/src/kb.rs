//! Базы знаний (RAG): локальный индекс документов в SQLite FTS5.
//! Принцип Nocturn — ноль сети: чанкинг, индекс и поиск целиком на этой
//! машине (appdata/knowledge/<id>/), в контекст модели уезжает только
//! выжимка найденных фрагментов, а не сами файлы. Эмбеддинги не нужны:
//! FTS5 bm25 с префиксной эвристикой покрывает морфологию «на сдачу».

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// Целевой размер чанка в символах: ~800-1100 — рабочий диапазон для
/// инъекции в контекст без потери локального контекста фрагмента
const CHUNK_SIZE: usize = 1100;
/// Перекрытие чанков: фраза на границе не рвётся пополам
const CHUNK_OVERLAP: usize = 150;
/// Потолок чтения документа (битый/гигантский файл не должен съедать память)
const MAX_DOC_BYTES: u64 = 32 * 1024 * 1024;
/// Потолок одного фрагмента в выдаче kb_query
const SNIPPET_LEN: usize = 900;
/// Терминов в FTS-запросе: больше — шум вместо поиска
const MAX_QUERY_TERMS: usize = 8;

#[derive(Debug, Serialize)]
pub struct KbMeta {
    pub id: String,
    pub name: String,
    pub created: u64,
    pub docs: u64,
    pub chunks: u64,
}

// rename_all обязателен: фронт (api.ts KbHit) читает docTitle, а без
// атрибута serde отдал бы doc_title — RAG-контекст уходил модели с
// «[1] undefined» вместо названия документа
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbHit {
    pub doc_title: String,
    pub text: String,
    /// Релевантность (bm25, больше — лучше)
    pub score: f64,
}

#[derive(Debug, Serialize, Deserialize)]
struct KbCar {
    id: String,
    name: String,
    created: u64,
}

/// Каталог базы с валидацией id: id генерируется бекендом (rand_hex8),
/// но приходит с фронта — путь не должен собираться из произвольных строк
fn kb_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 32 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid knowledge base id".into());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("knowledge")
        .join(id))
}

fn open_db(dir: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(dir.join("index.db")).map_err(|e| e.to_string())?;
    // Волна KB-H1: busy_timeout — чтение (kb_query перед каждой отправкой)
    // больше не падает мгновенным SQLITE_BUSY, пока идёт запись документа
    // (BEGIN IMMEDIATE держит блокировку секунды на мегабайтах)
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    // WAL: читатели не блокируют писателя и наоборот. На сетевом AppData
    // может не переключиться — тихо остаёмся на журнале по умолчанию
    // (busy_timeout всё равно стоит)
    let _ = conn.query_row("PRAGMA journal_mode = WAL", [], |r| {
        let _: String = r.get(0)?;
        Ok(())
    });
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS docs(
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            added INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunks(
            id INTEGER PRIMARY KEY,
            doc_id INTEGER NOT NULL,
            ord INTEGER NOT NULL,
            text TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, title, doc_id UNINDEXED);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Чанкинг: абзацная сборка до CHUNK_SIZE с перекрытием хвоста; гигантский
/// абзац режется по строкам. Границы символов соблюдаются (кириллица)
fn chunk_text(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n");
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();

    let flush = |out: &mut Vec<String>, cur: &mut String| {
        let trimmed = cur.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
        cur.clear();
    };

    for para in normalized.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        let para_len = para.chars().count();
        if para_len > CHUNK_SIZE {
            flush(&mut out, &mut cur);
            // Жёсткий сплит по строкам; строка длиннее потолка сама по себе
            // (логи/CSV без переносов) режется и по символам
            let mut piece = String::new();
            for line in para.split('\n') {
                if piece.chars().count() + line.chars().count() > CHUNK_SIZE {
                    let p = piece.trim();
                    if !p.is_empty() {
                        out.push(p.to_string());
                    }
                    piece.clear();
                }
                if line.chars().count() > CHUNK_SIZE {
                    for (i, ch) in line.chars().enumerate() {
                        piece.push(ch);
                        if (i + 1) % CHUNK_SIZE == 0 {
                            let pp = piece.trim();
                            if !pp.is_empty() {
                                out.push(pp.to_string());
                            }
                            piece.clear();
                        }
                    }
                    continue;
                }
                piece.push_str(line);
                piece.push('\n');
            }
            let p = piece.trim();
            if !p.is_empty() {
                out.push(p.to_string());
            }
            continue;
        }
        if cur.chars().count() + para_len > CHUNK_SIZE {
            // Перекрытие: хвост прошлого чанка открывает следующий
            let cur_len = cur.trim().chars().count();
            let skip = cur_len.saturating_sub(CHUNK_OVERLAP);
            let tail: String = cur.trim().chars().skip(skip).collect();
            flush(&mut out, &mut cur);
            cur.push_str(&tail);
            cur.push_str("\n\n");
        }
        cur.push_str(para);
        cur.push_str("\n\n");
    }
    flush(&mut out, &mut cur);
    out
}

/// FTS5-запрос из текста вопроса: термины с префиксной звёздочкой
/// (`слов*` ловит слово/слова/слове — грубая морфология без стеммера),
/// OR — полнота важнее точности, ранжирование делает bm25
fn fts_query(query: &str) -> String {
    let mut terms: Vec<String> = Vec::new();
    for raw in query.split(|c: char| !c.is_alphanumeric()) {
        let tok = raw.trim();
        if tok.is_empty() || terms.len() >= MAX_QUERY_TERMS {
            continue;
        }
        let lower = tok.to_lowercase();
        // Дубли после lowercase не тащим
        if terms.iter().any(|t| t == &lower) {
            continue;
        }
        let chars: Vec<char> = lower.chars().collect();
        let stem: String = if chars.len() > 4 { chars[..chars.len() - 2].iter().collect() } else { lower.clone() };
        // Токен заведомо без кавычек (сплит по не-буквам) — экранировать
        // нечего, но префиксная звёздочка требует кавычек вокруг стема
        terms.push(format!("\"{stem}\"*"));
    }
    terms.join(" OR ")
}

/// Чтение текстового документа с потолком: не-UTF8 не роняет команду
fn read_text_capped(path: &std::path::Path) -> Result<String, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("cannot stat: {e}"))?;
    if md.len() > MAX_DOC_BYTES {
        return Err(format!(
            "file too large: {} bytes (limit {MAX_DOC_BYTES})",
            md.len()
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// Создать базу: каталог + meta.json + пустой индекс
#[tauri::command(async)]
pub async fn kb_create(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > 80 {
        return Err("invalid knowledge base name".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let id = crate::fsutil::rand_hex8();
        let dir = kb_dir(&app, &id)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let car = KbCar {
            id: id.clone(),
            name,
            created: now_ms(),
        };
        let meta = dir.join("meta.json");
        std::fs::write(
            &meta,
            serde_json::to_string_pretty(&car).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        drop(open_db(&dir)?);
        Ok(id)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Список баз со статистикой
#[tauri::command(async)]
pub async fn kb_list(app: tauri::AppHandle) -> Result<Vec<KbMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("knowledge");
        let mut out: Vec<KbMeta> = Vec::new();
        let Ok(rd) = std::fs::read_dir(&root) else {
            return Ok(out);
        };
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let Ok(car_raw) = std::fs::read(e.path().join("meta.json")) else {
                continue;
            };
            let Ok(car) = serde_json::from_slice::<KbCar>(&car_raw) else {
                continue;
            };
            let (docs, chunks) = match open_db(&e.path()) {
                Ok(conn) => (
                    conn.query_row("SELECT COUNT(*) FROM docs", [], |r| r.get::<_, u64>(0))
                        .unwrap_or(0),
                    conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get::<_, u64>(0))
                        .unwrap_or(0),
                ),
                Err(_) => (0, 0),
            };
            out.push(KbMeta {
                id: car.id,
                name: car.name,
                created: car.created,
                docs,
                chunks,
            });
        }
        out.sort_by_key(|m| std::cmp::Reverse(m.created));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Удалить базу целиком (каталог с индексом)
#[tauri::command(async)]
pub async fn kb_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = kb_dir(&app, &id)?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Проиндексировать документ: путь из диалога — sensitive-path гардал, как
/// у settings_import_read. Повторное добавление того же пути = переиндексация
#[tauri::command(async)]
pub async fn kb_add_document(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<u64, String> {
    crate::settings::rejects_sensitive_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Аудит: строковый гардал проходит мимо симлинка/junction —
        // read_text_capped следует по линку, и предзасаженный линк читал
        // защищённую локацию мимо блок-листа. Эталон — settings_import_read:
        // резолвим каноническую форму и ревалидируем её же
        let canon = std::fs::canonicalize(&path)
            .map_err(|e| format!("cannot resolve document path: {e}"))?;
        let canon_str = canon.to_string_lossy().to_string();
        crate::settings::rejects_sensitive_path(&canon_str)?;
        let dir = kb_dir(&app, &id)?;
        let text = read_text_capped(&canon)?;
        let title = std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "document".into());
        let chunks = chunk_text(&text);
        if chunks.is_empty() {
            return Err("document has no extractable text".into());
        }
        let added = now_ms();
        let conn = open_db(&dir)?;
        // Все записи — в одной транзакции: rusqlite в autocommit делал каждый
        // INSERT отдельным fsync, документ на несколько МБ индексировался
        // секундами и изнашивал диск
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let inserted = (|| -> Result<u64, String> {
            // Переиндексация: старые куски того же пути — вон
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM docs WHERE path = ?1",
                    [&path],
                    |r| r.get(0),
                )
                .ok();
            if let Some(doc_id) = existing {
                remove_doc_chunks(&conn, doc_id)?;
                conn.execute("DELETE FROM docs WHERE id = ?1", [doc_id])
                    .map_err(|e| e.to_string())?;
            }
            conn.execute(
                "INSERT INTO docs(title, path, added) VALUES (?1, ?2, ?3)",
                rusqlite::params![title, path, added],
            )
            .map_err(|e| e.to_string())?;
            let doc_id = conn.last_insert_rowid();
            for (ord, chunk) in chunks.iter().enumerate() {
                conn.execute(
                    "INSERT INTO chunks(doc_id, ord, text) VALUES (?1, ?2, ?3)",
                    rusqlite::params![doc_id, ord as i64, chunk],
                )
                .map_err(|e| e.to_string())?;
                let rowid = conn.last_insert_rowid();
                conn.execute(
                    "INSERT INTO fts(rowid, text, title, doc_id) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![rowid, chunk, title, doc_id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(chunks.len() as u64)
        })()
        .inspect_err(|_e| {
            // Частичная индексация не должна остаться в базе
            let _ = conn.execute_batch("ROLLBACK");
        })?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok(inserted)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn remove_doc_chunks(conn: &Connection, doc_id: i64) -> Result<(), String> {
    // Один запрос вместо DELETE по каждому rowid: вызывается и из
    // переиндексации (внутри общей транзакции), и из kb_remove_document
    conn.execute(
        "DELETE FROM fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?1)",
        [doc_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chunks WHERE doc_id = ?1", [doc_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Убрать документ из базы
#[tauri::command(async)]
pub async fn kb_remove_document(
    app: tauri::AppHandle,
    id: String,
    doc_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = kb_dir(&app, &id)?;
        let conn = open_db(&dir)?;
        remove_doc_chunks(&conn, doc_id)?;
        conn.execute("DELETE FROM docs WHERE id = ?1", [doc_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[derive(Debug, Serialize)]
pub struct KbDoc {
    pub id: i64,
    pub title: String,
    pub path: String,
    pub chunks: u64,
}

/// Документы базы (для списка в UI)
#[tauri::command(async)]
pub async fn kb_documents(app: tauri::AppHandle, id: String) -> Result<Vec<KbDoc>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = kb_dir(&app, &id)?;
        let conn = open_db(&dir)?;
        let mut st = conn
            .prepare(
                "SELECT d.id, d.title, d.path,
                        (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id)
                 FROM docs d ORDER BY d.added DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| {
                Ok(KbDoc {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    path: r.get(2)?,
                    chunks: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<KbDoc>, _>>()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Поиск по базе: топ-k фрагментов под запрос (bm25 + префиксная
/// морфология). Вызывается из движка перед каждой отправкой при
/// привязанной к чату базе
#[tauri::command(async)]
pub async fn kb_query(
    app: tauri::AppHandle,
    id: String,
    query: String,
    top_k: Option<u32>,
) -> Result<Vec<KbHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = kb_dir(&app, &id)?;
        let conn = open_db(&dir)?;
        let match_q = fts_query(&query);
        if match_q.is_empty() {
            return Ok(Vec::new());
        }
        let limit = top_k.unwrap_or(6).clamp(1, 12);
        let mut st = conn
            .prepare(
                "SELECT d.title, c.text, bm25(fts)
                 FROM fts
                 JOIN chunks c ON c.id = fts.rowid
                 JOIN docs d ON d.id = c.doc_id
                 WHERE fts MATCH ?1
                 ORDER BY rank
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map(rusqlite::params![match_q, limit], |r| {
                Ok(KbHit {
                    doc_title: r.get(0)?,
                    text: r.get(1)?,
                    score: -r.get::<_, f64>(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out: Vec<KbHit> = rows
            .collect::<Result<Vec<KbHit>, _>>()
            .map_err(|e| e.to_string())?;
        for h in &mut out {
            crate::truncate_at_char_boundary(&mut h.text, SNIPPET_LEN);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_db_sets_busy_timeout_and_wal() {
        // Волна KB-H1: чтение не падает мгновенным BUSY при записи; WAL —
        // читатели не блокируют писателя
        let dir = std::env::temp_dir().join(format!("haloui-kb-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = open_db(&dir).unwrap();
        let timeout: u64 = conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(timeout, 5000);
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunks_respect_size_and_overlap() {
        let paras: Vec<String> = (0..10)
            .map(|i| format!("Абзац {i}. {}", "текст ".repeat(120)))
            .collect();
        let chunks = chunk_text(&paras.join("\n\n"));
        assert!(chunks.len() >= 2, "длинный текст должен нарезаться");
        for c in &chunks {
            assert!(
                c.chars().count() <= CHUNK_SIZE + CHUNK_OVERLAP + 2,
                "чанк превысил потолок: {}",
                c.chars().count()
            );
        }
        // Перекрытие: начало второго чанка — хвост первого
        let first_tail: String = chunks[0].chars().skip(chunks[0].chars().count() - 40).collect();
        assert!(chunks[1].contains(&first_tail[..20.min(first_tail.len())]));
    }

    #[test]
    fn giant_paragraph_hard_splits() {
        let line = "колбаса ".repeat(300); // ~2400 символов одной строкой
        let chunks = chunk_text(&line);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(c.chars().count() <= CHUNK_SIZE + 16);
        }
    }

    #[test]
    fn fts_query_prefixes_and_escapes() {
        let q = fts_query("Привет, мир! Поиск \"цитаты\" длинноеслово");
        assert!(q.contains("\"прив\"*"), "префикс с отсечённым окончанием: {q}");
        assert!(q.contains("\"мир\"*"));
        assert!(q.contains("\"цита\"*"), "кавычки-разделители не ломают токен: {q}");
        assert!(q.contains(" OR "));
        assert_eq!(fts_query("   !!!   "), "", "пустой запрос — пустой MATCH");
    }

    #[test]
    fn end_to_end_add_and_search() {
        let dir = std::env::temp_dir().join(format!("haloui-kb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = open_db(&dir).unwrap();
        let text = "Nocturn хранит ключи в зашифрованном vault на диске.\n\nВторая глава про аргонид и AES.";
        for (ord, chunk) in chunk_text(text).iter().enumerate() {
            conn.execute(
                "INSERT INTO docs(title, path, added) VALUES (?1, ?2, ?3)",
                rusqlite::params!["doc.md", "/tmp/doc.md", ord as i64],
            )
            .unwrap();
            let doc_id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO chunks(doc_id, ord, text) VALUES (?1, ?2, ?3)",
                rusqlite::params![doc_id, ord as i64, chunk],
            )
            .unwrap();
            let rowid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO fts(rowid, text, title, doc_id) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![rowid, chunk, "doc.md", doc_id],
            )
            .unwrap();
        }
        let mut st = conn
            .prepare(
                "SELECT c.text FROM fts JOIN chunks c ON c.id = fts.rowid
                 WHERE fts MATCH ?1 ORDER BY rank",
            )
            .unwrap();
        let hits: Vec<String> = st
            .query_map([fts_query("хранит ключи vault")], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(!hits.is_empty(), "поиск обязан найти документ про vault");
        assert!(hits[0].contains("vault"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Золотой вектор serde-стыка: фронт (api.ts KbHit) читает docTitle —
    /// регрессия rename_all ломала RAG-контекст молча («[1] undefined»)
    #[test]
    fn kbhit_serializes_camel_case_for_frontend() {
        let hit = KbHit {
            doc_title: "Заметки.md".into(),
            text: "фрагмент".into(),
            score: 1.5,
        };
        let v = serde_json::to_value(&hit).unwrap();
        assert_eq!(v.get("docTitle").and_then(|x| x.as_str()), Some("Заметки.md"));
        assert!(v.get("doc_title").is_none(), "snake_case поле утекло на фронт");
        assert_eq!(v.get("score").and_then(|x| x.as_f64()), Some(1.5));
    }
}
