//! Пользовательские шрифты: импорт .ttf/.otf/.woff/.woff2 в appdata/fonts
//! (по образцу sound_import). Манифест — fonts.json, файлы раздаются
//! вебвью через asset-протокол (каталог разрешён на старте в lib.rs).
//! CSS-имя семейства генерируется приложением (NocturnFont-<id>) —
//! в font-family никогда не попадает пользовательский ввод.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomFont {
    pub id: String,
    /// Безопасное CSS-имя семейства (генерируется, не из имени файла)
    pub family: String,
    /// Отображаемое имя (из имени файла, санитизировано)
    pub name: String,
    /// Полный путь — для convertFileSrc на фронте
    pub path: String,
}

const MAX_FONT_BYTES: usize = 20 * 1024 * 1024;
const OK_EXT: &[&str] = &["ttf", "otf", "woff", "woff2"];

fn fonts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn manifest_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts.json"))
}

fn read_manifest(app: &tauri::AppHandle) -> Vec<CustomFont> {
    let Ok(path) = manifest_path(app) else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn write_manifest(app: &tauri::AppHandle, fonts: &[CustomFont]) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(fonts).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&manifest_path(app)?, &data)
}

/// Имя файла -> отображаемое имя: мусор в пробелы, схлопывание, потолок 40
fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut s = collapsed;
    if s.chars().count() > 40 {
        s = s.chars().take(40).collect();
    }
    if s.is_empty() {
        "Custom font".into()
    } else {
        s
    }
}

#[tauri::command(async)]
pub fn font_import(app: tauri::AppHandle, src: String) -> Result<CustomFont, String> {
    crate::settings::rejects_sensitive_path(&src)?;
    let src_path = PathBuf::from(&src);
    if src_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("invalid source path".into());
    }
    let ext = src_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .ok_or("file has no extension")?;
    if !OK_EXT.contains(&ext.as_str()) {
        return Err(format!(
            "unsupported font format: .{ext} (use ttf/otf/woff/woff2)"
        ));
    }
    // Лимит ДО чтения: иначе выбранный многогигабайтный файл тянулся в
    // память целиком (класс бага из sound_import, чиненый там же)
    let meta = fs::metadata(&src_path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FONT_BYTES as u64 {
        return Err("font file is larger than 20 MB".into());
    }
    let bytes = fs::read(&src_path).map_err(|e| e.to_string())?;
    let dir = fonts_dir(&app)?;
    let id: String = {
        let b: [u8; 4] = rand::random();
        b.iter().map(|x| format!("{x:02x}")).collect()
    };
    let family = format!("NocturnFont-{id}");
    let file_name = format!("font-{id}.{ext}");
    fs::write(dir.join(&file_name), &bytes).map_err(|e| e.to_string())?;
    let name = sanitize_name(
        &src_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    let font = CustomFont {
        id,
        family,
        name,
        path: dir.join(file_name).to_string_lossy().to_string(),
    };
    let mut fonts = read_manifest(&app);
    fonts.push(font.clone());
    write_manifest(&app, &fonts)?;
    Ok(font)
}

#[tauri::command(async)]
pub fn font_list(app: tauri::AppHandle) -> Vec<CustomFont> {
    read_manifest(&app)
        .into_iter()
        .filter(|f| PathBuf::from(&f.path).exists())
        .collect()
}

#[tauri::command(async)]
pub fn font_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut fonts = read_manifest(&app);
    if let Some(pos) = fonts.iter().position(|f| f.id == id) {
        let f = fonts.remove(pos);
        let _ = fs::remove_file(&f.path);
        write_manifest(&app, &fonts)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_name_cleanup() {
        assert_eq!(sanitize_name("JetBrains Mono"), "JetBrains Mono");
        // Мусорные символы -> пробелы, схлопывание
        assert_eq!(sanitize_name("  My<>Font:  v2 \"x\" "), "My Font v2 x");
        // Пустое/мусорное -> дефолт
        assert_eq!(sanitize_name("///"), "Custom font");
        // Потолок 40 символов
        let long = sanitize_name(&"а".repeat(60));
        assert_eq!(long.chars().count(), 40);
    }
}
