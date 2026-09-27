//! Настройки, профили API, проекты, команды хранилища ключей (vault),
//! экспорт/импорт конфигурации одним файлом.

use crate::crypto;
use serde::{Deserialize, Serialize};
use std::fs;
use zeroize::Zeroizing;
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
    /// Fallback-модель: второй прогон при исчерпании ретраев на 429/5xx.
    /// None/пусто — автопереключение выключено
    #[serde(default)]
    pub fallback_model: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub provider: String,
    /// Fallback-модель профиля (подставляется вместе с остальной связкой)
    #[serde(default)]
    pub fallback_model: Option<String>,
    /// Оформление, сохранённое вместе с профилем (кастомизация «тема из
    /// профиля»): pass-through serde::Value — структура владеет только
    /// фронтом, Rust не знает её полей
    #[serde(default)]
    pub appearance: Option<serde_json::Value>,
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
                    // Миграция идемпотентна — провал повторится на следующем
                    // старте, но молча терять фиксацию профилей на диске нельзя
                    if let Err(e) = save_profiles(
                        app.clone(),
                        store.profiles.clone(),
                        store.active.clone(),
                        false,
                    ) {
                        eprintln!(
                            "load_profiles: migration write failed (retries on next start): {e}"
                        );
                    }
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
    crate::fsutil::atomic_write(&path, json.as_bytes())
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
    crate::fsutil::atomic_write(&path, json.as_bytes())
}

/// Состояние шифрования для окна входа на старте.
/// async + spawn_blocking: sync-команда в Tauri 2 исполнялась на главном
/// потоке, а читает settings.json с диска (медленный диск = фриз UI)
#[tauri::command(async)]
pub async fn crypto_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("crypto status task failed: {e}"))?
}

/// Первое создание мастер-пароля: соль + маркер, ключ в память (Argon2id).
/// Вывод ключа — тяжёлый (Argon2id, 19 MiB) — исполняется вне потока UI.
#[tauri::command(async)]
pub async fn crypto_setup(app: tauri::AppHandle, password: String) -> Result<(), String> {
    if password.len() < 8 {
        return Err("password too short (minimum 8 characters)".into());
    }
    // Zeroizing: мастер-пароль затирается при выходе из команды,
    // а не остаётся в освободившейся heap-памяти
    let password = Zeroizing::new(password);
    let (salt, key, check) = tauri::async_runtime::spawn_blocking(move || {
        let salt = crypto::new_salt();
        let key = crypto::derive_key_argon2(&password, &salt)?;
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
    // Пароль и app нужны в обоих spawn_blocking (легаси-миграция второй).
    // Обе копии — Zeroizing: обычный String-клон оставлял пароль в heap
    let password = Zeroizing::new(password);
    let password2 = Zeroizing::new((*password).clone());
    let app2 = app.clone();
    // Argon2id/PBKDF2 в spawn_blocking: сотни миллисекций CPU не фризят UI
    let verified = tauri::async_runtime::spawn_blocking(move || {
        let key = if is_argon2 {
            crypto::derive_key_argon2(&password, &salt)?
        } else {
            crypto::derive_key(&password, &salt)
        };
        Ok::<_, String>(if crypto::verify_check(&key, &check) {
            Some(key)
        } else {
            None
        })
    })
    .await
    .map_err(|e| e.to_string())??;
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
        let new_key = crypto::derive_key_argon2(&password2, &new_salt)?;
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
/// со старого ключа на новый.
///
/// Транзакция: оба файла готовятся в памяти; поле, не расшифровавшееся
/// старым ключом, АБОРТИТ миграцию целиком — раньше такие поля оставлялись
/// под старым шифрованием при meta=argon2id и безвозвратно терялись, а
/// сбой между перезаписью settings.json и profiles.json оставлял
/// настройки зашифрованными новым ключом при meta, всё ещё объявляющей
/// pbkdf2 со старой солью (потеря всех ключей на следующем анлоке).
/// Оригиналы сохраняются в *.bak до перезаписи; сбой любой записи
/// откатывает уже перезаписанные файлы.
pub(crate) fn rekey_all(
    app: &tauri::AppHandle,
    old_key: &[u8],
    new_key: &[u8],
) -> Result<(), String> {
    let mut staged: Vec<(std::path::PathBuf, Vec<u8>)> = Vec::new();
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
        let mut lost = 0usize;
        for f in fields {
            if let Some(stored) = f.as_str() {
                if !crypto::is_encrypted(stored) {
                    continue;
                }
                match crypto::decrypt_with(old_key, stored) {
                    Some(plain) => {
                        *f = serde_json::Value::String(crypto::encrypt_with(new_key, &plain)?)
                    }
                    None => lost += 1,
                }
            }
        }
        if lost > 0 {
            return Err(format!(
                "migration aborted: {lost} stored field(s) cannot be decrypted with the current password — vault is already inconsistent, nothing was written"
            ));
        }
        let bytes = serde_json::to_string_pretty(&v)
            .map_err(|e| e.to_string())?
            .into_bytes();
        staged.push((path, bytes));
    }
    // Фаза записи: .bak → swap; сбой откатывает уже перезаписанные файлы
    let mut done: Vec<std::path::PathBuf> = Vec::new();
    for (path, bytes) in &staged {
        let bak = path.with_extension("json.bak");
        if fs::copy(path, &bak).is_err() {
            restore_rekey_backups(&done);
            return Err(format!("cannot back up {} — migration aborted", path.display()));
        }
        match crate::fsutil::atomic_write(path, bytes) {
            Ok(()) => done.push(path.clone()),
            Err(e) => {
                restore_rekey_backups(&done);
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Откат rekey_all: вернуть содержимое из *.bak (если бэкап есть)
fn restore_rekey_backups(paths: &[std::path::PathBuf]) {
    for path in paths {
        let bak = path.with_extension("json.bak");
        if bak.exists() {
            let _ = fs::copy(&bak, path);
        }
    }
}

/// Забыли пароль: полный сброс шифрования (зашифрованные ключи утеряны).
/// Разрушающая операция — требует явного подтверждения confirm="RESET".
/// async + spawn_blocking: файловый IO больше не на главном потоке
#[tauri::command(async)]
pub async fn crypto_reset(app: tauri::AppHandle, confirm: String) -> Result<(), String> {
    if confirm != "RESET" {
        return Err("confirmation required: pass confirm=\"RESET\" to wipe stored keys".into());
    }
    crypto::clear_key();
    tauri::async_runtime::spawn_blocking(move || {
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
            let mut v: serde_json::Value =
                serde_json::from_str(&data).unwrap_or(serde_json::json!({}));
            if path.ends_with("settings.json") {
                v["api_key"] = serde_json::Value::String(String::new());
                v["encrypt_keys"] = serde_json::Value::Bool(false);
            } else if let Some(arr) = v.get_mut("profiles").and_then(|x| x.as_array_mut()) {
                for p in arr {
                    p["api_key"] = serde_json::Value::String(String::new());
                }
            }
            crate::fsutil::atomic_write(
                &path,
                serde_json::to_string_pretty(&v)
                    .map_err(|e| e.to_string())?
                    .as_bytes(),
            )?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("crypto reset task failed: {e}"))?
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

/// Собрать содержимое всех конфиг-файлов (отсутствующие пропускаются).
/// API-ключи по умолчанию маскируются: файлом настроек можно делиться,
/// не отдавая ключи провайдеров; include_secrets=true — осознанный экспорт
/// для переноса на другую машину.
#[tauri::command(async)]
pub fn settings_read_all(
    app: tauri::AppHandle,
    include_secrets: Option<bool>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let include_secrets = include_secrets.unwrap_or(false);
    let mut files = serde_json::Map::new();
    for name in EXPORT_FILES {
        // crypto.json (соль KDF + check-маркер) — материал для офлайн-перебора
        // мастер-пароля: в «поделенный» экспорт без секретов не попадает,
        // машино-перенос — только осознанный include_secrets=true
        if *name == "crypto.json" && !include_secrets {
            continue;
        }
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        if let Ok(data) = fs::read_to_string(&path) {
            // битый файл не тащим
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&data) {
                if !include_secrets {
                    mask_secrets(name, &mut v);
                }
                files.insert((*name).to_string(), v);
            }
        }
    }
    Ok(serde_json::Value::Object(files))
}

/// Маскирование API-ключей в экспорте (пустая строка: обратный импорт
/// даёт рабочие, но пустые поля — без «мусорных» полуключей)
fn mask_secrets(file: &str, v: &mut serde_json::Value) {
    let blank = || serde_json::Value::String(String::new());
    match file {
        "settings.json" => {
            if let Some(k) = v.get_mut("api_key") {
                *k = blank();
            }
        }
        "profiles.json" => {
            if let Some(arr) = v.get_mut("profiles").and_then(|x| x.as_array_mut()) {
                for p in arr {
                    if let Some(k) = p.get_mut("api_key") {
                        *k = blank();
                    }
                }
            }
        }
        // Ключ генерации картинок живёт в imagegen.json (зашифрованным
        // enc:v1:…) — без ветки он уходил в «поделенный» экспорт как есть
        "imagegen.json" => {
            if let Some(k) = v.get_mut("api_key") {
                *k = blank();
            }
        }
        _ => {}
    }
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
        crate::fsutil::atomic_write(
            &dir.join(name),
            serde_json::to_string_pretty(value)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )?;
        written += 1;
    }
    Ok(written)
}
/// Отсечение чувствительных системных локаций для команд, получающих
/// произвольный путь с фронта (экспорт/импорт настроек, плагины, звуки):
/// там вебвью нечего ни читать, ни перезаписывать. Пользовательские папки
/// (включая репозитории на любом диске) не ограничиваются.
///
/// Сравнение по компонентам пути, а не подстрокой: `contains` давал и
/// ложные срабатывания (репозиторий `C:\repo\windows\`), и обходы —
/// 8.3-имена (`PROGRA~1`), хвостовая точка/пробел (`C:\Windows.\`, Win32
/// нормализует), подъём `..`. На Windows блокируются системные топ-уровневые
/// каталоги диска, на Unix — системные префиксы и ~/.ssh.
pub(crate) fn rejects_sensitive_path(path: &str) -> Result<(), String> {
    // Хвостовые точки/пробелы/разделители Win32 отбрасывает при нормализации
    let trimmed = path.trim_end_matches(['.', ' ', '\\', '/']);
    #[cfg(windows)]
    {
        let norm = trimmed.to_lowercase().replace('/', "\\");
        let is_unc = norm.starts_with("\\\\");
        // Вербатим-префиксы (`\\?\`, `\\?\UNC\`) Win32 пишет БЕЗ нормализации,
        // а после split «c:» уезжал в comps[1] мимо блок-листа — срезаем
        let stripped = strip_verbatim(&norm);
        // Компонент «.» исчезает при нормализации Win32 — иначе C:\.\Windows\x
        // прятал «windows» за мимо-компонентом
        let comps: Vec<&str> = stripped
            .split('\\')
            .filter(|c| !c.is_empty() && *c != ".")
            .collect();
        // `..` запрещаем целиком: легитимному экспорту подъём не нужен,
        // а он уводит проверку топ-уровня мимо целевого каталога
        if comps.contains(&"..") {
            return Err("path must not contain '..'".into());
        }
        // comps[0] обязан быть диском («c:») или, для UNC, хостом; «?», «??»,
        // NT-префиксы, относительные пути и голый диск («C:» — резолвится
        // в cwd диска) — fail closed: гардал не обязан разбирать экзотику,
        // он обязан её не пропускать
        let drive_shape = comps.first().is_some_and(|c| {
            let b = c.as_bytes();
            b.len() == 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
        });
        if !is_unc && (!drive_shape || comps.len() < 2) {
            return Err("path must be an absolute drive-letter path".into());
        }
        // UNC-экзотика, оставляющая диск в позиции шары (`\\.\C:\...`,
        // `\\\?\C:\...`), — тоже отказ
        if is_unc
            && (comps.len() < 2 || {
                let s = comps[1].as_bytes();
                s.len() == 2 && s[1] == b':'
            })
        {
            return Err("path points to an unsupported location".into());
        }
        // comps[1] — топ-каталог (для UNC — шара)
        let top = short83(comps.get(1).copied().unwrap_or(""));
        // UNC: скрытые (админские) шары все кончаются на «$» — `c$`, `admin$`,
        // `ipc$` — и открывают системные тома мимо блок-листа топ-каталогов.
        // Легитимному экспорту скрытая шара не нужна: fail closed
        if is_unc && top.ends_with('$') {
            return Err("path points to a protected system location".into());
        }
        // "progra" ловит 8.3-алиасы Program Files (PROGRA~1/PROGRA~2):
        // короткое имя генерируется на томе, длинное по нему не восстановить
        if matches!(
            top,
            "windows" | "program files" | "program files (x86)" | "progra" | "programdata"
        ) {
            return Err("path points to a protected system location".into());
        }
        // ProgramData\Microsoft — глубже топ-уровня
        if top == "programdata"
            && comps
                .get(2)
                .map(|c| short83(c) == "microsoft")
                .unwrap_or(false)
        {
            return Err("path points to a protected system location".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let norm = trimmed.replace('\\', "/");
        let comps: Vec<&str> = norm.split('/').filter(|c| !c.is_empty()).collect();
        if comps
            .first()
            .is_some_and(|c| matches!(*c, "etc" | "proc" | "sys" | "dev" | "boot" | "root"))
        {
            return Err("path points to a protected system location".into());
        }
        if comps.iter().any(|c| *c == ".ssh") {
            return Err("path points to a protected location (SSH keys)".into());
        }
        Ok(())
    }
}

/// 8.3-короткое имя → база: "progra~1" → "progra" (хвост ~N — только цифры)
#[cfg(windows)]
fn short83(comp: &str) -> &str {
    match comp.split_once('~') {
        Some((base, tail)) if !base.is_empty() && tail.chars().all(|d| d.is_ascii_digit()) => base,
        _ => comp,
    }
}

/// Срез вербатим-префиксов: `\\?\C:\...` → `C:\...`, `\\?\UNC\srv\share` →
/// `srv\share`. fs::canonicalize на Windows возвращает пути С префиксом,
/// а сырые пути с префиксом Win32 пишет без нормализации — валидировать и
/// сравнивать их можно только после среза.
#[cfg(windows)]
fn strip_verbatim(p: &str) -> &str {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return rest;
    }
    p.strip_prefix(r"\\?\").unwrap_or(p)
}

/// Нормализация для сравнения путей: нижний регистр и срез вербатим-префикса
/// (см. strip_verbatim) — только Windows-семантика, на Unix ФС регистро- и
/// слэш-чувствительна
#[cfg(windows)]
fn norm_path(p: &std::path::Path) -> String {
    strip_verbatim(&p.to_string_lossy()).to_lowercase()
}
#[cfg(not(windows))]
fn norm_path(p: &std::path::Path) -> String {
    p.to_string_lossy().to_string()
}

/// starts_with с границей каталога: голый префикс «com.haloui.app» матчит
/// сиблинга «com.haloui.app-backup» — сравниваем только целые компоненты
fn starts_dir(path_n: &str, dir_n: &str) -> bool {
    path_n == dir_n || path_n.starts_with(&format!("{dir_n}{}", std::path::MAIN_SEPARATOR))
}

/// Общий гейт записи экспорт-файлов: путь не в защищённых местах и вне
/// каталога конфигов приложения (hooks.json/mcp.json исполняемы по своей
/// природе — произвольная перезапись через экспорт-команду обошла бы гейт
/// settings_write_all и дала RCE из скомпрометированного вебвью).
/// Возвращает проверенный целевой путь.
fn ensure_export_target(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    rejects_sensitive_path(path)?;
    let cfg = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let target = std::path::Path::new(path);
    // Лексическое сравнение + канонизация существующего родителя (перекрывает
    // 8.3-имена и синонимы каталога); несуществующий таргет сравнивается как
    // есть. norm_path срезает \\?\-префикс canonicalize: без среза сравнение
    // не совпадало никогда и канонизация была мёртвым кодом (обход гардала
    // путём `\\?\C:\...\com.haloui.app\hooks.json`)
    let canon_dir = |p: Option<&std::path::Path>| -> Option<String> {
        let p = p?;
        if p.exists() {
            Some(norm_path(&std::fs::canonicalize(p).ok()?))
        } else {
            Some(norm_path(p))
        }
    };
    let cfg_n = norm_path(&cfg);
    let target_n = norm_path(target);
    let parent_inside = canon_dir(target.parent()).is_some_and(|d| starts_dir(&d, &cfg_n));
    if starts_dir(&target_n, &cfg_n) || parent_inside {
        return Err("export target must be outside the application config directory".into());
    }
    Ok(target.to_path_buf())
}

/// Сохранить экспорт-файл настроек (содержимое собрано на фронте).
/// Экспорт живёт только вне конфиг-каталога, формат — строго .json.
#[tauri::command(async)]
pub fn settings_export_write(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<(), String> {
    let target = ensure_export_target(&app, &path)?;
    if !path.ends_with(".json") {
        return Err("export file must be .json".into());
    }
    // Проверка, что это валидный JSON — защита от мусора
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("export content is not valid JSON: {e}"))?;
    crate::fsutil::atomic_write(&target, content.as_bytes())
}

/// Сохранить файл экспорта чата (.md или .json). Путь приходит из диалога
/// «Сохранить как», но команда вызывается из вебвью — гарды те же, что у
/// настроек. JSON дополнительно валидируется, чтобы «JSON» не оказался мусором.
#[tauri::command(async)]
pub fn chat_export_write(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<(), String> {
    let lower = path.to_lowercase();
    if !lower.ends_with(".md") && !lower.ends_with(".json") {
        return Err("chat export file must be .md or .json".into());
    }
    let target = ensure_export_target(&app, &path)?;
    if lower.ends_with(".json") {
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("export content is not valid JSON: {e}"))?;
    }
    crate::fsutil::atomic_write(&target, content.as_bytes())
}

/// Прочитать импорт-файл (путь контролируется фронтом: потолок 32 МБ —
/// pagefile.sys раньше читался в память целиком)
#[tauri::command(async)]
pub fn settings_import_read(path: String) -> Result<serde_json::Value, String> {
    rejects_sensitive_path(&path)?;
    let data = crate::fsutil::read_capped_string(std::path::Path::new(&path), 0)?;
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
        crate::fsutil::atomic_write(
            &spath,
            serde_json::to_string_pretty(&v)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )?;
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
        crate::fsutil::atomic_write(
            &ppath,
            serde_json::to_string_pretty(&v)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )?;
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
    /// Акцент проекта (кастомизация «акцент проекта»)
    #[serde(default)]
    pub accent: Option<String>,
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
    crate::fsutil::atomic_write(&path, json.as_bytes())
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
    crate::fsutil::atomic_write(&path, json.as_bytes())
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
    crate::fsutil::atomic_write(&dir.join(file), json.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Гардал записи с фронтенда — центральный security-путь, поэтому
    // регресс-тест на каждый известный класс обхода (аудит: вербатим-префиксы,
    // `\.\`, 8.3-алиасы, сиблинги конфиг-каталога)

    #[cfg(windows)]
    #[test]
    fn sensitive_windows_locations_are_rejected() {
        for p in [
            r"C:\Windows\evil.json",
            // вербатим-префикс: Win32 пишет без нормализации
            r"\\?\C:\Windows\evil.json",
            // `\.\` исчезает при нормализации Win32
            r"C:\.\Windows\evil.json",
            r"C:\Program Files\x.json",
            r"C:\PROGRA~1\App\x.json",
            r"C:\ProgramData\Microsoft\Crypto\x.json",
            // NT-префикс и вербатим-мусор — fail closed
            r"\??\C:\Windows\evil.json",
            r"\\\?\C:\Windows\evil.json",
            r"\\.\C:\Windows\evil.json",
            r"\\?\UNC\srv\share\..\..\x",
            r"C:\Users\me\..\..\Windows\evil.json",
            // админ-шары: топ-компонент — не каталог, а скрытая шара тома
            r"\\localhost\c$\Windows\evil.json",
            r"\\host\admin$\x.json",
            r"\\host\ipc$\x.json",
        ] {
            assert!(
                rejects_sensitive_path(p).is_err(),
                "must reject: {p}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn ordinary_windows_paths_are_allowed() {
        for p in [
            r"C:\Users\me\Documents\settings-export.json",
            r"D:\repo\out\export.json",
            r"\\NAS\share\backups\nocturn.json",
            // сиблинг конфиг-каталога — не сам конфиг-каталог
            r"C:\Users\me\AppData\Roaming\com.haloui.app-backup\export.json",
        ] {
            assert!(
                rejects_sensitive_path(p).is_ok(),
                "must allow: {p}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn relative_and_odd_paths_fail_closed() {
        for p in ["export\\file.json", "file.json", "", "C:"] {
            assert!(rejects_sensitive_path(p).is_err(), "must reject: {p:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_cuts_both_prefixes() {
        assert_eq!(strip_verbatim(r"\\?\C:\x"), r"C:\x");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share"), r"srv\share");
        assert_eq!(strip_verbatim(r"C:\plain"), r"C:\plain");
    }

    #[cfg(not(windows))]
    #[test]
    fn sensitive_unix_locations_are_rejected() {
        for p in ["/etc/passwd", "/proc/self/x", "/sys/x", "/boot/x", "/root/x"] {
            assert!(rejects_sensitive_path(p).is_err(), "must reject: {p}");
        }
        // .ssh блокируется на любой глубине
        assert!(rejects_sensitive_path("/home/me/.ssh/id_rsa").is_err());
        assert!(rejects_sensitive_path("/home/me/.config/x.json").is_ok());
    }

    #[test]
    fn starts_dir_matches_whole_components_only() {
        let sep = std::path::MAIN_SEPARATOR;
        let dir = format!("c:{sep}cfg");
        // сам каталог и вложенные — внутри
        assert!(starts_dir(&dir, &dir));
        assert!(starts_dir(&format!("{dir}{sep}sub{sep}f.json"), &dir));
        // сиблинг с общим префиксом — НЕ внутри (раньше ложно отклонялся)
        assert!(!starts_dir(&format!("c:{sep}cfg-backup{sep}f.json"), &dir));
    }
}

// ---------- Серверный слой прав (perm.rs) ----------