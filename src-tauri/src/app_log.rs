//! Файловое логирование и перехват паник для GUI-режима.
//!
//! На Windows в релизных сборках консоль отключена (windows_subsystem),
//! поэтому все eprintln! терялись без следа. Модуль организует запись
//! событий и аварийных паник в app_data/logs/nocturn.log с ротацией
//! (до 3 архивных файлов по 1 МБ) и автоматическим маскированием секретов.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_LOG_SIZE: u64 = 1024 * 1024; // 1 МБ
const MAX_BACKUPS: usize = 3;

static LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Конвертирует секунды Unix-эпохи в строку UTC вида "YYYY-MM-DD HH:MM:SS UTC"
fn current_timestamp() -> String {
    let now = std::time::SystemTime::now();
    let dur = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let total_secs = dur.as_secs();

    let secs_of_day = total_secs % 86400;
    let hours = secs_of_day / 3600;
    let minutes = (secs_of_day % 3600) / 60;
    let seconds = secs_of_day % 60;

    let mut days = total_secs / 86400;
    let mut year = 1970;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let days_in_year = if leap { 366 } else { 365 };
        if days >= days_in_year {
            days -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let days_in_months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for &dim in &days_in_months {
        if days >= dim {
            days -= dim;
            month += 1;
        } else {
            break;
        }
    }
    let day = days + 1;
    format!("{year:04}-{month:02}-{day:02} {hours:02}:{minutes:02}:{seconds:02} UTC")
}

/// Ротация файла при достижении потолка 1 МБ:
/// nocturn.2.log -> nocturn.3.log, nocturn.1.log -> nocturn.2.log, nocturn.log -> nocturn.1.log
fn rotate_if_needed(log_file: &Path) {
    if let Ok(meta) = fs::metadata(log_file) {
        if meta.len() >= MAX_LOG_SIZE {
            let parent = match log_file.parent() {
                Some(p) => p,
                None => return,
            };
            let oldest = parent.join(format!("nocturn.{MAX_BACKUPS}.log"));
            let _ = fs::remove_file(oldest);

            for i in (1..MAX_BACKUPS).rev() {
                let from = parent.join(format!("nocturn.{i}.log"));
                let to = parent.join(format!("nocturn.{}.log", i + 1));
                if from.exists() {
                    let _ = fs::rename(from, to);
                }
            }
            let backup_1 = parent.join("nocturn.1.log");
            let _ = fs::rename(log_file, backup_1);
        }
    }
}

/// Запись строки в лог-файл с ротацией и маскированием секретов
pub fn write_log(level: &str, msg: &str) {
    let sanitized_msg = crate::telegram::sanitize_outgoing_text(msg);
    let guard = match LOG_DIR.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(ref dir) = *guard else {
        eprintln!("[{level}] {sanitized_msg}");
        return;
    };

    let log_file = dir.join("nocturn.log");
    rotate_if_needed(&log_file);

    let ts = current_timestamp();
    let line = format!("[{ts}] [{level}] {sanitized_msg}\n");

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log_file) {
        let _ = f.write_all(line.as_bytes());
    }
    eprintln!("[{level}] {sanitized_msg}");
}

pub fn log_info(msg: &str) {
    write_log("INFO", msg);
}

pub fn log_warn(msg: &str) {
    write_log("WARN", msg);
}

pub fn log_error(msg: &str) {
    write_log("ERROR", msg);
}

/// Инициализация каталога логирования
pub fn init(dir: &Path) {
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("failed to create log dir: {e}");
        return;
    }
    let canon_dir = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut guard = match LOG_DIR.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = Some(canon_dir);
}

/// Ранний перехватчик паник до инициализации основного окна
pub fn init_early_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<Any> panic payload".to_string()
        };
        let panic_msg = format!("PANIC at {location}: {payload}");
        write_log("FATAL", &panic_msg);
        default_hook(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_current_timestamp_format() {
        let ts = current_timestamp();
        assert!(ts.ends_with(" UTC"));
        assert_eq!(ts.len(), 23); // "YYYY-MM-DD HH:MM:SS UTC"
    }

    #[test]
    fn test_log_rotation() {
        let tmp = std::env::temp_dir().join(format!("nocturn_log_test_{}", crate::fsutil::rand_hex8()));
        fs::create_dir_all(&tmp).unwrap();
        let log_file = tmp.join("nocturn.log");

        // Создаём файл размером более 1 МБ
        let big_data = vec![b'x'; (MAX_LOG_SIZE + 10) as usize];
        fs::write(&log_file, &big_data).unwrap();

        rotate_if_needed(&log_file);

        // nocturn.log должен быть перемещён в nocturn.1.log
        assert!(!log_file.exists());
        assert!(tmp.join("nocturn.1.log").exists());

        // Очищаем тестовый каталог
        let _ = fs::remove_dir_all(&tmp);
    }
}
