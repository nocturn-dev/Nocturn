//! Атомарная запись конфиг-файлов: temp + rename в пределах одного каталога.
//! Прямой `fs::write` посреди краха/отключения питания оставлял битый JSON,
//! после которого load_* постоянно возвращали «file corrupted».

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Открыть файл записи с верификацией адреса (symlink TOCTOU, SECURITY.md).
/// perm-слой канонизует путь и проверяет его ДО вызова инструмента, но между
/// проверкой и `fs::write` локальный процесс того же пользователя мог
/// подменить компонент пути симлинком/junction — запись ушла бы по новой
/// ссылке. Схема «open → verify»: (1) открытие с флагом, ОТКАЗЫВАЮЩИМСЯ
/// следовать симлинку на финальном компоненте (Unix: O_NOFOLLOW → ELOOP;
/// Windows: FILE_FLAG_OPEN_REPARSE_POINT + отказ по атрибуту reparse);
/// (2) у открытого дескриптора читается ФИНАЛЬНЫЙ путь, который видит ОС
/// (Linux: /proc/self/fd; macOS/BSD: fcntl F_GETPATH; Windows:
/// GetFinalPathNameByHandle), и сверяется с ожиданием, канонизованным
/// в момент открытия. Подмена промежуточных компонентов между канонизацией
/// и открытием меняет финальный путь дескриптора → отказ. Подмена ПОСЛЕ
/// открытия дескриптор не двигает — запись привязана к проверенному inode.
/// Вызывающий обязан повторить path-гейты (perm::recheck_location) по
/// возвращённому пути: настоящая защита — проверка НАСТОЯЩЕГО адреса.
///
/// Гард «трек на паузе при старте» не нужен: O_CREAT может оставить пустой
/// файл по адресу, который вызывающий затем отвергнет, — мусор того же
/// пользователя, не утечка (он и так может писать куда угодно сам).
pub fn open_write_verified(path: &Path) -> Result<(fs::File, PathBuf), String> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
    let name = path
        .file_name()
        .ok_or_else(|| format!("path has no file name: {}", path.display()))?;
    let parent = parent.ok_or_else(|| format!("no parent directory: {}", path.display()))?;
    let expected = fs::canonicalize(parent)
        .map_err(|e| format!("cannot resolve parent {}: {e}", parent.display()))?
        .join(name);
    let file = open_no_follow(path)?;
    let final_path = final_path_of(&file)?;
    if !paths_equivalent(&final_path, &expected) {
        return Err(format!(
            "symlink race refused: opened {}, expected {}",
            final_path.display(),
            expected.display()
        ));
    }
    Ok((file, final_path))
}

/// Открытие записи без следования финальному симлинку. read(true) нужен
/// вызывающему: «до» для диффа читается через тот же дескриптор (чтение
/// путём отдельно от записи — та же гонка).
#[cfg(unix)]
fn open_no_follow(path: &Path) -> Result<fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| {
            // ELOOP — финальный компонент оказался симлинком (O_NOFOLLOW)
            format!("cannot open {}: {e}", path.display())
        })
}

#[cfg(windows)]
fn open_no_follow(path: &Path) -> Result<fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    // OPEN_ALWAYS (create+write, без truncate): «до» для диффа читается
    // до усечения; перезапись делает вызывающий через set_len(0)
    let f = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    // OPEN_REPARSE_POINT открыл бы сам симлинк, а не цель: отказ по
    // атрибуту reparse прямо на дескрипторе (гонки-free, в отличие от
    // проверки пути после открытия)
    let mut info = win::ByHandleFileInformation::default();
    let ok = unsafe { win::GetFileInformationByHandle(f.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(format!(
            "cannot stat {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    if info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "refused: {} is a symlink/reparse point",
            path.display()
        ));
    }
    Ok(f)
}

/// Финальный путь, который ОС показывает для открытого дескриптора.
#[cfg(target_os = "linux")]
fn final_path_of(f: &fs::File) -> Result<PathBuf, String> {
    use std::os::unix::io::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd()))
        .map_err(|e| format!("cannot resolve fd path (procfs unavailable?): {e}"))
}

/// macOS/BSD: /proc нет — F_GETPATH отдаёт путь vnode'а (до MAXPATHLEN)
#[cfg(all(unix, not(target_os = "linux")))]
fn final_path_of(f: &fs::File) -> Result<PathBuf, String> {
    use std::os::unix::io::AsRawFd;
    let fd = f.as_raw_fd();
    // MAXPATHLEN в libc — c_int, в длину вектора нужен usize
    let mut buf = vec![0u8; libc::MAXPATHLEN as usize];
    let n = unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) };
    if n < 0 {
        return Err(format!(
            "cannot resolve fd path: {}",
            std::io::Error::last_os_error()
        ));
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(
        String::from_utf8_lossy(&buf[..end]).into_owned(),
    ))
}

#[cfg(windows)]
fn final_path_of(f: &fs::File) -> Result<PathBuf, String> {
    use std::os::windows::io::AsRawHandle;
    // flags = 0 → VOLUME_NAME_DOS + FILE_NAME_NORMALIZED, форма \\?\C:\...
    // — та же, что у fs::canonicalize на Windows
    let query = |buf: &mut [u16]| unsafe {
        win::GetFinalPathNameByHandleW(f.as_raw_handle(), buf.as_mut_ptr(), buf.len() as u32, 0)
    };
    let mut buf = [0u16; 1024];
    let n = query(&mut buf) as usize;
    if n == 0 {
        return Err(format!(
            "cannot resolve final path: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Insufficient buffer: Win32 вернул ТРЕБУЕМЫЙ размер (с нулём) и не писал
    // буфер — срез min() давал строку из нулей, и fs_write fail-closed
    // отказывал легитимную запись на сверхдлинном финальном пути с
    // бессмысленной диагностикой (аудит A1-8). Повтор с буфером точного размера
    if n > buf.len() {
        let mut big = vec![0u16; n];
        let n2 = query(&mut big) as usize;
        if n2 == 0 {
            return Err(format!(
                "cannot resolve final path: {}",
                std::io::Error::last_os_error()
            ));
        }
        // Успех: возврат НЕ включает завершающий нуль
        let len = n2.min(big.len().saturating_sub(1));
        return Ok(PathBuf::from(String::from_utf16_lossy(
            &big[..len],
        )));
    }
    // Успех с первого раза: возврат НЕ включает завершающий нуль
    Ok(PathBuf::from(String::from_utf16_lossy(
        &buf[..n],
    )))
}

/// Путь для репортажа модели/фронту: каноникал на Windows носит вербатим-
/// префикс \\?\ (и \\?\UNC\) — срезаем для человекочитаемого вида; регистр
/// и содержимое не трогаем. Фронтовый normalizePath этот префикс не знает
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s.into_owned()
}

/// Сравнение финального пути с ожиданием: оба каноничны, но регистр и
/// префиксы могли различаться формой (\\?\C:\ vs C:\) — нормализуем обе
fn paths_equivalent(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        win_norm(a) == win_norm(b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

#[cfg(windows)]
fn win_norm(p: &Path) -> String {
    let mut s = p.to_string_lossy().to_lowercase().replace('/', "\\");
    if let Some(rest) = s.strip_prefix("\\\\?\\unc\\") {
        s = format!("\\\\{rest}");
    } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
        s = rest.to_string();
    }
    s
}

/// Минимальные FFI-объявления kernel32. Платформенный FFI — только под
/// соответствующим cfg (конвенция кодовой базы: незагейченный user32
/// ломал линковку macOS/Linux)
#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    /// Нужен только dwFileAttributes; остальные поля держат layout корректным
    #[repr(C)]
    #[derive(Default)]
    pub struct ByHandleFileInformation {
        pub attributes: u32,
        pub creation: [u32; 2],
        pub access: [u32; 2],
        pub modification: [u32; 2],
        pub volume_serial: u32,
        pub size_high: u32,
        pub size_low: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetFileInformationByHandle(h: *mut c_void, info: *mut ByHandleFileInformation) -> i32;
        pub fn GetFinalPathNameByHandleW(h: *mut c_void, buf: *mut u16, len: u32, flags: u32) -> u32;
    }
}

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

/// Свободное место (байты, доступные текущему пользователю) на томе пути.
/// GGUF-конвейер (gguf.rs) проверяет место ДО много-гигабайтных операций:
/// «insufficient disk space» после часа скачивания — худший UX из возможных.
/// std не умеет — WinAPI/statvfs под гейтами. ОШИБКА тут не фатальна для
/// вызывающих: проверка места — оптимизация сообщения, а не гарант.
#[cfg(windows)]
pub fn free_bytes(path: &Path) -> Result<u64, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    // Null-терминированная UTF-16 — прямая передача, без HSTRING-конверсий:
    // API принимает произвольный каталог тома, root не обязателен
    let mut wide: Vec<u16> = path
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .collect();
    wide.push(0);
    let mut free: u64 = 0;
    let mut total: u64 = 0;
    let mut caller: u64 = 0;
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut caller),
            Some(&mut total),
            Some(&mut free),
        )
        .map_err(|e| format!("free_bytes({}): {e}", path.display()))?;
    }
    Ok(free)
}

#[cfg(unix)]
pub fn free_bytes(path: &Path) -> Result<u64, String> {
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| format!("free_bytes({}): path contains NUL", path.display()))?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if rc != 0 {
        return Err(format!("free_bytes({}): statvfs failed", path.display()));
    }
    // f_bavail — доступно НЕ-root пользователю (f_bfree — включая резерв root'а);
    // типы полей statvfs различаются между ОС, `as` приводит одинаково всюду
    Ok(st.f_bavail as u64 * st.f_frsize as u64)
}

/// Размеры каталогов хранилища — менеджер в «Основном» (секция «Хранилище»).
#[derive(Debug, Serialize)]
pub struct StorageStats {
    pub config: u64,
    pub checkpoints: u64,
    pub images: u64,
    pub sounds: u64,
    pub fonts: u64,
    /// GGUF Lab: экспорты, результаты резки, бинарник llama-server, логи —
    /// гигабайты; PLAN §28.3 обещает видимость storage-менеджеру (аудит 07.10 A1-12)
    pub gguf: u64,
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
            gguf: dir_size(&data.join("gguf")),
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
            // GGUF Lab: выгрузки/результаты/бинарь llama-server (скачивается
            // кнопкой заново) — единственный способ освободить десятки ГБ
            "gguf" => data.join("gguf"),
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
    fn free_bytes_reports_positive_on_real_volume() {
        let free = free_bytes(&std::env::temp_dir()).unwrap();
        assert!(free > 0, "temp volume reports zero free bytes");
    }

    #[test]
    fn open_write_verified_roundtrip_and_overwrite() {
        let dir = std::env::temp_dir().join(format!("haloui-verified-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        let write = |data: &[u8]| {
            let (mut f, verified) = open_write_verified(&path).unwrap();
            use std::io::{Seek, SeekFrom, Write};
            f.set_len(0).unwrap();
            f.seek(SeekFrom::Start(0)).unwrap();
            f.write_all(data).unwrap();
            verified
        };
        let v1 = write(b"hello");
        let v2 = write(b"world");
        assert_eq!(fs::read(&path).unwrap(), b"world");
        // Верифицированный путь — канонизованный настоящий адрес
        assert_eq!(
            fs::canonicalize(&path).unwrap(),
            fs::canonicalize(&v2).unwrap()
        );
        let _ = fs::remove_dir_all(&dir);
        drop(v1);
    }

    /// Финальный компонент — симлинк: открытие обязано отказать.
    /// На Windows создание симлинков требует привилегий/Developer Mode —
    /// если ОС не дала, тест честно пропускается (CI-раннеры возвышенны)
    #[test]
    fn open_write_verified_refuses_final_symlink() {
        let dir = std::env::temp_dir().join(format!("haloui-slink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.txt");
        fs::write(&target, b"real").unwrap();
        let link = dir.join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&target, &link).is_err() {
            eprintln!("skipped: no symlink privilege on this machine");
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let err = open_write_verified(&link).unwrap_err();
        assert!(
            err.contains("refused") || err.contains("symlink") || err.contains("Too many"),
            "unexpected error: {err}"
        );
        // Цель не пострадала
        assert_eq!(fs::read(&target).unwrap(), b"real");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Промежуточный компонент — симлинк: финальный путь дескриптора
    /// отражает настоящий адрес (резолв), ровно его проверяет вызывающий
    /// через perm::recheck_location — см. тест в tools.rs
    #[cfg(unix)]
    #[test]
    fn open_write_verified_resolves_parent_symlink() {
        let dir = std::env::temp_dir().join(format!("haloui-pdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        let via_link = dir.join("link").join("f.txt");
        let (mut f, verified) = open_write_verified(&via_link).unwrap();
        use std::io::Write;
        f.write_all(b"x").unwrap();
        // Верифицированный адрес — по настоящему каталогу, не по ссылке
        assert_eq!(verified, fs::canonicalize(dir.join("real")).unwrap().join("f.txt"));
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
