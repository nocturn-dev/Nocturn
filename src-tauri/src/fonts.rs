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
    // Аудит fonts 163: битый манифест возвращал пустой список, и следующая
    // запись затирала файл — все шрифты становились сиротами. Err хранится
    // в Result (см. read_manifest_checked), .bak — рядом
    match read_manifest_checked(app) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("fonts: manifest unreadable: {e}");
            Vec::new()
        }
    }
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

fn font_import_impl(app: tauri::AppHandle, src: String) -> Result<CustomFont, String> {
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
    // Аудит fonts 168: источник может быть симлинком на произвольный файл
    if let Ok(md) = fs::symlink_metadata(&src_path) {
        if md.file_type().is_symlink() {
            return Err("source path is a symlink".into());
        }
    }
    let meta = fs::metadata(&src_path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FONT_BYTES as u64 {
        return Err("font file is larger than 20 MB".into());
    }
    // Аудит fonts 167: файл мог вырасти между metadata и read — take дублирует
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
    // Аудит fonts 165: расширение не проверяет содержимое — произвольный
    // файл раздавался вебвью через asset-протокол. Магические байты
    let ok_sig = bytes.starts_with(&[0x00, 0x01, 0x00, 0x00]) // TTF
        || bytes.starts_with(b"OTTO") // OTF
        || bytes.starts_with(b"wOFF") // WOFF
        || bytes.starts_with(b"wOF2"); // WOFF2
    if !ok_sig {
        return Err("file content is not a recognized font (ttf/otf/woff/woff2)".into());
    }
    let dir = fonts_dir(&app)?;
    // fsutil::rand_hex8 — единственный источник коротких id: дубль здесь
    // жил своей жизнью и расползался независимо от канонического
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
    let mut fonts = read_manifest(&app);
    fonts.push(font.clone());
    // Аудит fonts 166: файл уже на диске — при провале записи манифеста
    // удаляем, чтобы не плодить сирот
    if let Err(e) = write_manifest(&app, &fonts) {
        let _ = fs::remove_file(&font_path);
        return Err(e);
    }
    Ok(font)
}

#[tauri::command(async)]
pub async fn font_list(app: tauri::AppHandle) -> Result<Vec<CustomFont>, String> {
    // exists() на каждый файл манифеста: на сетевом профиле — секунды;
    // blocking-пул (класс crypto_status). Результат обёрнут в Result —
    // контракт для invoke не меняется (Ok-значение сериализуется как раньше)
    tauri::async_runtime::spawn_blocking(move || {
        Ok(read_manifest(&app)
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
        let mut fonts = read_manifest(&app);
        if let Some(pos) = fonts.iter().position(|f| f.id == id) {
            let f = fonts.remove(pos);
            // Аудит fonts 162: путь из подменённого манифеста удалял
            // произвольный файл. Разрешаем только наш шаблон внутри fonts_dir
            let target = std::path::PathBuf::from(&f.path);
            let inside = fonts_dir(&app)
                .ok()
                .and_then(|dir| target.canonicalize().ok().map(|c| (dir, c)))
                .map(|(dir, c)| c.starts_with(&dir))
                .unwrap_or(false);
            let named = target
                .file_name()
                .map(|n| n.to_string_lossy().starts_with("font-"))
                .unwrap_or(false);
            if inside && named {
                let _ = fs::remove_file(&target);
            } else {
                eprintln!("font_delete: refusing suspicious path {}", f.path);
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
}
