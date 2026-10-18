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


fn read_manifest_checked(app: &tauri::AppHandle) -> Result<Vec<CustomFont>, String> {
    let path = manifest_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match serde_json::from_str(&data) {
        Ok(v) => Ok(v),
        Err(e) => {
            let bak = path.with_extension("json.bak");
            let _ = fs::copy(&path, &bak);
            Err(format!("manifest corrupted (saved as {}): {e}", bak.display()))
        }
    }
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
pub async fn font_import(app: tauri::AppHandle, src: String) -> Result<CustomFont, String> {
    crate::settings::rejects_sensitive_path(&src)?;
    // Чтение до 20 МБ + запись файла и манифеста — в blocking-пул,
    // а не на воркер tokio со стримами (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || font_import_impl(app, src))
        .await
        .map_err(|e| format!("font import task failed: {e}"))?
}

/// Проверяем структуру шрифта и наличие ключевых таблиц (head, cmap, name),
/// чтобы битые файлы отсекались до сохранения и не ломали браузерный движок
fn validate_font_structure(ext: &str, bytes: &[u8]) -> Result<(), String> {
    match ext {
        "ttf" | "otf" => {
            let face = ttf_parser::Face::parse(bytes, 0)
                .map_err(|e| format!("corrupted or invalid font: {e}"))?;
            let has_head = face.raw_face().table(ttf_parser::Tag::from_bytes(b"head")).is_some();
            let has_cmap = face.raw_face().table(ttf_parser::Tag::from_bytes(b"cmap")).is_some();
            let has_name = face.raw_face().table(ttf_parser::Tag::from_bytes(b"name")).is_some();
            if !has_head || !has_cmap || !has_name {
                return Err("font missing required tables (head, cmap, name)".into());
            }
            Ok(())
        }
        "woff" => validate_woff_tables(bytes),
        "woff2" => validate_woff2_tables(bytes),
        _ => Err("unsupported font format".into()),
    }
}

fn validate_woff_tables(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 44 || !bytes.starts_with(b"wOFF") {
        return Err("invalid woff signature or file too short".into());
    }
    let num_tables = u16::from_be_bytes([bytes[12], bytes[13]]) as usize;
    if num_tables == 0 || num_tables > 128 {
        return Err("invalid woff table count".into());
    }
    let total_len = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    if total_len > bytes.len() {
        return Err("woff file truncated".into());
    }
    let dir_end = 44 + num_tables * 20;
    if bytes.len() < dir_end {
        return Err("woff header truncated".into());
    }
    let mut has_head = false;
    let mut has_cmap = false;
    let mut has_name = false;
    for i in 0..num_tables {
        let offset = 44 + i * 20;
        let tag = &bytes[offset..offset + 4];
        if tag == b"head" {
            has_head = true;
        } else if tag == b"cmap" {
            has_cmap = true;
        } else if tag == b"name" {
            has_name = true;
        }
    }
    if !has_head || !has_cmap || !has_name {
        return Err("woff missing required tables (head, cmap, name)".into());
    }
    Ok(())
}

fn validate_woff2_tables(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 48 || !bytes.starts_with(b"wOF2") {
        return Err("invalid woff2 signature or file too short".into());
    }
    let num_tables = u16::from_be_bytes([bytes[12], bytes[13]]) as usize;
    if num_tables == 0 || num_tables > 128 {
        return Err("invalid woff2 table count".into());
    }
    let total_len = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    if total_len > bytes.len() {
        return Err("woff2 file truncated".into());
    }
    let mut has_head = false;
    let mut has_cmap = false;
    let mut has_name = false;
    let mut cursor = 48;
    for _ in 0..num_tables {
        if cursor >= bytes.len() {
            return Err("woff2 directory truncated".into());
        }
        let flags = bytes[cursor];
        cursor += 1;
        let tag_idx = flags & 0x3f;
        if tag_idx == 0 {
            has_cmap = true;
        } else if tag_idx == 1 {
            has_head = true;
        } else if tag_idx == 5 {
            has_name = true;
        } else if tag_idx == 63 {
            if cursor + 4 > bytes.len() {
                return Err("woff2 directory truncated".into());
            }
            let tag = &bytes[cursor..cursor + 4];
            cursor += 4;
            if tag == b"head" {
                has_head = true;
            } else if tag == b"cmap" {
                has_cmap = true;
            } else if tag == b"name" {
                has_name = true;
            }
        }
        while cursor < bytes.len() && (bytes[cursor] & 0x80) != 0 {
            cursor += 1;
        }
        cursor += 1;
        let transform_version = (flags & 0xc0) >> 6;
        if transform_version != 0 && (tag_idx == 2 || tag_idx == 3) {
            while cursor < bytes.len() && (bytes[cursor] & 0x80) != 0 {
                cursor += 1;
            }
            cursor += 1;
        }
    }
    if !has_head || !has_cmap || !has_name {
        return Err("woff2 missing required tables (head, cmap, name)".into());
    }
    Ok(())
}

fn font_import_impl(app: tauri::AppHandle, src: String) -> Result<CustomFont, String> {
    // Проверяем манифест ДО сохранения файла: если он повреждён, не дописываем вслепую
    let mut fonts = read_manifest_checked(&app)?;

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
    if let Ok(md) = fs::symlink_metadata(&src_path) {
        if md.file_type().is_symlink() {
            return Err("source path is a symlink".into());
        }
    }
    let meta = fs::metadata(&src_path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FONT_BYTES as u64 {
        return Err("font file is larger than 20 MB".into());
    }
    let src_file = fs::File::open(&src_path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    {
        use std::io::Read;
        src_file
            .take(MAX_FONT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
    }
    if bytes.len() > MAX_FONT_BYTES {
        return Err("font file is larger than 20 MB".into());
    }

    validate_font_structure(&ext, &bytes)?;

    let dir = fonts_dir(&app)?;
    let id = crate::fsutil::rand_hex8();
    let family = format!("NocturnFont-{id}");
    let file_name = format!("font-{id}.{ext}");
    let font_path = dir.join(&file_name);
    crate::fsutil::atomic_write(&font_path, &bytes).map_err(|e| e.to_string())?;
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
    fonts.push(font.clone());
    if let Err(e) = write_manifest(&app, &fonts) {
        let _ = fs::remove_file(&font_path);
        return Err(e);
    }
    Ok(font)
}

#[tauri::command(async)]
pub async fn font_list(app: tauri::AppHandle) -> Result<Vec<CustomFont>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let fonts = read_manifest_checked(&app)?;
        Ok(fonts
            .into_iter()
            .filter(|f| PathBuf::from(&f.path).exists())
            .collect::<Vec<_>>())
    })
    .await
    .map_err(|e| format!("font list task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn font_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut fonts = read_manifest_checked(&app)?;
        if let Some(pos) = fonts.iter().position(|f| f.id == id) {
            let f = fonts.remove(pos);
            let target = std::path::PathBuf::from(&f.path);
            let inside = fonts_dir(&app)
                .ok()
                .and_then(|dir| {
                    let canon_dir = dunce::canonicalize(&dir).unwrap_or(dir);
                    dunce::canonicalize(&target).ok().map(|c| (canon_dir, c))
                })
                .map(|(dir, c)| c.starts_with(&dir))
                .unwrap_or(false);
            let named = target
                .file_name()
                .map(|n| n.to_string_lossy().starts_with("font-"))
                .unwrap_or(false);
            if inside && named {
                let _ = fs::remove_file(&target);
            } else {
                crate::app_log::log_warn(&format!("font_delete: refusing suspicious path {}", f.path));
            }
            write_manifest(&app, &fonts)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("font delete task failed: {e}"))?
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

    #[test]
    fn validate_corrupted_ttf_rejected() {
        // Сигнатура TTF верна, но таблицы отсутствуют
        let corrupted = vec![0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert!(validate_font_structure("ttf", &corrupted).is_err());
    }

    #[test]
    fn validate_woff_table_checks() {
        // Создаём синтетический минимальный WOFF с 3 таблицами: head, cmap, name
        let mut woff = vec![0u8; 44 + 3 * 20];
        woff[0..4].copy_from_slice(b"wOFF");
        let len = (woff.len() as u32).to_be_bytes();
        woff[8..12].copy_from_slice(&len);
        woff[12..14].copy_from_slice(&3u16.to_be_bytes());
        // Таблица 1: head
        woff[44..48].copy_from_slice(b"head");
        // Таблица 2: cmap
        woff[64..68].copy_from_slice(b"cmap");
        // Таблица 3: name
        woff[84..88].copy_from_slice(b"name");

        assert!(validate_font_structure("woff", &woff).is_ok());

        // Если заменяем name на что-то другое, должно вернуть отказ
        woff[84..88].copy_from_slice(b"post");
        assert!(validate_font_structure("woff", &woff).is_err());
    }

    #[test]
    fn validate_woff2_table_checks() {
        // Создаём синтетический минимальный WOFF2 с тегами cmap (0), head (1), name (5)
        let mut woff2 = vec![0u8; 48 + 6];
        woff2[0..4].copy_from_slice(b"wOF2");
        let len = (woff2.len() as u32).to_be_bytes();
        woff2[8..12].copy_from_slice(&len);
        woff2[12..14].copy_from_slice(&3u16.to_be_bytes());
        // Записи таблицы: флаг (1 байт) + origLength (1 байт)
        woff2[48] = 0; // cmap
        woff2[49] = 10;
        woff2[50] = 1; // head
        woff2[51] = 10;
        woff2[52] = 5; // name
        woff2[53] = 10;

        assert!(validate_font_structure("woff2", &woff2).is_ok());

        // Если убираем head
        woff2[50] = 7; // post
        assert!(validate_font_structure("woff2", &woff2).is_err());
    }
}
