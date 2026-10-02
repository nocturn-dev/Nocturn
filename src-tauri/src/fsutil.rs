//! Атомарная запись конфиг-файлов: temp + rename в пределах одного каталога.
//! Прямой `fs::write` посреди краха/отключения питания оставлял битый JSON,
//! после которого load_* постоянно возвращали «file corrupted».

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Записать данные атомарно: temp-файл рядом + rename (rename в пределах
/// одной ФС атомарен). На Unix файл получает права 600 — конфиги содержат
/// API-ключи, дефолтные права (umask) слишком широкие.
///
/// Temp-имя с pid И случайным суффиксом: только pid — уникален между
/// процессами, а два параллельных писателя ОДНОГО процесса (автосейв +
/// ручное сохранение) открывали один temp и интерлировали содержимое.
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id(),
        rand::random::<u32>()
    ));
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
        f.write_all(data)
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        // Flush перед rename; ошибка sync не критична для целостности
        f.sync_all().ok();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Проглатывать отказ chmod нельзя: rename опубликовал бы файл под
        // umask (вплоть до 0644), а callers ссылаются на 600 как на гарантию
        if let Err(e) = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("cannot chmod 600 {}: {e}", tmp.display()));
        }
    }
    fs::rename(&tmp, path).map_err(|e| {
        // не оставляем temp-мусор при неудачном rename
        let _ = fs::remove_file(&tmp);
        format!("cannot rename into {}: {e}", path.display())
    })?;
    Ok(())
}

/// Записать приватный файл (temp-артефакты с чувствительным содержимым:
/// черновики диктовки и т.п.). На Unix права 600 ставятся С МОМЕНТА
/// СОЗДАНИЯ: fs::write создаёт файл под umask, и на общем /tmp это
/// world-readable окно до отдельного chmod. На Windows — обычная запись
/// (ACL пер-юзерного %TEMP% уже приватный).
pub fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
        f.write_all(data)
            .map_err(|e| format!("cannot write {}: {e}", path.display()))
    }
    #[cfg(not(unix))]
    {
        fs::write(path, data).map_err(|e| format!("cannot write {}: {e}", path.display()))
    }
}

/// Чтение файла с потолком размера: metadata-check + read_to_string.
/// Защита от OOM на чтении пути, контролируемого фронтом (импорт настроек,
/// плагины, заметки): указание на pagefile.sys/образ диска раньше читалось
/// в память целиком. Лимит по умолчанию 32 МБ.
pub fn read_capped_string(path: &Path, limit: usize) -> Result<String, String> {
    const DEFAULT_LIMIT: usize = 32 * 1024 * 1024;
    let limit = if limit == 0 { DEFAULT_LIMIT } else { limit };
    let md = fs::metadata(path).map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    if md.len() > limit as u64 {
        return Err(format!(
            "file too large: {} bytes (limit {} bytes)",
            md.len(),
            limit
        ));
    }
    let mut data = fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    // BOM-толерантность: файлы, пересохранённые редакторами «UTF-8 с BOM»
    // (частый кейс на Windows), раньше отваливались в serde_json как
    // «corrupted» без причины — срезаем префикс один раз
    if data.starts_with('\u{FEFF}') {
        data.replace_range(0..'\u{FEFF}'.len_utf8(), "");
    }
    Ok(data)
}

/// 8 hex-символов из случайных байтов (32 бита энтропии) — короткое имя
/// файла/профиля. Имя не «uuid»: это не UUIDv4 (122 бита), уникальность —
/// в пределах каталога на 2^32. Раньше дублировалась в browser.rs и imagegen.rs
pub(crate) fn rand_hex8() -> String {
    let b: [u8; 4] = rand::random();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Размеры каталогов хранилища — менеджер в «Основном» (секция «Хранилище»).
#[derive(Debug, Serialize)]
pub struct StorageStats {
    pub config: u64,
    pub checkpoints: u64,
    pub images: u64,
    pub sounds: u64,
    pub fonts: u64,
}

/// Итеративный обход каталога стеком, а не рекурсией (глубина вложенности
/// не ограничена стеком потока). file_type() у DirEntry не следует по
/// symlink/junction — петля ссылок не зациклит обход.
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if let Ok(md) = e.metadata() {
                total += md.len();
            }
        }
    }
    total
}

/// Очистить содержимое каталога, сам каталог оставить: fs-scope изображений
/// в setup привязан к пути, и пересоздавать каталог не требуется.
/// Возвращает число удалённых записей.
fn clear_dir_contents(dir: &Path) -> Result<usize, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let rd = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    let mut removed = 0usize;
    for e in rd {
        let e = e.map_err(|err| err.to_string())?;
        let p = e.path();
        let res = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            fs::remove_dir_all(&p)
        } else {
            fs::remove_file(&p)
        };
        res.map_err(|err| format!("cannot remove {}: {err}", p.display()))?;
        removed += 1;
    }
    Ok(removed)
}

#[tauri::command(async)]
pub async fn storage_stats(app: tauri::AppHandle) -> Result<StorageStats, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
        Ok(StorageStats {
            config: dir_size(&config),
            checkpoints: dir_size(&data.join("checkpoints")),
            images: dir_size(&data.join("images")),
            sounds: dir_size(&data.join("sounds")),
            fonts: dir_size(&data.join("fonts")),
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command(async)]
pub async fn storage_cleanup(app: tauri::AppHandle, kind: String) -> Result<usize, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let dir = match kind.as_str() {
            "checkpoints" => data.join("checkpoints"),
            "images" => data.join("images"),
            _ => return Err(format!("unknown storage kind: {kind}")),
        };
        clear_dir_contents(&dir)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_roundtrip_and_overwrite() {
        let dir = std::env::temp_dir().join(format!("haloui-atomic-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("cfg.json");
        let write = |v: serde_json::Value| {
            atomic_write(&path, serde_json::to_string_pretty(&v).unwrap().as_bytes()).unwrap();
        };
        write(serde_json::json!({ "a": 1 }));
        write(serde_json::json!({ "a": 2 }));
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["a"], 2);
        // temp-файлы не остаются
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_size_sums_nested_files() {
        let dir = std::env::temp_dir().join(format!("haloui-dirsize-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub/deeper")).unwrap();
        fs::write(dir.join("a.bin"), [0u8; 100]).unwrap();
        fs::write(dir.join("sub/b.bin"), [0u8; 25]).unwrap();
        fs::write(dir.join("sub/deeper/c.txt"), "hello").unwrap();
        assert_eq!(dir_size(&dir), 130);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_dir_contents_keeps_root() {
        let dir = std::env::temp_dir().join(format!("haloui-cleardir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("nested/f.bin"), [0u8; 8]).unwrap();
        fs::write(dir.join("top.json"), b"{}").unwrap();
        let removed = clear_dir_contents(&dir).unwrap();
        assert_eq!(removed, 2);
        // Корень жив, содержимое пусто
        assert!(dir.is_dir());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        // Повторная очистка пустого каталога — не ошибка
        assert_eq!(clear_dir_contents(&dir).unwrap(), 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
