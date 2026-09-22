use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

pub mod browser;
mod crypto;
pub mod computer;
pub mod hooks;
pub mod imagegen;
pub mod mcp;
mod perm;
mod proc;
mod pty;
mod tools;

/// Реестр флагов отмены стримов: requestId → флаг
pub struct AbortRegistry(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

/// RAII-guard: удаляет запись из AbortRegistry при выходе из любого пути
/// (ранний return по abort-флагу, "[DONE]", все "?"-выходы). Ручной remove
/// в конце функции больше не нужен — Drop чистит автоматически.
struct AbortGuard<'a> {
    registry: &'a AbortRegistry,
    request_id: String,
}

impl Drop for AbortGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.registry.0.lock() {
            map.remove(&self.request_id);
        }
    }
}

/// Обрезает строку до `limit` байтов без паники на границе многобайтового символа:
/// String::truncate требует char boundary, а байтовые лимиты (64 КБ и т.п.) могут
/// попасть в середину кириллицы/CJK/эмодзи. Граница сдвигается назад до целого символа.
pub(crate) fn truncate_at_char_boundary(s: &mut String, limit: usize) {
    if s.len() <= limit {
        return;
    }
    let mut end = limit;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AbortRegistry(Mutex::new(HashMap::new())))
        .manage(pty::PtyRegistry(Mutex::new(HashMap::new())))
        .manage(mcp::McpRegistry::default())
        .manage(browser::BrowserRegistry::default())
        .setup(|app| {
            // Загружаем конфиги browser/computer в статические снапшоты
            use tauri::Manager;
            let cfg_dir = app
                .path()
                .app_config_dir()
                .map_err(|e| e.to_string())?;
            let read = |file: &str| -> Option<serde_json::Value> {
                let data = fs::read_to_string(cfg_dir.join(file)).ok()?;
                serde_json::from_str(&data).ok()
            };
            if let Some(v) = read("browser.json") {
                browser::set_config(serde_json::from_value(v).unwrap_or_default());
            }
            if let Some(v) = read("computer.json") {
                computer::set_config(serde_json::from_value(v).unwrap_or_default());
            }
            if let Some(v) = read("imagegen.json") {
                imagegen::set_config(serde_json::from_value(v).unwrap_or_default());
            }
            // Windows: привязка источника toast-уведомлений к Nocturn (в dev-режиме без
            // инсталлятора тосты иначе атрибуцируются хост-процессу).
            #[cfg(windows)]
            {
                #[link(name = "shell32")]
                extern "system" {
                    // HRESULT — 32-битный знаковый статус; core::ffi::HRESULT
                    // в текущей версии rustc нет, поэтому просто i32 (ABI тот же)
                    fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
                }
                // "com.haloui.app" в UTF-16 + нуль-терминатор
                let mut app_id: Vec<u16> = "com.haloui.app".encode_utf16().collect();
                app_id.push(0);
                unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            load_profiles,
            save_profiles,
            set_key_encryption,
            crypto_status,
            crypto_setup,
            crypto_unlock,
            crypto_reset,
            load_projects,
            save_projects,
            test_connection,
            chat_stream,
            chat_abort,
            load_sessions,
            save_sessions,
            detect_ollama,
            run_tool,
            hooks_load,
            hooks_save,
            hooks_test,
            hooks_run_event,
            shortcuts_load,
            shortcuts_save,
            usage_colors_load,
            usage_colors_save,
            subagents_load,
            subagents_save,
            commands_load,
            commands_save,
            plugin_read,
            plugins_load,
            plugins_save,
            get_tool_schemas,
            perm_set,
            perm_get,
            list_dir,
            git_status,
            checkpoint_save,
            checkpoint_list,
            checkpoint_restore,
            checkpoint_delete,
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            notes_list,
            notes_read,
            notes_write,
            notes_delete,
            mcp::mcp_list_servers,
            mcp::mcp_save_servers,
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_status,
            mcp::mcp_autoconnect,
            browser_get_config,
            browser_set_config,
            computer_get_config,
            computer_set_config,
            imagegen_get_config,
            imagegen_set_config,
            sound_import,
            sound_data,
            sound_delete,
            keep_awake,
            browser_view_start,
            browser_view_stop,
            browser_view_size
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Гасим дочерние MCP-процессы при выходе, чтобы не оставлять сирот
            if let tauri::RunEvent::Exit = event {
                if let Some(registry) = app.try_state::<mcp::McpRegistry>() {
                    registry.kill_all();
                }
                if let Some(registry) = app.try_state::<browser::BrowserRegistry>() {
                    registry.kill_all();
                }
            }
        });
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ApiSettings {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    /// Метка выбранного пресета провайдера ("deepseek", "anthropic", "custom"…).
    /// Старые settings.json без поля читаются как "" — фронт выведет из base_url.
    #[serde(default)]
    pub provider: String,
    /// Шифрование API-ключей (AES-256-GCM, мастер-ключ в Credential Manager)
    #[serde(default)]
    pub encrypt_keys: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub provider: String,
}

/// Хранилище профилей — отдельный файл profiles.json (не settings.json),
/// чтобы пересборка/сброс настроек не трогал ключи.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProfilesStore {
    #[serde(default)]
    pub profiles: Vec<ApiProfile>,
    #[serde(default)]
    pub active: String,
}

#[tauri::command(async)]
fn load_profiles(app: tauri::AppHandle) -> Result<ProfilesStore, String> {
    let path = config_file(&app, "profiles.json")?;
    if !path.exists() {
        // Миграция: профили, ранее сохранённые внутри settings.json
        let spath = config_file(&app, "settings.json")?;
        if let Ok(data) = fs::read_to_string(&spath) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                let store = ProfilesStore {
                    profiles: v
                        .get("profiles")
                        .and_then(|p| serde_json::from_value(p.clone()).ok())
                        .unwrap_or_default(),
                    active: v
                        .get("active_profile")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                };
                if !store.profiles.is_empty() {
                    let _ = save_profiles(app.clone(), store.profiles.clone(), store.active.clone(), false);
                    return Ok(store);
                }
            }
        }
        return Ok(ProfilesStore::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut store: ProfilesStore =
        serde_json::from_str(&data).map_err(|e| format!("profiles file corrupted: {e}"))?;
    // Прозрачно расшифровываем ключи профилей
    for p in &mut store.profiles {
        if crypto::is_encrypted(&p.api_key) {
            // Потеря мастер-ключа → пустой ключ, профиль остаётся опознаваемым
            p.api_key = crypto::decrypt(&p.api_key).unwrap_or_default();
        }
    }
    Ok(store)
}

#[tauri::command(async)]
fn save_profiles(
    app: tauri::AppHandle,
    mut profiles: Vec<ApiProfile>,
    active: String,
    encrypt: bool,
) -> Result<(), String> {
    if encrypt {
        for p in &mut profiles {
            if !p.api_key.is_empty() && !crypto::is_encrypted(&p.api_key) {
                p.api_key = crypto::encrypt(&p.api_key)?;
            }
        }
    }
    let path = config_file(&app, "profiles.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "profiles": profiles,
        "active": active,
    }))
    .map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Метa-файл шифрования crypto.json: соль KDF + маркер-проверка пароля.
/// kdf: "argon2id" (текущий) или "pbkdf2" (легаси, отсутствие поля = pbkdf2)
fn crypto_meta_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    config_file(app, "crypto.json")
}

/// (соль, маркер, kdf)
type CryptoMeta = (Vec<u8>, String, String);

fn crypto_read_meta(app: &tauri::AppHandle) -> Result<Option<CryptoMeta>, String> {
    let path = crypto_meta_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let salt = v
        .get("salt")
        .and_then(|x| x.as_str())
        .and_then(|s| crypto::hex_decode(s))
        .ok_or("crypto.json corrupted")?;
    let check = v
        .get("check")
        .and_then(|x| x.as_str())
        .ok_or("crypto.json corrupted")?
        .to_string();
    let kdf = v
        .get("kdf")
        .and_then(|x| x.as_str())
        .unwrap_or("pbkdf2")
        .to_string();
    Ok(Some((salt, check, kdf)))
}

fn crypto_write_meta(
    app: &tauri::AppHandle,
    salt: &[u8],
    check: &str,
    kdf: &str,
) -> Result<(), String> {
    let path = crypto_meta_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "salt": crypto::hex_encode(salt),
        "check": check,
        "kdf": kdf,
    }))
    .map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Состояние шифрования для окна входа на старте
#[tauri::command]
fn crypto_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let enabled = config_file(&app, "settings.json")
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
        .and_then(|v| v.get("encrypt_keys").and_then(|x| x.as_bool()))
        .unwrap_or(false);
    Ok(serde_json::json!({
        "enabled": enabled,
        "setup": crypto_read_meta(&app)?.is_some(),
        "unlocked": crypto::has_key(),
    }))
}

/// Первое создание мастер-пароля: соль + маркер, ключ в память (Argon2id)
#[tauri::command]
fn crypto_setup(app: tauri::AppHandle, password: String) -> Result<(), String> {
    if password.len() < 8 {
        return Err("password too short (minimum 8 characters)".into());
    }
    let salt = crypto::new_salt();
    let key = crypto::derive_key_argon2(&password, &salt);
    let check = crypto::make_check(&key)?;
    crypto::set_key(key);
    crypto_write_meta(&app, &salt, &check, "argon2id")
}

/// Разблокировка существующим паролем. Легаси-хранилище (PBKDF2) после
/// успешной проверки тихо мигрирует на Argon2id: ключ перегенерируется,
/// все зашифрованные поля перезаписываются новым ключом.
#[tauri::command]
fn crypto_unlock(app: tauri::AppHandle, password: String) -> Result<(), String> {
    let (salt, check, kdf) =
        crypto_read_meta(&app)?.ok_or("encryption is not set up")?;
    let key = match kdf.as_str() {
        "argon2id" => crypto::derive_key_argon2(&password, &salt),
        _ => crypto::derive_key(&password, &salt),
    };
    if !crypto::verify_check(&key, &check) {
        return Err("wrong password".into());
    }
    if kdf == "argon2id" {
        crypto::set_key(key);
        return Ok(());
    }
    // --- Легаси-миграция PBKDF2 → Argon2id ---
    let new_salt = crypto::new_salt();
    let new_key = crypto::derive_key_argon2(&password, &new_salt);
    rekey_all(&app, &key, &new_key)?;
    let new_check = crypto::make_check(&new_key)?;
    crypto::set_key(new_key);
    crypto_write_meta(&app, &new_salt, &new_check, "argon2id")
}

/// Перешифровать все зашифрованные поля (settings.json, profiles.json)
/// со старого ключа на новый. Поля, не расшифровавшиеся старым ключом,
/// оставляются как есть (потеря уже произошла ранее).
fn rekey_all(app: &tauri::AppHandle, old_key: &[u8], new_key: &[u8]) -> Result<(), String> {
    for name in ["settings.json", "profiles.json"] {
        let path = config_file(app, name)?;
        if !path.exists() {
            continue;
        }
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut v: serde_json::Value =
            serde_json::from_str(&data).unwrap_or(serde_json::json!({}));
        let mut fields: Vec<&mut serde_json::Value> = Vec::new();
        if name == "settings.json" {
            if let Some(f) = v.get_mut("api_key") {
                fields.push(f);
            }
        } else if let Some(arr) = v.get_mut("profiles").and_then(|x| x.as_array_mut()) {
            for p in arr {
                if let Some(f) = p.get_mut("api_key") {
                    fields.push(f);
                }
            }
        }
        for f in fields {
            if let Some(stored) = f.as_str() {
                if !crypto::is_encrypted(stored) {
                    continue;
                }
                if let Some(plain) = crypto::decrypt_with(old_key, stored) {
                    *f = serde_json::Value::String(
                        crypto::encrypt_with(new_key, &plain)?,
                    );
                }
            }
        }
        fs::write(&path, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Забыли пароль: полный сброс шифрования (зашифрованные ключи утеряны).
/// Разрушающая операция — требует явного подтверждения confirm="RESET".
#[tauri::command]
fn crypto_reset(app: tauri::AppHandle, confirm: String) -> Result<(), String> {
    if confirm != "RESET" {
        return Err("confirmation required: pass confirm=\"RESET\" to wipe stored keys".into());
    }
    crypto::clear_key();
    let meta = crypto_meta_path(&app)?;
    if meta.exists() {
        fs::remove_file(&meta).map_err(|e| e.to_string())?;
    }
    // Чистим зашифрованные поля — восстановить их без пароля невозможно
    for (path, _fields) in [
        (
            config_file(&app, "settings.json")?,
            vec!["api_key".to_string()],
        ),
        (
            config_file(&app, "profiles.json")?,
            vec!["api_key".to_string()],
        ),
    ] {
        if !path.exists() {
            continue;
        }
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut v: serde_json::Value = serde_json::from_str(&data).unwrap_or(serde_json::json!({}));
        if path.ends_with("settings.json") {
            v["api_key"] = serde_json::Value::String(String::new());
            v["encrypt_keys"] = serde_json::Value::Bool(false);
        } else if let Some(arr) = v.get_mut("profiles").and_then(|x| x.as_array_mut()) {
            for p in arr {
                p["api_key"] = serde_json::Value::String(String::new());
            }
        }
        fs::write(&path, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Тумблер шифрования: перезаписывает settings.json и profiles.json,
/// шифруя (или расшифровывая) все API-ключи на месте.
/// Включение требует разблокированного хранилища (пароль уже введён).
#[tauri::command(async)]
fn set_key_encryption(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    if enable && !crypto::has_key() {
        return Err("vault is locked: enter the master password first".into());
    }

    // settings.json: ключ + флаг encrypt_keys
    let spath = config_file(&app, "settings.json")?;
    if spath.exists() {
        let data = fs::read_to_string(&spath).map_err(|e| e.to_string())?;
        let mut v: serde_json::Value = serde_json::from_str(&data).unwrap_or(serde_json::json!({}));
        if let Some(key) = v.get("api_key").and_then(|x| x.as_str()).map(String::from) {
            let new_key = if enable && !key.is_empty() && !crypto::is_encrypted(&key) {
                crypto::encrypt(&key)?
            } else if !enable && crypto::is_encrypted(&key) {
                crypto::decrypt(&key).unwrap_or_default()
            } else {
                key
            };
            v["api_key"] = serde_json::Value::String(new_key);
        }
        v["encrypt_keys"] = serde_json::Value::Bool(enable);
        fs::write(&spath, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }

    // profiles.json: ключи всех профилей
    let ppath = config_file(&app, "profiles.json")?;
    if ppath.exists() {
        let data = fs::read_to_string(&ppath).map_err(|e| e.to_string())?;
        let mut v: serde_json::Value = serde_json::from_str(&data).unwrap_or(serde_json::json!({}));
        if let Some(arr) = v.get_mut("profiles").and_then(|x| x.as_array_mut()) {
            for p in arr {
                if let Some(key) = p.get("api_key").and_then(|x| x.as_str()).map(String::from) {
                    let new_key = if enable && !key.is_empty() && !crypto::is_encrypted(&key) {
                        crypto::encrypt(&key)?
                    } else if !enable && crypto::is_encrypted(&key) {
                        crypto::decrypt(&key).unwrap_or_default()
                    } else {
                        key
                    };
                    p["api_key"] = serde_json::Value::String(new_key);
                }
            }
        }
        fs::write(&ppath, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Проект (фронтовый Project; отдельное поле — привязанный профиль API)
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ProjectRec {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub profile_id: String,
}

/// Хранилище проектов — отдельный файл projects.json
#[tauri::command(async)]
fn load_projects(app: tauri::AppHandle) -> Result<Vec<ProjectRec>, String> {
    let path = config_file(&app, "projects.json")?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("projects file corrupted: {e}"))
}

#[tauri::command(async)]
fn save_projects(app: tauri::AppHandle, projects: Vec<ProjectRec>) -> Result<(), String> {
    let path = config_file(&app, "projects.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

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
fn git_status(path: String) -> Result<Vec<GitEntry>, String> {
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
struct CheckpointFile {
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
fn checkpoints_dir(app: &tauri::AppHandle, root: &str) -> Result<PathBuf, String> {
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

/// Рекурсивный обход проекта: файлы в base64, с лимитами по размеру и объёму
fn collect_files(dir: &Path, root: &Path, files: &mut Vec<CheckpointFile>, total: &mut u64) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // недоступная папка — просто пропускаем
    };
    for entry in entries.flatten() {
        if *total >= CP_MAX_TOTAL {
            return;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let name = entry.file_name();
            if CP_SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                continue;
            }
            collect_files(&path, root, files, total);
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
fn cp_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || c == '-')
}

#[tauri::command(async)]
fn checkpoint_save(
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
fn checkpoint_list(app: tauri::AppHandle, path: String) -> Result<Vec<CheckpointMeta>, String> {
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
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

#[tauri::command(async)]
fn checkpoint_restore(
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
        // Разрешаем только относительные пути без подъёма
        let rel = f.rel.replace('/', "\\");
        if rel.starts_with('\\') || rel.split('\\').any(|part| part == ".." || part.is_empty()) {
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
fn checkpoint_delete(app: tauri::AppHandle, path: String, id: String) -> Result<(), String> {
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
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
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

// ---------------------------------------------------------------------------
// Заметки (M-N1): личный vault markdown-файлов в %APPDATA%/notes.
// Файл = узел будущего графа, [[ссылки]] в тексте = рёбра.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct NoteInfo {
    pub file: String,
    /// Заголовок из первой строки "# ...", иначе имя файла
    pub title: String,
    pub updated: u64,
}

fn notes_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
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
fn sanitize_note_file(file: &str) -> Result<String, String> {
    tools::sanitize_note_name(file)
}

fn note_title_from_content(file: &str, content: &str) -> String {
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
fn notes_list(app: tauri::AppHandle) -> Result<Vec<NoteInfo>, String> {
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
        let content = fs::read_to_string(entry.path()).unwrap_or_default();
        out.push(NoteInfo {
            title: note_title_from_content(&name, &content),
            file: name,
            updated,
        });
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(out)
}

#[tauri::command(async)]
fn notes_read(app: tauri::AppHandle, file: String) -> Result<String, String> {
    let file = sanitize_note_file(&file)?;
    let path = notes_dir(&app)?.join(file);
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn notes_write(app: tauri::AppHandle, file: String, content: String) -> Result<(), String> {
    let file = sanitize_note_file(&file)?;
    let path = notes_dir(&app)?.join(file);
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn notes_delete(app: tauri::AppHandle, file: String) -> Result<(), String> {
    let file = sanitize_note_file(&file)?;
    let path = notes_dir(&app)?.join(file);
    fs::remove_file(path).map_err(|e| e.to_string())
}

fn config_file(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))?;
    Ok(dir.join(name))
}

#[tauri::command(async)]
fn load_settings(app: tauri::AppHandle) -> Result<ApiSettings, String> {
    let path = config_file(&app, "settings.json")?;
    if !path.exists() {
        return Ok(ApiSettings::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut s: ApiSettings =
        serde_json::from_str(&data).map_err(|e| format!("settings file corrupted: {e}"))?;
    // Прозрачно расшифровываем ключ, если он зашифрован; при потере
    // мастер-ключа возвращаем пустую строку вместо кракозябр
    if crypto::is_encrypted(&s.api_key) {
        s.api_key = crypto::decrypt(&s.api_key).unwrap_or_default();
    }
    Ok(s)
}

#[tauri::command(async)]
fn save_settings(app: tauri::AppHandle, settings: ApiSettings) -> Result<(), String> {
    let path = config_file(&app, "settings.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut s = settings;
    if s.encrypt_keys && !s.api_key.is_empty() && !crypto::is_encrypted(&s.api_key) {
        s.api_key = crypto::encrypt(&s.api_key)?;
    }
    let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub vision: bool,
    pub text: bool,
    /// Контекстное окно, если провайдер его отдаёт (OpenRouter:
    /// top_provider.context_length / context_length; vLLM: max_model_len)
    #[serde(default)]
    pub context: Option<u64>,
}

/// Лёгкая проверка провайдера: GET {base_url}/models со Bearer-ключом.
#[tauri::command]
async fn test_connection(base_url: String, api_key: String) -> Result<Vec<ModelInfo>, String> {
    let base_url = normalize_base_url(&base_url);
    // Лимит страницы понимает не каждый провайдер (Gemini на нём падает
    // с 400), а OpenRouter без него отдаёт весь список — оставляем
    // ?limit только Anthropic, остальным — голый /models
    let url = if is_anthropic_base(&base_url) {
        format!("{}/models?limit=100", base_url.trim_end_matches('/'))
    } else {
        format!("{}/models", base_url.trim_end_matches('/'))
    };

    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if is_anthropic_base(&base_url) {
        // Anthropic: /v1/models существует, но авторизация — x-api-key + версия
        req = req
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.bearer_auth(api_key.trim());
    }
    let resp = req
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("failed to connect: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!(
            "ключ не принят ({}): проверьте, что ключ выдан именно этим провайдером —              у каждого сервиса свой ключ, ключ от OpenRouter не подходит к другим",
            status.as_u16()
        ));
    }
    if !status.is_success() {
        return Err(provider_error(status, &body));
    }
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        let snippet: String = body.chars().take(150).collect();
        format!("unexpected response format: {e}; body: {snippet}")
    })?;

    let mut models: Vec<ModelInfo> = json
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|v| v.as_str())?.to_string();
                    let modalities = m
                        .get("architecture")
                        .and_then(|a| a.get("input_modalities"))
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str())
                                .map(|s| s.to_string())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let vision = modalities.iter().any(|x| x == "image");
                    let text = modalities.is_empty() || modalities.iter().any(|x| x == "text");
                    // Контекстное окно: OpenRouter кладёт его в top_provider,
                    // остальные — в верхнеуровневые поля
                    let context = m
                        .get("top_provider")
                        .and_then(|t| t.get("context_length"))
                        .and_then(|v| v.as_u64())
                        .or_else(|| m.get("context_length").and_then(|v| v.as_u64()))
                        .or_else(|| m.get("max_model_len").and_then(|v| v.as_u64()))
                        .or_else(|| {
                            m.get("max_context_length").and_then(|v| v.as_u64())
                        })
                        .filter(|c| *c >= 1024);
                    Some(ModelInfo {
                        id,
                        vision,
                        text,
                        context,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // Бесплатные (:free) — наверх списка
    models.sort_by(|a, b| {
        let fa = a.id.ends_with(":free");
        let fb = b.id.ends_with(":free");
        fb.cmp(&fa).then_with(|| a.id.cmp(&b.id))
    });

    Ok(models)
}

/// Извлекает человекочитаемую ошибку провайдера из тела ответа
/// ({"error": {"message": "..."}}) или возвращает фрагмент сырого тела.
fn provider_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").cloned())
        .and_then(|e| {
            e.get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .or_else(|| e.as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("HTTP {}: {}", status.as_u16(), detail)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    // Строка ИЛИ массив [{type:"text"|"image_url", ...}] для vision-моделей
    pub content: serde_json::Value,
    /// Результат инструмента: к какому вызову относится (роль "tool")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Вызовы инструментов в истории (роль "assistant", OpenAI-формат)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
}

/// Стриминговый чат: POST {base_url}/chat/completions с stream:true.
/// Куски ответа и reasoning пробрасываются на фронт событиями:
///   "chat-chunk"   { requestId, delta }
///   "chat-thought" { requestId, thought }
///   "chat-usage"   { requestId, promptTokens, completionTokens, totalTokens }
/// Прерывание: chat_abort(request_id) поднимает флаг — поток аккуратно гаснет.
#[tauri::command]
async fn chat_stream(
    app: tauri::AppHandle,
    registry: tauri::State<'_, AbortRegistry>,
    request_id: String,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    tools: Option<serde_json::Value>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    // Адаптер протокола выбирается по Base URL: нативный Anthropic —
    // свой формат запроса и SSE-событий, всё остальное — OpenAI-совместимое
    let base_url = normalize_base_url(&base_url);
    let anthropic = is_anthropic_base(&base_url);
    let base = base_url.trim_end_matches('/');

    let client = reqwest::Client::new();
    let resp = if anthropic {
        let body = build_anthropic_body(
            &model,
            &messages,
            tools.as_ref().filter(|t| !t.is_null()),
            reasoning_effort.as_deref(),
        );
        client
            .post(format!("{base}/messages"))
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| format!("failed to connect: {e}"))?
    } else {
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "stream_options": { "include_usage": true }
        });
        // M2: здесь передаются определения инструментов агента
        if let Some(tools) = tools.filter(|t| !t.is_null()) {
            body["tools"] = tools;
        }
        // Reasoning effort (OpenAI-совместимые; "max" маппится в "high")
        if let Some(eff) = reasoning_effort.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let mapped = if eff == "max" { "high" } else { eff };
            body["reasoning_effort"] = serde_json::json!(mapped);
        }
        client
            .post(format!("{base}/chat/completions"))
            .bearer_auth(api_key.trim())
            .json(&body)
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| format!("failed to connect: {e}"))?
    };

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status, &err_body));
    }

    // Регистрируем флаг отмены для этого запроса
    let flag: Arc<AtomicBool> = {
        let mut map = registry.0.lock().map_err(|e| e.to_string())?;
        let f = Arc::new(AtomicBool::new(false));
        map.insert(request_id.clone(), f.clone());
        f
    };
    // Guard чистит запись при любом выходе из функции (в т.ч. по "?" и return)
    let _abort_guard = AbortGuard {
        registry: &*registry,
        request_id: request_id.clone(),
    };

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut acc: Box<dyn StreamFeed + Send> = if anthropic {
        Box::new(AnthropicAccumulator::default())
    } else {
        Box::new(SseAccumulator::default())
    };

    while let Some(chunk) = stream.next().await {
        // Прерывание: агент ушёл «в бесконечное размышление» — гасим поток
        if flag.load(Ordering::Relaxed) {
            return Ok(());
        }
        let bytes = chunk.map_err(|e| format!("stream interrupted: {e}"))?;
        buf.extend_from_slice(&bytes);

        for line in take_complete_lines(&mut buf) {
            if flag.load(Ordering::Relaxed) {
                return Ok(());
            }
            let line = line.trim();
            if !line.starts_with("data:") {
                continue;
            }
            let data = line[5..].trim();
            if data == "[DONE]" {
                return Ok(());
            }
            for event in acc.feed(data) {
                match event {
                    FeedEvent::Content { delta } => {
                        app.emit(
                            "chat-chunk",
                            serde_json::json!({ "requestId": request_id, "delta": delta }),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    FeedEvent::Thought { delta } => {
                        app.emit(
                            "chat-thought",
                            serde_json::json!({ "requestId": request_id, "thought": delta }),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    FeedEvent::Usage { prompt, completion, total } => {
                        app.emit(
                            "chat-usage",
                            serde_json::json!({
                                "requestId": request_id,
                                "promptTokens": prompt,
                                "completionTokens": completion,
                                "totalTokens": total
                            }),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    FeedEvent::ToolCallsFinished { calls } => {
                        app.emit(
                            "chat-tool-calls",
                            serde_json::json!({ "requestId": request_id, "calls": calls }),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Извлекает из буфера все строки, завершённые байтом '\n'. Каждая строка
/// конвертируется из UTF-8 ровно один раз, поэтому многобайтный символ,
/// разрезанный границей сетевых чанков, не превращается в U+FFFD. Хвост без
/// '\n' остаётся в буфере до следующего куска.
fn take_complete_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        out.push(String::from_utf8_lossy(&line).to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// M1: Аккумулятор SSE-потока (tool calling)
// ---------------------------------------------------------------------------

/// Вызов инструмента из стрима. arguments — «сырая» склеенная строка JSON;
/// парсится один раз после закрытия вызова, инкрементальный JSON-парсинг не нужен.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct StreamToolCall {
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

/// События, которые аккумулятор отдаёт наружу после каждой data-строки
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeedEvent {
    Content { delta: String },
    Thought { delta: String },
    Usage { prompt: u64, completion: u64, total: u64 },
    ToolCallsFinished { calls: Vec<StreamToolCall> },
}

/// Накапливает разобранные data-чанки стрима
#[derive(Debug, Default)]
pub struct SseAccumulator {
    tool_calls: Vec<StreamToolCall>,
    saw_tool_call: bool,
    finish_reason: Option<String>,
}

impl SseAccumulator {
    /// Обрабатывает одну data-строку (без префикса "data:"), возвращает события
    pub fn feed(&mut self, data: &str) -> Vec<FeedEvent> {
        let mut events = Vec::new();
        let value: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return events, // мусорный чанк игнорируем
        };

        // usage обычно приходит в финальном чанке
        if let Some(usage) = value.get("usage").filter(|u| !u.is_null()) {
            let prompt = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let completion = usage
                .get("completion_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            events.push(FeedEvent::Usage {
                prompt,
                completion,
                total: prompt + completion,
            });
        }

        let choice = &value["choices"][0];

        if let Some(reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            self.finish_reason = Some(reason.to_string());
        }

        let delta = &choice["delta"];

        if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
            if !content.is_empty() {
                events.push(FeedEvent::Content { delta: content.to_string() });
            }
        }

        let reasoning = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !reasoning.is_empty() {
            events.push(FeedEvent::Thought { delta: reasoning.to_string() });
        }

        // Склейка tool_calls по index: аргументы — куски строки
        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            self.saw_tool_call = true;
            for call in calls {
                let index = call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                // Добиваем вектор до нужного индекса
                while self.tool_calls.len() <= index {
                    self.tool_calls.push(StreamToolCall { index: self.tool_calls.len(), ..Default::default() });
                }
                let slot = &mut self.tool_calls[index];
                if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        slot.id = id.to_string();
                    }
                }
                if let Some(name) = call["function"].get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        slot.name = name.to_string();
                    }
                }
                if let Some(args) = call["function"].get("arguments").and_then(|v| v.as_str()) {
                    slot.arguments.push_str(args);
                }
            }
        }

        // Вызов закрыт: парсим склеенные аргументы один раз
        if self.finish_reason.as_deref() == Some("tool_calls") && self.saw_tool_call {
            let mut calls = self.tool_calls.clone();
            for c in &mut calls {
                if c.arguments.trim().is_empty() {
                    c.arguments = "{}".to_string();
                }
            }
            events.push(FeedEvent::ToolCallsFinished { calls });
        }

        events
    }
}

// ---------------------------------------------------------------------------
// Адаптеры протоколов: OpenAI-совместимый (SseAccumulator) и нативный Anthropic
// ---------------------------------------------------------------------------

/// Общий интерфейс стрим-парсера: data-строка SSE → события фронтовому каналу
trait StreamFeed: Send {
    fn feed(&mut self, data: &str) -> Vec<FeedEvent>;
}

/// Детект нативного Anthropic по Base URL
fn is_anthropic_base(base_url: &str) -> bool {
    base_url.contains("api.anthropic.com")
}

/// Мягкая почта частых опечаток в Base URL.
/// Gemini отвечает на OpenAI-совместимом слое только по .../v1beta/openai —
/// если пользователь вписал URL без него, дописываем сами.
fn normalize_base_url(base_url: &str) -> String {
    let u = base_url.trim().trim_end_matches('/');
    if u.contains("generativelanguage.googleapis.com") && !u.ends_with("/openai") {
        return format!("{u}/openai");
    }
    u.to_string()
}

impl StreamFeed for SseAccumulator {
    fn feed(&mut self, data: &str) -> Vec<FeedEvent> {
        SseAccumulator::feed(self, data)
    }
}

/// Тело запроса для нативного Messages API: system — отдельным полем,
/// tool-история конвертируется в content-блоки tool_use / tool_result,
/// изображения из data-URL — в блоки {"type":"image","source":{...}}.
fn build_anthropic_body(
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&serde_json::Value>,
    reasoning_effort: Option<&str>,
) -> serde_json::Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut msgs: Vec<serde_json::Value> = Vec::new();

    for m in messages {
        match m.role.as_str() {
            "system" => {
                if let Some(text) = m.content.as_str() {
                    system_parts.push(text.to_string());
                }
            }
            "tool" => {
                // Результат инструмента → user-сообщение с tool_result
                let tool_use_id = m.tool_call_id.clone().unwrap_or_default();
                let content = m.content.as_str().unwrap_or("").to_string();
                msgs.push(serde_json::json!({
                    "role": "user",
                    "content": [{ "type": "tool_result", "tool_use_id": tool_use_id, "content": content }]
                }));
            }
            "assistant" => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if let Some(text) = m.content.as_str() {
                    if !text.is_empty() {
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
                if let Some(calls) = m.tool_calls.as_ref().and_then(|t| t.as_array()) {
                    for c in calls {
                        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = c["function"]["name"].as_str().unwrap_or("");
                        let args_raw = c["function"]["arguments"].as_str().unwrap_or("{}");
                        let input: serde_json::Value =
                            serde_json::from_str(args_raw).unwrap_or(serde_json::json!({}));
                        blocks.push(serde_json::json!({
                            "type": "tool_use", "id": id, "name": name, "input": input
                        }));
                    }
                }
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(serde_json::json!({ "role": "assistant", "content": blocks }));
            }
            _ => {
                // user: строка или массив с картинками — конвертируем vision-формат
                let content = if m.content.is_array() {
                    let arr = m.content.as_array().unwrap();
                    let blocks: Vec<serde_json::Value> = arr
                        .iter()
                        .filter_map(|part| {
                            let ptype = part.get("type").and_then(|v| v.as_str())?;
                            if ptype == "text" {
                                Some(serde_json::json!({
                                    "type": "text",
                                    "text": part.get("text").cloned().unwrap_or(serde_json::json!(""))
                                }))
                            } else if ptype == "image_url" {
                                let url = part["image_url"]["url"].as_str()?;
                                anthropic_image_block(url)
                            } else {
                                None
                            }
                        })
                        .collect();
                    serde_json::Value::Array(blocks)
                } else {
                    m.content.clone()
                };
                msgs.push(serde_json::json!({ "role": m.role, "content": content }));
            }
        }
    }

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "messages": msgs,
        "stream": true,
    });
    // Extended thinking: усилие маппится в бюджет размышлений; max_tokens должен покрывать бюджет
    if let Some(eff) = reasoning_effort.map(str::trim).filter(|s| !s.is_empty() && *s != "off") {
        let budget: u64 = match eff { "low" => 2048, "high" => 10000, _ => 16000 };
        body["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": budget });
        body["max_tokens"] = serde_json::json!(8192 + budget);
    }
    if !system_parts.is_empty() {
        body["system"] = serde_json::Value::String(system_parts.join("\n\n"));
    }
    if let Some(tools) = tools.and_then(|t| t.as_array()) {
        // OpenAI-схемы → Anthropic-формат
        let converted: Vec<serde_json::Value> = tools
            .iter()
            .filter_map(|t| {
                let f = &t["function"];
                Some(serde_json::json!({
                    "name": f.get("name").and_then(|v| v.as_str())?,
                    "description": f.get("description").cloned().unwrap_or(serde_json::json!("")),
                    "input_schema": f.get("parameters").cloned().unwrap_or(serde_json::json!({"type":"object"})),
                }))
            })
            .collect();
        if !converted.is_empty() {
            body["tools"] = serde_json::Value::Array(converted);
        }
    }
    body
}

/// data-URL (data:image/png;base64,…) → Anthropic-блок изображения
fn anthropic_image_block(data_url: &str) -> Option<serde_json::Value> {
    let rest = data_url.strip_prefix("data:")?;
    let (mime, data) = rest.split_once(";base64,")?;
    Some(serde_json::json!({
        "type": "image",
        "source": { "type": "base64", "media_type": mime, "data": data }
    }))
}

/// Парсер SSE-событий нативного Anthropic Messages API.
/// События: message_start (usage in), content_block_delta (text/thinking/
/// input_json), content_block_stop (закрытие tool_use), message_delta (usage out).
#[derive(Debug, Default)]
pub struct AnthropicAccumulator {
    tool_id: String,
    tool_name: String,
    tool_json: String,
    in_tool: bool,
    input_tokens: u64,
}

impl StreamFeed for AnthropicAccumulator {
    fn feed(&mut self, data: &str) -> Vec<FeedEvent> {
        let mut events = Vec::new();
        let value: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return events,
        };

        match value.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "message_start" => {
                self.input_tokens = value["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                events.push(FeedEvent::Usage {
                    prompt: self.input_tokens,
                    completion: 0,
                    total: self.input_tokens,
                });
            }
            "content_block_start" => {
                let block = &value["content_block"];
                if block["type"] == "tool_use" {
                    self.in_tool = true;
                    self.tool_id = block["id"].as_str().unwrap_or("").to_string();
                    self.tool_name = block["name"].as_str().unwrap_or("").to_string();
                    self.tool_json.clear();
                }
            }
            "content_block_delta" => {
                let delta = &value["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        if let Some(text) = delta["text"].as_str() {
                            if !text.is_empty() {
                                events.push(FeedEvent::Content { delta: text.to_string() });
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = delta["thinking"].as_str() {
                            if !t.is_empty() {
                                events.push(FeedEvent::Thought { delta: t.to_string() });
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let Some(j) = delta["partial_json"].as_str() {
                            self.tool_json.push_str(j);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if self.in_tool {
                    self.in_tool = false;
                    let mut arguments = std::mem::take(&mut self.tool_json);
                    if arguments.trim().is_empty() {
                        arguments = "{}".to_string();
                    }
                    events.push(FeedEvent::ToolCallsFinished {
                        calls: vec![StreamToolCall {
                            index: 0,
                            id: std::mem::take(&mut self.tool_id),
                            name: std::mem::take(&mut self.tool_name),
                            arguments,
                        }],
                    });
                }
            }
            "message_delta" => {
                let output = value["usage"]["output_tokens"].as_u64().unwrap_or(0);
                events.push(FeedEvent::Usage {
                    prompt: self.input_tokens,
                    completion: output,
                    total: self.input_tokens + output,
                });
            }
            _ => {}
        }
        events
    }
}

#[cfg(test)]
mod anthropic_tests {
    use super::*;

    fn feed_lines(acc: &mut AnthropicAccumulator, lines: &[&str]) -> Vec<FeedEvent> {
        let mut events = Vec::new();
        for l in lines {
            events.extend(acc.feed(l));
        }
        events
    }

    #[test]
    fn anthropic_text_thought_usage() {
        let mut acc = AnthropicAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"type":"message_start","message":{"usage":{"input_tokens":120}}}"#,
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"думаю"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Привет"}}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#,
            ],
        );
        assert!(events.iter().any(|e| matches!(e, FeedEvent::Thought { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, FeedEvent::Content { delta } if delta == "Привет")));
        // Финальный usage: prompt=120, completion=42
        assert!(events.iter().any(
            |e| matches!(e, FeedEvent::Usage { prompt: 120, completion: 42, total: 162 })
        ));
    }

    #[test]
    fn anthropic_tool_call_glued_from_chunks() {
        let mut acc = AnthropicAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs_write"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}"#,
                r#"{"type":"content_block_stop","index":0}"#,
            ],
        );
        let calls = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .expect("tool calls event");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(calls[0].name, "fs_write");
        assert_eq!(calls[0].arguments, r#"{"path":"a.txt"}"#);
    }

    #[test]
    fn anthropic_body_extracts_system_and_tools() {
        let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: serde_json::json!("Ты помощник"),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: serde_json::json!("результат"),
                tool_call_id: Some("toolu_9".into()),
                tool_calls: None,
            },
            ChatMessage {
                role: "assistant".into(),
                content: serde_json::json!(""),
                tool_call_id: None,
                tool_calls: Some(serde_json::json!([
                    {"id":"toolu_9","type":"function","function":{"name":"fs_read","arguments":"{\"path\":\"a\"}"}}
                ])),
            },
        ];
        let tools = serde_json::json!([
            {"type":"function","function":{"name":"fs_read","description":"read","parameters":{"type":"object"}}}
        ]);
        let body = build_anthropic_body("claude-x", &messages, Some(&tools), None);
        assert_eq!(body["system"], "Ты помощник");
        assert_eq!(body["max_tokens"], 8192);
        // tool-история сконвертирована в tool_use/tool_result
        assert_eq!(body["messages"][0]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][0]["content"][0]["tool_use_id"], "toolu_9");
        assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn build_anthropic_body_reasoning_budget() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!("привет"),
            tool_call_id: None,
            tool_calls: None,
        }];
        // "max" → бюджет 16000, max_tokens покрывает бюджет (8192 + 16000)
        let body = build_anthropic_body("claude-x", &messages, None, Some("max"));
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 16000);
        assert_eq!(body["max_tokens"], 24192);
        // "low" → бюджет 2048
        let body = build_anthropic_body("claude-x", &messages, None, Some("low"));
        assert_eq!(body["thinking"]["budget_tokens"], 2048);
        assert_eq!(body["max_tokens"], 10240);
        // "off" — thinking не включается
        let body = build_anthropic_body("claude-x", &messages, None, Some("off"));
        assert!(body.get("thinking").is_none());
        assert_eq!(body["max_tokens"], 8192);
    }
}

/// Прерывание активного стрима
#[tauri::command(async)]
fn chat_abort(registry: tauri::State<'_, AbortRegistry>, request_id: String) {
    if let Ok(map) = registry.0.lock() {
        if let Some(flag) = map.get(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Автообнаружение локальной Ollama: GET http://localhost:11434/v1/models.
/// Ok(None) — Ollama не отвечает, Ok(Some(ids)) — список локальных моделей.
#[tauri::command]
async fn detect_ollama() -> Result<Option<Vec<String>>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("http://localhost:11434/v1/models")
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let body = r.text().await.unwrap_or_default();
            let json: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let ids = json
                .get("data")
                .and_then(|d| d.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|m| {
                            m.get("id").and_then(|v| v.as_str()).map(String::from)
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(Some(ids))
        }
        _ => Ok(None),
    }
}

/// M2: исполнение инструмента агента (вызывается из агентного цикла / для тестов).
/// Имена mcp__<server>__<tool> маршрутизируются в подключённый MCP-сервер.
/// По пути прогоняются хуки PreToolUse (может заблокировать) и PostToolUse
/// (additionalContext дописывается к результату).
#[tauri::command]
async fn run_tool(
    app: tauri::AppHandle,
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
    browser_registry: tauri::State<'_, browser::BrowserRegistry>,
    name: String,
    arguments: String,
) -> Result<String, String> {
    use tauri::Manager;

    let args: serde_json::Value =
        serde_json::from_str(&arguments).map_err(|e| format!("invalid arguments JSON: {e}"))?;

    // Хуки PreToolUse: любой с decision=block (или ненулевым exit) блокирует вызов
    {
        let cfg_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?;
        let payload = serde_json::json!({
            "event": "PreToolUse",
            "tool": name,
            "arguments": args,
        });
        let tool_name = name.clone();
        for out in tauri::async_runtime::spawn_blocking(move || {
            hooks::run_event(&cfg_dir, "PreToolUse", &tool_name, &payload)
        })
        .await
        .map_err(|e| format!("hook task failed: {e}"))?
        {
            if out.blocked {
                return Err(format!(
                    "blocked by hook {}: {}",
                    out.id,
                    if out.reason.is_empty() { "no reason given" } else { &out.reason }
                ));
            }
        }
    }

    // Серверный слой прав: бэкенд не «глухой исполнитель» — дубль фронт-логики
    // разрешений (App.tsx). Err уходит модели как обычная ошибка инструмента.
    // shell_run — без path-контроля (cwd опционален); для fs_* берём путь из args.
    let perm_path = if name.starts_with("fs_") {
        args.get("path").and_then(|v| v.as_str())
    } else {
        None
    };
    perm::decide(&perm::current(), &name, perm_path)?;

    let notes = notes_dir(&app)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let result = execute_tool_inner(
        mcp_registry,
        browser_registry,
        name.clone(),
        args.clone(),
        notes,
        data_dir,
    )
    .await?;

    // Хуки PostToolUse: additionalContext дописывается к результату
    {
        let cfg_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?;
        let payload = serde_json::json!({
            "event": "PostToolUse",
            "tool": name,
            "arguments": args,
            "result": result,
        });
        let outs = tauri::async_runtime::spawn_blocking(move || {
            hooks::run_event(&cfg_dir, "PostToolUse", &name, &payload)
        })
        .await
        .map_err(|e| format!("hook task failed: {e}"))?;
        let extra: Vec<String> = outs
            .iter()
            .filter(|o| !o.additional_context.is_empty())
            .map(|o| o.additional_context.clone())
            .collect();
        if extra.is_empty() {
            Ok(result)
        } else {
            Ok(format!("{result}\n\n[hook context]\n{}", extra.join("\n")))
        }
    }
}

/// Собственно диспетчеризация инструмента (без хуков)
async fn execute_tool_inner(
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
    browser_registry: tauri::State<'_, browser::BrowserRegistry>,
    name: String,
    args: serde_json::Value,
    notes_dir: std::path::PathBuf,
    data_dir: std::path::PathBuf,
) -> Result<String, String> {
    let arguments = args.to_string();
    // Computer-инструменты: скриншот быстрый, мышь/клавиатура — блокирующие
    if name.starts_with("computer_") {
        if !computer::config().enabled {
            return Err("Computer Use is disabled in Settings".to_string());
        }
        return tauri::async_runtime::spawn_blocking(move || {
            computer::execute_computer_tool(&name, &arguments)
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }

    // Browser-инструменты: соединение лениво запускается, блокирующий
    // CDP-вызов — в отдельном потоке. Дублируем проверку тумблера:
    // модель могла получить схемы до выключения
    if name.starts_with("browser_") {
        if !browser::config().enabled {
            return Err("Browser Use is disabled in Settings".to_string());
        }
        if name == "browser_close" {
            browser_registry.kill_all();
            return Ok("Browser closed.".to_string());
        }
        let conn = browser_registry.get_or_launch()?;
        let args: serde_json::Value = serde_json::from_str(&arguments)
            .map_err(|e| format!("invalid arguments JSON: {e}"))?;
        return tauri::async_runtime::spawn_blocking(move || {
            browser::execute_on(&conn, &name, &args)
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }

    if let Some((server_raw, tool_raw)) = mcp::split_prefixed_name(&name) {
        let server = server_raw.to_string();
        let tool = tool_raw.to_string();
        // Соединение берём синхронно (дешёвый Arc), блокирующий вызов — в потоке
        let conn = {
            let map = mcp_registry.0.lock().map_err(|e| e.to_string())?;
            map.get(&server)
                .cloned()
                .ok_or_else(|| format!("MCP server \"{server}\" is not connected"))?
        };
        let args: serde_json::Value = serde_json::from_str(&arguments)
            .map_err(|e| format!("invalid arguments JSON: {e}"))?;
        return tauri::async_runtime::spawn_blocking(move || {
            conn.call_tool(&tool, args)
                .map_err(|e| format!("mcp {server}.{tool}: {e}"))
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }
    // Vault-инструменты (заметки): чтение, не мутируют — исполним в потоке
    if name.starts_with("vault_") {
        return tauri::async_runtime::spawn_blocking(move || {
            tools::execute_vault_tool(&notes_dir, &name, &arguments)
        })
        .await
        .map_err(|e| format!("tool task failed: {e}"))?;
    }
    // Генерация изображений: асинхронный HTTP, дубль-проверка тумблера
    if name == "image_generate" {
        let prompt = args
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or("missing required argument: prompt")?
            .to_string();
        let size = args
            .get("size")
            .and_then(|v| v.as_str())
            .map(String::from);
        return imagegen::generate(&data_dir, &prompt, size.as_deref()).await;
    }
    // Инструменты блокирующие (shell_run — до 300 сек): исполняем в
    // отдельном потоке, иначе главный поток окна замирает на весь таймаут
    tauri::async_runtime::spawn_blocking(move || tools::execute_tool(&name, &arguments))
        .await
        .map_err(|e| format!("tool task failed: {e}"))?
}

// ---------- Хуки ----------

fn hooks_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))
}

#[tauri::command(async)]
fn hooks_load(app: tauri::AppHandle) -> Result<hooks::HookFile, String> {
    Ok(hooks::load(&hooks_dir(&app)?))
}

#[tauri::command(async)]
fn hooks_save(app: tauri::AppHandle, file: hooks::HookFile) -> Result<(), String> {
    for h in &file.hooks {
        if !hooks::EVENTS.contains(&h.event.as_str()) {
            return Err(format!("unknown hook event: {}", h.event));
        }
    }
    hooks::save(&hooks_dir(&app)?, &file)
}

/// Прогнать один хук на пробном payload (кнопка «Тест» в настройках)
#[tauri::command(async)]
async fn hooks_test(
    _app: tauri::AppHandle,
    hook: hooks::Hook,
    payload: serde_json::Value,
) -> Result<hooks::HookOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut h = hook;
        h.enabled = true;
        hooks::run_event_on(&h, &payload)
    })
    .await
    .map_err(|e| format!("hook task failed: {e}"))
}

/// Событие из фронтенда: UserPromptSubmit / Stop / SessionStart.
/// Возвращает исходы всех совпавших хуков (additionalContext фронтенд
/// может подмешать в промт или показать).
#[tauri::command(async)]
async fn hooks_run_event(
    app: tauri::AppHandle,
    event: String,
    payload: serde_json::Value,
) -> Result<Vec<hooks::HookOutcome>, String> {
    let dir = hooks_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || hooks::run_event(&dir, &event, "", &payload))
        .await
        .map_err(|e| format!("hook task failed: {e}"))
}

// ---------- Пользовательские горячие клавиши (shortcuts.json) ----------

#[tauri::command(async)]
fn shortcuts_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "shortcuts.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("shortcuts file corrupted: {e}"))
}

#[tauri::command(async)]
fn shortcuts_save(app: tauri::AppHandle, binds: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "shortcuts.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&binds).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Прочитать манифест плагина (plugin.json) из папки или файла
#[tauri::command]
fn plugin_read(path: String) -> Result<serde_json::Value, String> {
    let p = std::path::PathBuf::from(&path);
    let manifest = if p.is_dir() { p.join("plugin.json") } else { p };
    let data = fs::read_to_string(&manifest)
        .map_err(|e| format!("cannot read {}: {e}", manifest.display()))?;
    serde_json::from_str(&data).map_err(|e| format!("plugin.json corrupted: {e}"))
}

/// Реестр установленных плагинов (plugins.json)
#[tauri::command(async)]
fn plugins_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "plugins.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("plugins file corrupted: {e}"))
}

#[tauri::command(async)]
fn plugins_save(app: tauri::AppHandle, file: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "plugins.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Пользовательские slash-команды (commands.json): { commands: [{name, description, template}] }
#[tauri::command(async)]
fn commands_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "commands.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("commands file corrupted: {e}"))
}

#[tauri::command(async)]
fn commands_save(app: tauri::AppHandle, file: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "commands.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Конфиг субагентов (subagents.json): { enabled, maxParallel, roles: [...] }
#[tauri::command(async)]
fn subagents_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "subagents.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("subagents file corrupted: {e}"))
}

#[tauri::command(async)]
fn subagents_save(app: tauri::AppHandle, config: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "subagents.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Цвета моделей в статистике (colors.json): { "<model>": "#rrggbb" }
#[tauri::command(async)]
fn usage_colors_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "colors.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("colors file corrupted: {e}"))
}

#[tauri::command(async)]
fn usage_colors_save(app: tauri::AppHandle, colors: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "colors.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&colors).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// M3: OpenAI-схемы инструментов для body["tools"] + инструменты подключённых
/// MCP-серверов (префикс mcp__<server>__<tool>). Фронт запрашивает на каждый
/// отправ — набор инструментов меняется при коннекте/дисконнекте серверов.
/// Текущий конфиг Browser Use (для вкладки настроек)
#[tauri::command(async)]
fn browser_get_config() -> browser::BrowserConfig {
    browser::config()
}

/// Сохранить конфиг Browser Use: в файл + в снапшот; смена пути к браузеру
/// или headless сбрасывает текущее соединение, чтобы настройки применились
#[tauri::command(async)]
fn browser_set_config(
    app: tauri::AppHandle,
    registry: tauri::State<'_, browser::BrowserRegistry>,
    config: browser::BrowserConfig,
) -> Result<(), String> {
    let old = browser::config();
    save_json_config(&app, "browser.json", &config)?;
    let exe_changed = old.executable != config.executable;
    let headless_changed = old.headless != config.headless;
    browser::set_config(config);
    if exe_changed || headless_changed {
        registry.kill_all();
    }
    Ok(())
}

#[tauri::command(async)]
fn computer_get_config() -> computer::ComputerConfig {
    computer::config()
}

#[tauri::command(async)]
fn computer_set_config(
    app: tauri::AppHandle,
    config: computer::ComputerConfig,
) -> Result<(), String> {
    save_json_config(&app, "computer.json", &config)?;
    computer::set_config(config);
    Ok(())
}

#[tauri::command(async)]
fn imagegen_get_config() -> imagegen::ImageGenConfig {
    imagegen::config()
}

#[tauri::command(async)]
fn imagegen_set_config(
    app: tauri::AppHandle,
    config: imagegen::ImageGenConfig,
) -> Result<(), String> {
    save_json_config(&app, "imagegen.json", &config)?;
    imagegen::set_config(config);
    Ok(())
}

// ---------- Свои звуки уведомлений ----------

/// Разрешённые расширения своей мелодии + MIME для data URL
fn sound_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" => Some("audio/ogg"),
        "m4a" => Some("audio/mp4"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

fn sound_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sounds");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Импорт своей мелодии: копия в appdata/sounds/custom.<ext>,
/// возвращает "имя файла|расширение" для отображения
#[tauri::command(async)]
fn sound_import(app: tauri::AppHandle, src: String) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    // Обход каталогов через «..» запрещён — путь должен указывать на файл напрямую
    if src_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("invalid source path".into());
    }
    let ext = src_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .ok_or("file has no extension")?;
    sound_mime(&ext).ok_or(format!("unsupported audio format: .{ext}"))?;
    let bytes = fs::read(&src_path).map_err(|e| e.to_string())?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("audio file is larger than 5 MB".into());
    }
    let dir = sound_path(&app)?;
    // Удаляем старую копию с другим расширением, кладём новую
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("custom.") {
            let _ = fs::remove_file(e.path());
        }
    }
    fs::write(dir.join(format!("custom.{ext}")), bytes).map_err(|e| e.to_string())?;
    let name = src_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "custom".into());
    Ok(format!("{name}|{ext}"))
}

/// Своя мелодия как data URL (для WebAudio/Audio). None — не импортирована
#[tauri::command(async)]
fn sound_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = sound_path(&app)?;
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(ext) = name.strip_prefix("custom.") else { continue };
        let Some(mime) = sound_mime(ext) else { continue };
        let bytes = fs::read(e.path()).map_err(|e| e.to_string())?;
        use base64::Engine as _;
        return Ok(Some(format!(
            "data:{mime};base64,{}",
            B64.encode(bytes)
        )));
    }
    Ok(None)
}

/// Удалить свою мелодию
#[tauri::command(async)]
fn sound_delete(app: tauri::AppHandle) -> Result<(), String> {
    let dir = sound_path(&app)?;
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("custom.") {
            let _ = fs::remove_file(e.path());
        }
    }
    Ok(())
}

// ---------- Живой просмотр браузера агента (панель справа) ----------

/// Активна ли трансляция кадров (один поток на всё приложение)
static BROWSER_VIEW_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Включить трансляцию: поток раз в 400мс снимает кадр агентовского
/// Chromium (Page.captureScreenshot) и шлёт событие browser-frame.
/// Кадры шлём только при изменении; URL — с каждым тиком.
#[tauri::command(async)]
fn browser_view_start(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    use std::time::Duration;
    use serde_json::{json, Value};
    if BROWSER_VIEW_ACTIVE.swap(true, Ordering::SeqCst) {
        return Ok(()); // трансляция уже идёт
    }
    std::thread::spawn(move || {
        let mut last_frame = String::new();
        while BROWSER_VIEW_ACTIVE.load(Ordering::SeqCst) {
            let conn = {
                let reg = app.state::<browser::BrowserRegistry>();
                let guard = reg.0.lock().unwrap();
                guard.clone()
            };
            let mut payload = json!({ "data": Value::Null, "url": "" });
            if let Some(conn) = conn {
                match conn.view_frame() {
                    Ok((data, url)) => {
                        if data != last_frame {
                            last_frame = data.clone();
                            payload["data"] = json!(data);
                        }
                        payload["url"] = json!(url);
                    }
                    Err(_) => last_frame.clear(),
                }
            } else {
                last_frame.clear();
            }
            // При ошибке кадра — пауза подольше: страница занята/браузер не запущен
            let pause = if payload["data"].is_null() { 1200 } else { 400 };
            let _ = app.emit("browser-frame", payload);
            std::thread::sleep(Duration::from_millis(pause));
        }
    });
    Ok(())
}

#[tauri::command(async)]
fn browser_view_stop() {
    BROWSER_VIEW_ACTIVE.store(false, Ordering::SeqCst);
}

/// Размер вьюпорта агентовского браузера (null/null — вернуть как есть)
#[tauri::command(async)]
fn browser_view_size(app: tauri::AppHandle, w: Option<i64>, h: Option<i64>) -> Result<(), String> {
    use tauri::Manager;
    let conn = {
        let reg = app.state::<browser::BrowserRegistry>();
        let guard = reg.0.lock().unwrap();
        guard.clone()
    };
    if let Some(conn) = conn {
        conn.set_viewport(w, h)?;
    }
    Ok(())
}

// ---------- Не давать ПК уснуть, пока работает задача (Automations) ----------

#[tauri::command(async)]
fn keep_awake(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        // ES_CONTINUOUS привязан к конкретному потоку: вызов в одноразовом
        // std::thread::spawn сбрасывается сразу после его завершения (поток
        // умирает) — фича была no-op. Поэтому держим ОДИН постоянный воркер
        // на весь процесс, а keep_awake лишь шлёт значение в его канал.
        static TX: std::sync::OnceLock<mpsc::Sender<bool>> = std::sync::OnceLock::new();
        let tx = TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<bool>();
            std::thread::spawn(move || keep_awake_worker(rx));
            tx
        });
        tx.send(enable)
            .map_err(|_| "keep-awake worker gone".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = enable; // вне Windows — no-op
        Ok(())
    }
}

/// Постоянный воркер keep_awake: держит ES_CONTINUOUS в своём потоке, чтобы
/// флаг не сбрасывался. enable → держит систему и экран, disable → снимает.
#[cfg(windows)]
fn keep_awake_worker(rx: mpsc::Receiver<bool>) {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(esflags: u32) -> u32;
    }
    while let Ok(enable) = rx.recv() {
        let flags = if enable {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        // Результат игнорируем: канал односторонний, вернуть ошибку некуда.
        unsafe { SetThreadExecutionState(flags) };
    }
}

fn save_json_config<T: serde::Serialize>(
    app: &tauri::AppHandle,
    file: &str,
    value: &T,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(dir.join(file), json).map_err(|e| e.to_string())
}

// ---------- Серверный слой прав (perm.rs) ----------

/// Фронт синхронизирует режим разрешений и корни проекта перед первым
/// инструментом прогона (fire-and-forget из handleSend, App.tsx)
#[tauri::command(async)]
fn perm_set(mode: String, roots: Vec<String>) -> Result<(), String> {
    let mode = match mode.as_str() {
        "plan" => perm::PermMode::Plan,
        "ask" => perm::PermMode::Ask,
        "edit" => perm::PermMode::Edit,
        "full" => perm::PermMode::Full,
        other => return Err(format!("unknown permission mode: {other}")),
    };
    perm::set(perm::PermState { mode, roots });
    Ok(())
}

/// Текущее состояние прав: { mode: "ask"…, roots: [...] } — для отладки
/// и восстановления состояния на фронте
#[tauri::command(async)]
fn perm_get() -> serde_json::Value {
    let state = perm::current();
    serde_json::json!({ "mode": state.mode, "roots": state.roots })
}

#[tauri::command(async)]
fn get_tool_schemas(
    mcp_registry: tauri::State<'_, mcp::McpRegistry>,
) -> serde_json::Value {
    let builtin = tools::tool_schemas();
    let vault = tools::vault_tool_schemas();
    let mut merged = mcp_registry.tool_schemas_merged(builtin);
    if let Some(arr) = merged.as_array_mut() {
        if let Some(extra) = vault.as_array() {
            arr.extend(extra.iter().cloned());
        }
        if browser::config().enabled {
            let extra = browser::browser_tool_schemas()
                .as_array()
                .cloned()
                .unwrap_or_default();
            arr.extend(extra);
        }
        if computer::config().enabled {
            let extra = computer::computer_tool_schemas()
                .as_array()
                .cloned()
                .unwrap_or_default();
            arr.extend(extra);
        }
        // Генерация изображений: только при включённом тумблере
        if imagegen::config().enabled {
            arr.push(imagegen::imagegen_tool_schema());
        }
        // Субагенты: исполнение на фронтенде (вложенный цикл в App), но
        // схема должна быть в списке, чтобы главный агент мог вызвать
        arr.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "subagent_run",
                "description": "Run a subagent: an isolated agent with its own role, context and tool allowlist. It returns a final report. Use for research, coding subtasks, review (critic) or repo navigation. Depth is 1 — a subagent cannot spawn subagents.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "role": {
                            "type": "string",
                            "description": "Subagent role id: researcher (web/read-only), coder (fs/shell), critic (review, no tools), librarian (repo navigation) — or any custom role id configured in Settings → Subagents / plugins"
                        },
                        "task": {
                            "type": "string",
                            "description": "Self-contained brief for the subagent: what to do, where to look, what to return. It does NOT see this conversation."
                        }
                    },
                    "required": ["role", "task"]
                }
            }
        }));
        // План задач: исполнение целиком на фронтенде (App парсит tasks и
        // обновляет виджет Progress в чате), Rust нужен только как схема
        arr.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "plan_update",
                "description": "Create or update the task plan shown to the user. Call it when starting a multi-step task and after each task status change. Tasks: [{title, status}]. status: pending | in_progress | done",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tasks": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": { "type": "string" },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "done"]
                                    }
                                },
                                "required": ["title", "status"]
                            }
                        }
                    },
                    "required": ["tasks"]
                }
            }
        }));
    }
    merged
}

/// История задач: таскаем целиком как JSON-строку, чтобы не дублировать типы.
#[tauri::command(async)]
fn load_sessions(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = config_file(&app, "sessions.json")?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn save_sessions(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let path = config_file(&app, "sessions.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_lines(acc: &mut SseAccumulator, lines: &[&str]) -> Vec<FeedEvent> {
        let mut all = Vec::new();
        for l in lines {
            all.extend(acc.feed(l));
        }
        all
    }

    #[test]
    fn content_and_usage_stream() {
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"Прив"}}]}"#,
                r#"{"choices":[{"delta":{"content":"ет"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}"#,
            ],
        );
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::Content { delta } => Some(delta.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Привет");
        assert!(events.iter().any(|e| matches!(
            e,
            FeedEvent::Usage { prompt: 10, completion: 3, total: 13 }
        )));
    }

    #[test]
    fn tool_call_arguments_glued_across_fragments() {
        // Классика: аргументы JSON приходят кусочками строки
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"fs_read","arguments":"{\"pa"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\": \"/tmp/x.py\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        let finished = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .expect("tool calls must finish");
        assert_eq!(finished.len(), 1);
        assert_eq!(finished[0].id, "call_abc");
        assert_eq!(finished[0].name, "fs_read");
        // Склеенная строка — валидный JSON
        let parsed: serde_json::Value = serde_json::from_str(&finished[0].arguments).expect("arguments must be valid JSON after gluing");
        assert_eq!(parsed["path"], "/tmp/x.py");
    }

    #[test]
    fn parallel_tool_calls_interleaved_by_index() {
        // Провайдеры шлют параллельные вызовы вперемешку
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"fs_write","arguments":"{\"path\":"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"fs_read","arguments":"{\"path\":\"a.txt\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"data.txt\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        let finished = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .expect("tool calls must finish");
        assert_eq!(finished.len(), 2);
        assert_eq!(finished[0].name, "fs_read"); // index 0
        let args_a: serde_json::Value = serde_json::from_str(&finished[0].arguments).unwrap();
        assert_eq!(args_a["path"], "a.txt");
        assert_eq!(finished[1].name, "fs_write"); // index 1
        let args_b: serde_json::Value = serde_json::from_str(&finished[1].arguments).unwrap();
        assert_eq!(args_b["path"], "data.txt");
    }

    #[test]
    fn empty_arguments_become_empty_object() {
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"shell_run","arguments":""}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        let finished = events
            .iter()
            .filter_map(|e| match e {
                FeedEvent::ToolCallsFinished { calls } => Some(calls.clone()),
                _ => None,
            })
            .next()
            .unwrap();
        assert_eq!(finished[0].arguments, "{}");
    }

    #[test]
    fn garbage_chunks_are_ignored() {
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                "not json at all",
                r#"{"choices":[{"delta":{"content":"ok"}}]}"#,
            ],
        );
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn no_tool_call_event_without_tool_calls() {
        let mut acc = SseAccumulator::default();
        let events = feed_lines(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"hi"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            ],
        );
        assert!(!events
            .iter()
            .any(|e| matches!(e, FeedEvent::ToolCallsFinished { .. })));
    }

    #[test]
    fn truncate_at_char_boundary_keeps_utf8() {
        // 3-байтовые символы: байтовый лимит попадает в середину символа.
        let mut s = "\u{65e5}".repeat(100); // 300 байт
        truncate_at_char_boundary(&mut s, 101); // 101 % 3 == 2 — внутри символа
        assert!(s.len() <= 101);
        assert!(s.is_char_boundary(s.len()));
        assert!(s.chars().all(|c| c == '\u{65e5}'));

        let mut short = "abc".to_string();
        truncate_at_char_boundary(&mut short, 100); // короче лимита — не трогаем
        assert_eq!(short, "abc");
    }

    #[test]
    fn take_complete_lines_preserves_multibyte_across_chunks() {
        // Строка 'data: {"delta":"при"}\n'. Разрезаем её побайтово ВНУТРИ
        // многобайтного символа 'р' (2 байта) — первый кусок заканчивается
        // половиной символа, второй доводит строку до конца. Раньше каждый
        // чанк конвертировался отдельно и 'р' превращался в U+FFFD.
        let full = "data: {\"delta\":\"при\"}\n".as_bytes().to_vec();
        // 'при' начинается с байта 16; 'п' = 2 байта (16..18), 'р' = 2 байта
        // (18..20). Режем после первого байта 'р' — внутри многобайтного символа.
        let split = 19;
        let mut buf: Vec<u8> = full[..split].to_vec();
        let first = take_complete_lines(&mut buf);
        assert!(first.is_empty(), "до '\n' строк быть не должно: {first:?}");

        buf.extend_from_slice(&full[split..]);
        let second = take_complete_lines(&mut buf);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].trim(), "data: {\"delta\":\"при\"}");
        assert!(
            !second[0].contains('\u{FFFD}'),
            "не должно быть U+FFFD: {:?}",
            second[0]
        );
    }
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

    #[test]
    fn title_from_first_heading() {
        assert_eq!(
            note_title_from_content("n.md", "# Мой промт\n\nтекст"),
            "Мой промт"
        );
        assert_eq!(note_title_from_content("заметка.md", "без заголовка"), "заметка");
    }
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
