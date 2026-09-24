//! Атомарная запись конфиг-файлов: temp + rename в пределах одного каталога.
//! Прямой `fs::write` посреди краха/отключения питания оставлял битый JSON,
//! после которого load_* постоянно возвращали «file corrupted».

use std::fs;
use std::io::Write;
use std::path::Path;

/// Записать данные атомарно: temp-файл рядом + rename (rename в пределах
/// одной ФС атомарен). На Unix файл получает права 600 — конфиги содержат
/// API-ключи, дефолтные права (umask) слишком широкие.
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // Суффикс с pid: два параллельных писателя не затирают temp друг друга
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
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
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| {
        // не оставляем temp-мусор при неудачном rename
        let _ = fs::remove_file(&tmp);
        format!("cannot rename into {}: {e}", path.display())
    })?;
    Ok(())
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
}
