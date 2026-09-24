//! Настройки, профили API, проекты, команды хранилища ключей (vault),
//! экспорт/импорт конфигурации одним файлом.

use crate::crypto;
use serde::{Deserialize, Serialize};
use std::fs;
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
pub fn load_profiles(app: tauri::AppHandle) -> Result<ProfilesStore, String> {
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
            p.api_key = decrypt_stored_key(&p.api_key)?;
        }
    }
    Ok(store)
}

#[tauri::command(async)]
pub fn save_profiles(
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
pub fn crypto_meta_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    config_file(app, "crypto.json")
}

/// (соль, маркер, kdf)
type CryptoMeta = (Vec<u8>, String, String);

pub fn crypto_read_meta(app: &tauri::AppHandle) -> Result<Option<CryptoMeta>, String> {
    let path = crypto_meta_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let salt = v
        .get("salt")
        .and_then(|x| x.as_str())
        .and_then(crypto::hex_decode)
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

pub fn crypto_write_meta(
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
pub fn crypto_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
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

/// Первое создание мастер-пароля: соль + маркер, ключ в память (Argon2id).
/// Вывод ключа — тяжёлый (Argon2id, 19 MiB) — исполняется вне потока UI.
#[tauri::command(async)]
pub async fn crypto_setup(app: tauri::AppHandle, password: String) -> Result<(), String> {
    if password.len() < 8 {
        return Err("password too short (minimum 8 characters)".into());
    }
    let (salt, key, check) = tauri::async_runtime::spawn_blocking(move || {
        let salt = crypto::new_salt();
        let key = crypto::derive_key_argon2(&password, &salt);
        let check = crypto::make_check(&key)?;
        Ok::<_, String>((salt, key, check))
    })
    .await
    .map_err(|e| e.to_string())??;
    crypto::set_key(key);
    crypto_write_meta(&app, &salt, &check, "argon2id")
}

/// Разблокировка существующим паролем. Легаси-хранилище (PBKDF2) после
/// успешной проверки тихо мигрирует на Argon2id: ключ перегенерируется,
/// все зашифрованные поля перезаписываются новым ключом.
#[tauri::command(async)]
pub async fn crypto_unlock(app: tauri::AppHandle, password: String) -> Result<(), String> {
    let (salt, check, kdf) =
        crypto_read_meta(&app)?.ok_or("encryption is not set up")?;
    let is_argon2 = kdf == "argon2id";
    // Пароль и app нужны в обоих spawn_blocking (легаси-миграция второй)
    let password2 = password.clone();
    let app2 = app.clone();
    // Argon2id/PBKDF2 в spawn_blocking: сотни миллисекций CPU не фризят UI
    let verified = tauri::async_runtime::spawn_blocking(move || {
        let key = if is_argon2 {
            crypto::derive_key_argon2(&password, &salt)
        } else {
            crypto::derive_key(&password, &salt)
        };
        if crypto::verify_check(&key, &check) {
            Some(key)
        } else {
            None
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(key) = verified else {
        return Err("wrong password".into());
    };
    if is_argon2 {
        crypto::set_key(key);
        return Ok(());
    }
    // --- Легаси-миграция PBKDF2 → Argon2id ---
    let migrated = tauri::async_runtime::spawn_blocking(move || {
        let new_salt = crypto::new_salt();
        let new_key = crypto::derive_key_argon2(&password2, &new_salt);
        rekey_all(&app2, &key, &new_key)?;
        let new_check = crypto::make_check(&new_key)?;
        Ok::<_, String>((new_salt, new_key, new_check))
    })
    .await
    .map_err(|e| e.to_string())??;
    crypto::set_key(migrated.1);
    crypto_write_meta(&app, &migrated.0, &migrated.2, "argon2id")
}

/// Перешифровать все зашифрованные поля (settings.json, profiles.json)
/// со старого ключа на новый. Поля, не расшифровавшиеся старым ключом,
/// оставляются как есть (потеря уже произошла ранее).
pub(crate) fn rekey_all(app: &tauri::AppHandle, old_key: &[u8], new_key: &[u8]) -> Result<(), String> {
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
pub fn crypto_reset(app: tauri::AppHandle, confirm: String) -> Result<(), String> {
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

// ---------- Экспорт/импорт настроек одним файлом ----------

/// Конфиг-файлы, входящие в экспорт. crypto.json включён: без той же соли
/// и check зашифрованные ключи не оживут на другой машине.
const EXPORT_FILES: &[&str] = &[
    "settings.json",
    "profiles.json",
    "projects.json",
    "sessions.json",
    "commands.json",
    "plugins.json",
    "shortcuts.json",
    "subagents.json",
    "colors.json",
    "hooks.json",
    "mcp.json",
    "imagegen.json",
    "browser.json",
    "computer.json",
    "crypto.json",
];

/// Собрать содержимое всех конфиг-файлов (отсутствующие пропускаются)
#[tauri::command(async)]
pub fn settings_read_all(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut files = serde_json::Map::new();
    for name in EXPORT_FILES {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        if let Ok(data) = fs::read_to_string(&path) {
            // битый файл не тащим
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                files.insert((*name).to_string(), v);
            }
        }
    }
    Ok(serde_json::Value::Object(files))
}

/// Записать набор конфиг-файлов (импорт). Имена жёстко из whitelist.
/// hooks.json/mcp.json исполняемы по своей природе (команды хуков через
/// cmd /C, запуск серверов) — пишутся только при явном подтверждении с
/// фронтенда, иначе импорт «поделенного конфига» был бы RCE.
#[tauri::command(async)]
pub fn settings_write_all(
    app: tauri::AppHandle,
    files: std::collections::HashMap<String, serde_json::Value>,
    allow_executable_configs: bool,
) -> Result<usize, String> {
    use tauri::Manager;
    const EXECUTABLE_CONFIGS: &[&str] = &["hooks.json", "mcp.json"];
    if !allow_executable_configs
        && EXECUTABLE_CONFIGS.iter().any(|name| files.contains_key(*name))
    {
        return Err(
            "import contains executable configs (hooks/mcp) that require explicit user confirmation"
                .to_string(),
        );
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut written = 0usize;
    for name in EXPORT_FILES {
        let Some(value) = files.get(*name) else {
            continue;
        };
        let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        fs::write(dir.join(name), json).map_err(|e| e.to_string())?;
        written += 1;
    }
    Ok(written)
}
/// Отсечение чувствительных системных локаций для команд, получающих
/// произвольный путь с фронта (экспорт/импорт настроек, плагины, звуки):
/// там вебвью нечего ни читать, ни перезаписывать. Пользовательские папки
/// (включая репозитории на любом диске) не ограничиваются.
pub(crate) fn rejects_sensitive_path(path: &str) -> Result<(), String> {
    let norm = path.to_lowercase().replace('/', "\\");
    const BLOCKED: &[&str] = &[
        "\\windows\\",
        "\\program files",
        "\\programdata\\microsoft\\",
        "\\microsoft\\windows\\start menu\\",
    ];
    if BLOCKED.iter().any(|b| norm.contains(b)) {
        return Err("path points to a protected system location".into());
    }
    Ok(())
}

/// Сохранить экспорт-файл (содержимое собрано на фронте)
#[tauri::command(async)]
pub fn settings_export_write(path: String, content: String) -> Result<(), String> {
    if !path.ends_with(".json") {
        return Err("export file must be .json".into());
    }
    rejects_sensitive_path(&path)?;
    // Проверка, что это валидный JSON — защита от мусора
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("export content is not valid JSON: {e}"))?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Прочитать импорт-файл
#[tauri::command(async)]
pub fn settings_import_read(path: String) -> Result<serde_json::Value, String> {
    rejects_sensitive_path(&path)?;
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("import file corrupted: {e}"))
}

/// Тумблер шифрования: перезаписывает settings.json и profiles.json,
/// шифруя (или расшифровывая) все API-ключи на месте.
/// Включение требует разблокированного хранилища (пароль уже введён).
#[tauri::command(async)]
pub fn set_key_encryption(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
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
                // FIX: раньше decrypt → None (заблокированное хранилище /
                // сменившийся пароль) тихо писал на диск ПУСТОЙ ключ — потеря.
                // Теперь команда падает, файл остаётся нетронутым.
                crypto::decrypt(&key).ok_or(
                    "stored API key cannot be decrypted (vault is locked or password changed) — unlock the vault first",
                )?
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
                        // FIX: то же, что и для settings.json — без тихой потери ключа
                        crypto::decrypt(&key).ok_or(
                            "stored API key cannot be decrypted (vault is locked or password changed) — unlock the vault first",
                        )?
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
pub fn load_projects(app: tauri::AppHandle) -> Result<Vec<ProjectRec>, String> {
    let path = config_file(&app, "projects.json")?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("projects file corrupted: {e}"))
}

#[tauri::command(async)]
pub fn save_projects(app: tauri::AppHandle, projects: Vec<ProjectRec>) -> Result<(), String> {
    let path = config_file(&app, "projects.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}
pub(crate) fn config_file(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))?;
    Ok(dir.join(name))
}

/// Расшифровка ключа при загрузке конфигов. Хранилище ещё заблокировано —
/// отдаём пустую строку (после разблокировки фронт перечитает конфиги).
/// Хранилище разблокировано, а ключ не расшифровался — мастер-пароль сменили
/// или сбросили: возвращаем ошибку, чтобы фронт показал её, а не молча слал
/// запросы без ключа с загадочным 401 от провайдера.
pub fn decrypt_stored_key(stored: &str) -> Result<String, String> {
    match crypto::decrypt(stored) {
        Some(plain) => Ok(plain),
        None if crypto::has_key() => Err(
            "stored API key cannot be decrypted (master password changed or reset) — re-enter the key"
                .into(),
        ),
        None => Ok(String::new()),
    }
}

#[tauri::command(async)]
pub fn load_settings(app: tauri::AppHandle) -> Result<ApiSettings, String> {
    let path = config_file(&app, "settings.json")?;
    if !path.exists() {
        return Ok(ApiSettings::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut s: ApiSettings =
        serde_json::from_str(&data).map_err(|e| format!("settings file corrupted: {e}"))?;
    // Прозрачно расшифровываем ключ, если он зашифрован
    if crypto::is_encrypted(&s.api_key) {
        s.api_key = decrypt_stored_key(&s.api_key)?;
    }
    Ok(s)
}

#[tauri::command(async)]
pub fn save_settings(app: tauri::AppHandle, settings: ApiSettings) -> Result<(), String> {
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
pub(crate) fn save_json_config<T: serde::Serialize>(
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