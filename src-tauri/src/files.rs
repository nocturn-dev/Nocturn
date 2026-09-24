//! Файловый менеджер: дерево каталогов, git-статус, чекпоинты проекта.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
/// Запись для дерева файлов (M4.2)
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

const LIST_DIR_LIMIT: usize = 500; // максимум записей на папку в ответе
const LIST_DIR_HARD_CAP: usize = 100_000; // защита от патологических каталогов

/// Запись git-статуса (M5.1): относительный путь + двухсимвольный код porcelain
#[derive(Debug, Serialize)]
pub struct GitEntry {
    pub path: String,
    pub code: String,
}

/// Git-статус папки проекта для подсветки дерева файлов.
/// Не-repo или отсутствие git — просто ошибка, фронт молча игнорирует.
#[tauri::command(async)]
pub fn git_status(path: String) -> Result<Vec<GitEntry>, String> {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("git failed: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git exited with {}", output.status)
        } else {
            err
        });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut out: Vec<GitEntry> = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let code = line[..2].trim().to_string();
        let mut p = line[3..].trim().to_string();
        // Формат переименования: "R  old -> new" — берём новое имя
        if let Some(idx) = p.find(" -> ") {
            p = p[idx + 4..].to_string();
        }
        // git берёт пути с не-ASCII в кавычки
        if p.starts_with('"') && p.ends_with('"') && p.len() >= 2 {
            p = p[1..p.len() - 1].to_string();
        }
        out.push(GitEntry { path: p, code });
    }
    Ok(out)
}

// ---------- Чекпоинты проекта (снимки файлов для отката агента) ----------

/// Папки, которые в снимок не попадают (тяжёлые и генерируемые)
const CP_SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "out", ".next",
    "__pycache__", ".venv", "venv", ".gradle", ".idea", ".vscode",
];
/// Максимальный размер одного файла в снимке
const CP_MAX_FILE: u64 = 512 * 1024;
/// Общий предел снимка — больше не тащим
const CP_MAX_TOTAL: u64 = 25 * 1024 * 1024;
/// Сколько последних чекпоинтов храним на проект
const CP_KEEP: usize = 20;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct CheckpointFile {
    /// Путь относительно корня проекта, всегда с "\"
    rel: String,
    /// Содержимое файла в base64 (бинарники тоже пишем без разбора)
    data: String,
}

/// Метаданные чекпоинта для списка
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CheckpointMeta {
    pub id: String,
    pub ts: u64,
    pub label: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct CheckpointStore {
    root: String,
    label: String,
    ts: u64,
    files: Vec<CheckpointFile>,
}

/// Каталог снимков проекта: appdata/checkpoints/<sha256(путь)[..16]>
pub(crate) fn checkpoints_dir(app: &tauri::AppHandle, root: &str) -> Result<PathBuf, String> {
    use sha2::Digest;
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let mut hasher = sha2::Sha256::new();
    hasher.update(root.replace('/', "\\").to_lowercase().as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let dir = base.join("checkpoints").join(&hash[..16]);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Рекурсивный обход проекта: файлы в base64, с лимитами по размеру и объёму.
/// Junction/symlink-каталоги не открываются (петля = бесконечная рекурсия),
/// глубина ограничена на случай экзотических ФС, где флаг symlink не ставится.
pub(crate) fn collect_files(dir: &Path, root: &Path, files: &mut Vec<CheckpointFile>, total: &mut u64) {
    collect_files_at(dir, root, files, total, 0);
}

const CP_MAX_DEPTH: usize = 32;

pub(crate) fn collect_files_at(
    dir: &Path,
    root: &Path,
    files: &mut Vec<CheckpointFile>,
    total: &mut u64,
    depth: usize,
) {
    if depth > CP_MAX_DEPTH || *total >= CP_MAX_TOTAL {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // недоступная папка — просто пропускаем
    };
    for entry in entries.flatten() {
        if *total >= CP_MAX_TOTAL {
            return;
        }
        let path = entry.path();
        // file_type() берётся из записи каталога и НЕ следует по symlink/junction
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let name = entry.file_name();
            if CP_SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                continue;
            }
            collect_files_at(&path, root, files, total, depth + 1);
            if *total >= CP_MAX_TOTAL {
                return;
            }
        } else if meta.is_file() && meta.len() <= CP_MAX_FILE {
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().replace('/', "\\"),
                Err(_) => continue,
            };
            if rel.starts_with('.') {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            *total += meta.len();
            files.push(CheckpointFile {
                rel,
                data: B64.encode(bytes),
            });
        }
    }
}

/// Проверка id (таймстамп + суффикс) — защита от обхода пути
pub fn cp_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || c == '-')
}

#[tauri::command(async)]
pub fn checkpoint_save(
    app: tauri::AppHandle,
    path: String,
    label: String,
) -> Result<CheckpointMeta, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let dir = checkpoints_dir(&app, &path)?;
    let mut files = Vec::new();
    let mut total: u64 = 0;
    collect_files(&root, &root, &mut files, &mut total);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let id = format!("{ts}-{nanos:08x}");
    let label: String = label.chars().take(120).collect();
    let count = files.len();
    let store = CheckpointStore {
        root: path.clone(),
        label: label.clone(),
        ts,
        files,
    };
    let json = serde_json::to_vec(&store).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{id}.json")), json).map_err(|e| e.to_string())?;
    // Чистим старые сверх CP_KEEP (по метке времени в начале имени)
    let mut olds: Vec<(u64, PathBuf)> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let ts = name
                .strip_suffix(".json")
                .and_then(|s| s.split('-').next())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            olds.push((ts, e.path()));
        }
    }
    olds.sort();
    while olds.len() > CP_KEEP {
        let (_, p) = olds.remove(0);
        let _ = fs::remove_file(p);
    }
    Ok(CheckpointMeta {
        id,
        ts,
        label,
        files: count,
        bytes: total,
    })
}

#[tauri::command(async)]
pub fn checkpoint_list(app: tauri::AppHandle, path: String) -> Result<Vec<CheckpointMeta>, String> {
    let dir = checkpoints_dir(&app, &path)?;
    let mut out: Vec<CheckpointMeta> = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let Ok(bytes) = fs::read(e.path()) else { continue };
        let Ok(store) = serde_json::from_slice::<CheckpointStore>(&bytes) else { continue };
        out.push(CheckpointMeta {
            id: name.trim_end_matches(".json").to_string(),
            ts: store.ts,
            label: store.label,
            files: store.files.len(),
            bytes: 0,
        });
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.ts));
    Ok(out)
}

#[tauri::command(async)]
pub fn checkpoint_restore(
    app: tauri::AppHandle,
    path: String,
    id: String,
) -> Result<usize, String> {
    if !cp_id_ok(&id) {
        return Err("bad checkpoint id".into());
    }
    let dir = checkpoints_dir(&app, &path)?;
    let file = dir.join(format!("{id}.json"));
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    let store: CheckpointStore = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut restored = 0usize;
    for f in &store.files {
        // Разрешаем только относительные пути без подъёма; диск/UNC в «относительном»
        // пути на Windows полностью заменяет базу у join — тоже отказ
        let rel = f.rel.replace('/', "\\");
        if rel.starts_with('\\')
            || rel.contains(':')
            || rel.split('\\').any(|part| part == ".." || part.is_empty())
        {
            continue;
        }
        let dest = root.join(&rel);
        if let Some(parent) = dest.parent() {
            if fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        let Ok(data) = B64.decode(&f.data) else { continue };
        if fs::write(&dest, data).is_ok() {
            restored += 1;
        }
    }
    Ok(restored)
}

#[tauri::command(async)]
pub fn checkpoint_delete(app: tauri::AppHandle, path: String, id: String) -> Result<(), String> {
    if !cp_id_ok(&id) {
        return Err("bad checkpoint id".into());
    }
    let dir = checkpoints_dir(&app, &path)?;
    fs::remove_file(dir.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    Ok(())
}


/// Содержимое папки для дерева файлов: папки первыми, дальше по алфавиту.
/// Важно: read_dir отдаёт записи в произвольном порядке ФС, поэтому
/// сначала собираем и сортируем ВСЁ, и только потом обрезаем до лимита —
/// иначе отсечение было бы произвольным подмножеством (часть папок терялась).
#[tauri::command(async)]
pub fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut dirs: Vec<FileEntry> = Vec::new();
    let mut files: Vec<FileEntry> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("cannot list {path}: {e}"))?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.path().is_dir();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        (if is_dir { &mut dirs } else { &mut files }).push(FileEntry { name, is_dir, size });
        if dirs.len() + files.len() >= LIST_DIR_HARD_CAP {
            break;
        }
    }
    let by_name = |a: &FileEntry, b: &FileEntry| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.extend(files);
    dirs.truncate(LIST_DIR_LIMIT);
    Ok(dirs)
}

#[cfg(test)]
mod list_dir_tests {
    use super::*;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("haloui-ls-{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dirs_first_and_sorted() {
        let dir = tmp_dir("order");
        // Создаём в «неудобном» порядке — read_dir может отдать как угодно
        for n in ["zebra.txt", "apple.txt", "mango.txt"] {
            fs::write(dir.join(n), "x").unwrap();
        }
        for n in ["zz_dir", "aa_dir", "mm_dir"] {
            fs::create_dir(dir.join(n)).unwrap();
        }
        let res = list_dir(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = res.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["aa_dir", "mm_dir", "zz_dir", "apple.txt", "mango.txt", "zebra.txt"]
        );
        assert!(res.iter().take(3).all(|e| e.is_dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncation_keeps_all_dirs_and_is_deterministic() {
        let dir = tmp_dir("trunc");
        for n in ["aa_dir", "zz_dir", "mm_dir"] {
            fs::create_dir(dir.join(n)).unwrap();
        }
        // 700 файлов — больше лимита 500
        for i in 0..700 {
            fs::write(dir.join(format!("file{:04}.txt", i)), "x").unwrap();
        }
        let first = list_dir(dir.to_string_lossy().to_string()).unwrap();
        let second = list_dir(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(first.len(), LIST_DIR_LIMIT);
        // Результат детерминирован независимо от порядка read_dir
        assert_eq!(
            first.iter().map(|e| &e.name).collect::<Vec<_>>(),
            second.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        // Все папки выжили и стоят впереди
        assert_eq!(&first[0].name, "aa_dir");
        assert_eq!(&first[1].name, "mm_dir");
        assert_eq!(&first[2].name, "zz_dir");
        assert!(first.iter().skip(3).all(|e| !e.is_dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_directory_rejected() {
        let dir = tmp_dir("rej");
        let file = dir.join("f.txt");
        fs::write(&file, "x").unwrap();
        let res = list_dir(file.to_string_lossy().to_string());
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
#[cfg(test)]
mod git_status_tests {
    use super::*;

    #[test]
    fn git_status_parses_added_file() {
        let dir = std::env::temp_dir().join("haloui-git-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // git может отсутствовать в окружении — тогда тест не имеет смысла
        let init = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .output();
        let Ok(out) = init else { return };
        if !out.status.success() {
            return;
        }
        fs::write(dir.join("hello.txt"), "x").unwrap();
        let _ = std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(&dir)
            .output();

        let res = git_status(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].path, "hello.txt");
        assert_eq!(res[0].code, "A");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_status_rejects_non_repo() {
        let dir = std::env::temp_dir().join("haloui-git-norepo");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // если git есть — не-repo должен дать ошибку; если git нет — тоже Err
        assert!(git_status(dir.to_string_lossy().to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
