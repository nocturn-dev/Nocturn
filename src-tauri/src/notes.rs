//! Заметки (M-N1): личный vault markdown-файлов в %APPDATA%/notes.
//! Файл = узел будущего графа, [[ссылки]] в тексте = рёбра.

use crate::tools;
use serde::Serialize;
use std::fs;

#[derive(Debug, Serialize)]
pub struct NoteInfo {
    pub file: String,
    /// Заголовок из первой строки "# ...", иначе имя файла
    pub title: String,
    pub updated: u64,
}

pub(crate) fn notes_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))?
        .join("notes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Защита от выхода за пределы папки: только простое имя файла.
/// Тонкая обёртка: единая проверка живёт в tools::sanitize_note_name.
pub(crate) fn sanitize_note_file(file: &str) -> Result<String, String> {
    tools::sanitize_note_name(file)
}

pub(crate) fn note_title_from_content(file: &str, content: &str) -> String {
    for line in content.lines() {
        let t = line.trim();
        if let Some(h) = t.strip_prefix("# ") {
            let title = h.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }
    file.trim_end_matches(".md").to_string()
}

#[tauri::command(async)]
pub async fn notes_list(app: tauri::AppHandle) -> Result<Vec<NoteInfo>, String> {
    // Список читает до 1 МБ НА КАЖДУЮ заметку ради заголовка: vault на сотни
    // файлов — секунды блокировки. blocking-пул (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        let dir = notes_dir(&app)?;
        let mut out: Vec<NoteInfo> = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                continue;
            }
            let updated = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            // Для заголовка читаем максимум 1 МБ: раньше каждый .md читался
            // ЦЕЛИКОМ при каждом открытии списка (vault на сотни больших заметок
            // давал фризы и пики памяти). Фолбэк — имя файла
            let title = crate::fsutil::read_capped_string(&entry.path(), 1024 * 1024)
                .map(|c| note_title_from_content(&name, &c))
                .unwrap_or_else(|_| note_title_from_content(&name, ""));
            out.push(NoteInfo { title, file: name, updated });
        }
        out.sort_by_key(|n| std::cmp::Reverse(n.updated));
        Ok(out)
    })
    .await
    .map_err(|e| format!("notes list task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn notes_read(app: tauri::AppHandle, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = sanitize_note_file(&file)?;
        let path = notes_dir(&app)?.join(file);
        // Потолок размера: агентный vault_read лимитирован, прямая команда
        // раньше возвращала файл любого размера (OOM на многогигабайтном пути)
        crate::fsutil::read_capped_string(&path, 0)
    })
    .await
    .map_err(|e| format!("notes read task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn notes_write(app: tauri::AppHandle, file: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = sanitize_note_file(&file)?;
        let path = notes_dir(&app)?.join(file);
        // atomic_write, а не fs::write: «личный vault» на Unix не должен быть
        // 0644-читаемым всеми, краш не должен рвать файл
        crate::fsutil::atomic_write(&path, content.as_bytes())
    })
    .await
    .map_err(|e| format!("notes write task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn notes_delete(app: tauri::AppHandle, file: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = sanitize_note_file(&file)?;
        let path = notes_dir(&app)?.join(file);
        fs::remove_file(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("notes delete task failed: {e}"))?
}
#[cfg(test)]
mod notes_tests {
    use super::*;

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize_note_file("ok.md").is_ok());
        assert!(sanitize_note_file("../x.md").is_err());
        assert!(sanitize_note_file("a/b.md").is_err());
        assert!(sanitize_note_file("a\\b.md").is_err());
        assert!(sanitize_note_file("x.txt").is_err());
    }

    /// Регресс: имя без «.md» с многобайтными символами раньше паниковало
    /// на срезе байтов до проверки суффикса (byte index not a char boundary)
    #[test]
    fn sanitize_no_panic_on_multibyte_without_suffix() {
        assert!(sanitize_note_file("файл").is_err());
        assert!(sanitize_note_file("файл.md").is_ok());
        assert!(sanitize_note_file("заметка про Rust.md").is_ok());
        assert!(sanitize_note_file("日本語").is_err());
    }

    #[test]
    fn title_from_first_heading() {
        assert_eq!(
            note_title_from_content("n.md", "# Мой промт\n\nтекст"),
            "Мой промт"
        );
        assert_eq!(note_title_from_content("заметка.md", "без заголовка"), "заметка");
    }
}
