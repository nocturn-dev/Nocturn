//! Настройки, профили API, проекты, команды хранилища ключей (vault),
//! экспорт/импорт конфигурации одним файлом.

use crate::crypto;
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::Mutex;
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

fn load_profiles_blocking(app: &tauri::AppHandle) -> Result<ProfilesStore, String> {
    let path = config_file(app, "profiles.json")?;
    if !path.exists() {
        // Миграция: профили, ранее сохранённые внутри settings.json
        let spath = config_file(app, "settings.json")?;
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
                    if let Err(e) = save_profiles_blocking(
                        app,
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
pub async fn load_profiles(app: tauri::AppHandle) -> Result<ProfilesStore, String> {
    // profiles.json читается на старте и после crypto-unlock: на сетевом
    // профиле AppData чтение висит до SMB-таймаута — blocking-пул
    // (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || load_profiles_blocking(&app))
        .await
        .map_err(|e| format!("profiles load task failed: {e}"))?
}

fn save_profiles_blocking(
    app: &tauri::AppHandle,
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
    let path = config_file(app, "profiles.json")?;
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

#[tauri::command(async)]
pub async fn save_profiles(
    app: tauri::AppHandle,
    profiles: Vec<ApiProfile>,
    active: String,
    encrypt: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_profiles_blocking(&app, profiles, active, encrypt)
    })
    .await
    .map_err(|e| format!("profiles save task failed: {e}"))?
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
    // Символы, не байты: 4 CJK-символа (12 байт) не должны проходить
    // политику «минимум 8»
    if password.chars().count() < 8 {
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
        // Ключ появился: поллер Telegram мог честно погаситься при старте
        // с enc-токеном и запертым vault — перезапускаем (apply_runtime сам
        // решает по enabled/пустому токену, запускаться ли)
        crate::telegram::apply_runtime(app);
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
    let meta = crypto_write_meta(&app, &migrated.0, &migrated.2, "argon2id");
    // Та же причина, что и в argon2-ветке выше: после разблокировки поллер
    // с enc-токеном снова может ходить в Telegram
    crate::telegram::apply_runtime(app);
    meta
}

/// Файлы с enc-полями, которые переносит rekey_all. imagegen/websearch/
/// telegram — та же волна, что чистит crypto_reset (см. ниже): без переноса
/// миграция PBKDF2→Argon2id делала эти ключи невосстановимыми (расшифровка-
/// на-использовании честно отвечала «vault is locked» при разблокированном
/// vault — старый шифротекст новым ключом не берётся)
const REKEY_SECRET_FIELDS: &[(&str, &str)] = &[
    ("imagegen.json", "api_key"),
    ("websearch.json", "brave_key"),
    ("telegram.json", "bot_token"),
];

/// Полный список файлов rekey_all: имя → в каком виде лежат enc-поля
fn rekey_targets() -> Vec<&'static str> {
    let mut names = vec!["settings.json", "profiles.json"];
    names.extend(REKEY_SECRET_FIELDS.iter().map(|(f, _)| *f));
    names
}

/// Чистое ядро rekey: содержимое одного конфига → байты с перешифрованными
/// enc-полями. Выделено без AppHandle — покрыто юнит-тестами. Fail-closed:
/// битый JSON и непереводимое поле — Err, а не «превратить в {}» (иначе rekey
/// молча перезаписал бы частично восстановимый файл пустышкой)
fn rekey_staged_bytes(
    name: &str,
    data: &str,
    old_key: &[u8],
    new_key: &[u8],
) -> Result<Vec<u8>, String> {
    let mut v: serde_json::Value = serde_json::from_str(data)
        .map_err(|e| format!("cannot parse {name} — rekey aborted, nothing written: {e}"))?;
    let mut fields: Vec<&mut serde_json::Value> = Vec::new();
    if name == "settings.json" {
        if let Some(f) = v.get_mut("api_key") {
            fields.push(f);
        }
    } else if name == "profiles.json" {
        if let Some(arr) = v.get_mut("profiles").and_then(|x| x.as_array_mut()) {
            for p in arr {
                if let Some(f) = p.get_mut("api_key") {
                    fields.push(f);
                }
            }
        }
    } else if let Some((_, field)) = REKEY_SECRET_FIELDS.iter().find(|(f, _)| *f == name) {
        if let Some(f) = v.get_mut(*field) {
            fields.push(f);
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
    serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())
}

/// Перешифровать все зашифрованные поля (settings.json, profiles.json и
/// секретные конфиги imagegen/websearch/telegram) со старого ключа на новый.
///
/// Транзакция: все файлы готовятся в памяти; поле, не расшифровавшееся
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
    for name in rekey_targets() {
        let path = config_file(app, name)?;
        if !path.exists() {
            continue;
        }
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let bytes = rekey_staged_bytes(name, &data, old_key, new_key).map_err(|e| {
            format!(
                "rekey aborted, nothing written: {e}"
            )
        })?;
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
    // Переключение шифрования меняет содержимое settings.json
    invalidate_settings_cache();
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
        // (какое поле чистит каждая ветка — в if/else ниже)
        for path in [
            config_file(&app, "settings.json")?,
            config_file(&app, "profiles.json")?,
        ] {
            if !path.exists() {
                continue;
            }
            let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            // Fail-closed: RESET разрушает только зашифрованные поля,
            // а не весь файл — битый JSON отдаём ошибкой, не пустышкой.
            let mut v: serde_json::Value = serde_json::from_str(&data)
                .map_err(|e| format!("cannot parse {} — reset aborted: {e}", path.display()))?;
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
        // Секретные конфиги с.enc-полями: без чистки после RESET и нового
        // пароля владелец получал «vault is locked» при РАЗБЛОКИРОВАННОМ
        // vault — старый шифротекст новым ключом не расшифровывается.
        // Plaintext-ключи не трогаем: они от сброса не утеряны
        for (file, field) in [
            ("imagegen.json", "api_key"),
            ("websearch.json", "brave_key"),
            ("telegram.json", "bot_token"),
        ] {
            let path = config_file(&app, file)?;
            if !path.exists() {
                continue;
            }
            let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let mut v: serde_json::Value = serde_json::from_str(&data)
                .map_err(|e| format!("cannot parse {file} — reset aborted: {e}"))?;
            let encrypted = v
                .get(field)
                .and_then(|x| x.as_str())
                .map(crypto::is_encrypted)
                .unwrap_or(false);
            if encrypted {
                v[field] = serde_json::Value::String(String::new());
                crate::fsutil::atomic_write(
                    &path,
                    serde_json::to_string_pretty(&v)
                        .map_err(|e| e.to_string())?
                        .as_bytes(),
                )?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("crypto reset task failed: {e}"))?
}

// ---------- Экспорт/импорт настроек одним файлом ----------

/// Конфиг-файлы, входящие в экспорт. crypto.json включён: без той же соли
/// и check зашифрованные ключи не оживут на другой машине.
/// fonts.json входит (манифест имён семейств), сами файлы шрифтов — нет:
/// машинно-специфичные бинари, а несуществующее семейство деградирует
/// в системный стек (fonts.ts).
/// memory.json (личная память агента) сознательно НЕ входит: приватные
/// данные пользователя, перенос — только руками, как у sessions.json
/// в «поделенный» экспорт без секретов.
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
    "network.json",
    "websearch.json",
    "dictation.json",
    "fonts.json",
    "telegram.json",
    "crypto.json",
];

/// Собрать содержимое всех конфиг-файлов (отсутствующие пропускаются).
/// API-ключи по умолчанию маскируются: файлом настроек можно делиться,
/// не отдавая ключи провайдеров; include_secrets=true — осознанный экспорт
/// для переноса на другую машину.
fn settings_read_all_blocking(
    app: &tauri::AppHandle,
    include_secrets: Option<bool>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let include_secrets = include_secrets.unwrap_or(false);
    let mut files = serde_json::Map::new();
    for name in EXPORT_FILES {
        // В «поделенный» экспорт (include_secrets=false) не идут:
        // crypto.json — соль KDF + check-маркер, материал для офлайн-перебора
        // мастер-пароля; sessions.json — вся история чатов, делиться файлом
        // «настроек без ключей» не должно отдавать переписку; hooks.json —
        // исполняемые командные строки, в которых токен (Bearer-заголовок в
        // curl и т.п.) — обычная практика, замаскировать их нельзя не убив
        // хук (аудит А1-3). Машино-перенос — только осознанный
        // include_secrets=true
        if !include_secrets
            && (*name == "crypto.json" || *name == "sessions.json" || *name == "hooks.json")
        {
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

#[tauri::command(async)]
pub async fn settings_read_all(
    app: tauri::AppHandle,
    include_secrets: Option<bool>,
) -> Result<serde_json::Value, String> {
    // Экспорт читает до 15 файлов подряд: на сетевом профиле AppData это
    // десятки секунд блокировки — blocking-пул (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        settings_read_all_blocking(&app, include_secrets)
    })
    .await
    .map_err(|e| format!("settings read task failed: {e}"))?
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
        // Brave-ключ веб-поиска — та же категория секрета (на диске тоже
        // enc:v1:…); без ветки конфиг поиска не переносился экспортом,
        // а с ключом — утекал в «поделенный» файл
        "websearch.json" => {
            if let Some(k) = v.get_mut("brave_key") {
                *k = blank();
            }
        }
        // Токен Telegram-бота — та же категория секрета (на диске enc:v1:…):
        // без ветки уходил бы в «поделенный» экспорт как есть
        "telegram.json" => {
            if let Some(k) = v.get_mut("bot_token") {
                *k = blank();
            }
        }
        // mcp.json — массив серверов: headers (Authorization: Bearer …) и env
        // (API-ключи серверов) — те же токены, что api_key выше; без ветки
        // они уходили в «поделенный» экспорт как есть. Гасим значения целиком:
        // в env/headers нет полей, гарантированно не несущих секрет
        "mcp.json" => {
            if let Some(arr) = v.as_array_mut() {
                for s in arr {
                    if let Some(headers) = s.get_mut("headers").and_then(|x| x.as_object_mut()) {
                        for val in headers.values_mut() {
                            *val = blank();
                        }
                    }
                    if let Some(env) = s.get_mut("env").and_then(|x| x.as_object_mut()) {
                        for val in env.values_mut() {
                            *val = blank();
                        }
                    }
                }
            }
        }
        // Прокси может нести креды прямо в URL (http://user:pass@host:port —
        // reqwest это легальный формат); без ветки адрес с паролем уходил в
        // «поделенный» экспорт как есть (аудит А1-3). Гасим целиком: адрес
        // внутреннего прокси — машинно-специфичная информация
        "network.json" => {
            if let Some(k) = v.get_mut("proxy") {
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
fn settings_write_all_blocking(
    app: &tauri::AppHandle,
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
    // Импорт мог перезаписать settings.json — кэш под него не годится
    invalidate_settings_cache();
    Ok(written)
}

#[tauri::command(async)]
pub async fn settings_write_all(
    app: tauri::AppHandle,
    files: std::collections::HashMap<String, serde_json::Value>,
    allow_executable_configs: bool,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        settings_write_all_blocking(&app, files, allow_executable_configs)
    })
    .await
    .map_err(|e| format!("settings write task failed: {e}"))?
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
        let comps: Vec<String> = stripped
            .split('\\')
            .filter(|c| !c.is_empty() && *c != ".")
            .map(|c| c.trim_end_matches(['.', ' ']).to_string())
            .collect();
        // Win32 срезает хвостовые точки/пробелы у КАЖДОГО компонента, а не
        // только у последнего: `C:\Windows.\evil.json` — это
        // `C:\Windows\evil.json`, и точный матч топ-каталога ниже обходился.
        // Компонент из одних точек/пробелов («...») после нормализации пуст —
        // fail closed
        if comps.iter().any(|c| c.is_empty()) {
            return Err("path contains an invalid component".into());
        }
        // `..` запрещаем целиком: легитимному экспорту подъём не нужен,
        // а он уводит проверку топ-уровня мимо целевого каталога
        if comps.iter().any(|c| c == "..") {
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
        // NTFS-альтернативные потоки (`file.txt:ads`, `file.txt:$DATA`):
        // экзотическая поверхность записи/чтения мимо расширений и блок-листов.
        // Легальное двоеточие одно — диск в comps[0] (его форму уже гарантирует
        // drive_shape); UNC-хост с двоеточием (IPv6-литерал) — fail closed
        if comps
            .iter()
            .enumerate()
            .any(|(i, c)| c.contains(':') && (i > 0 || is_unc))
        {
            return Err("path contains an NTFS stream specifier".into());
        }
        // comps[1] — топ-каталог (для UNC — шара)
        let top = short83(comps.get(1).map(|s| s.as_str()).unwrap_or(""));
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
        // Относительные пути — fail closed: резолвились бы в cwd процесса
        if !norm.starts_with('/') {
            return Err("path must be absolute".into());
        }
        let comps: Vec<&str> = norm.split('/').filter(|c| !c.is_empty()).collect();
        // `..` под запретом так же, как на Windows-ветке: подъём уводит
        // проверку топ-уровня мимо целевого каталога (/home/u/../../etc/…)
        if comps.iter().any(|c| *c == "..") {
            return Err("path must not contain '..'".into());
        }
        if comps
            .first()
            .is_some_and(|c| matches!(*c, "etc" | "proc" | "sys" | "dev" | "boot" | "root"))
        {
            return Err("path points to a protected system location".into());
        }
        // macOS: /etc, /var, /root — симлинки в /private/...; канонизация на
        // ревалидации (ensure_export_target / settings_import_read) даёт
        // /private/etc, который без этой ветки проходил мимо блока — два пути
        // к одному месту были защищены асимметрично (аудит А3-3)
        #[cfg(target_os = "macos")]
        if comps.first().is_some_and(|c| *c == "private") {
            if comps
                .get(1)
                .is_some_and(|c| matches!(*c, "etc" | "var" | "root"))
            {
                return Err("path points to a protected system location".into());
            }
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
    // Слэши приводим к «\», как rejects_sensitive_path: путь с «/» и
    // несуществующим родителем иначе уходил мимо лексического сравнения
    // (граница компонента — MAIN_SEPARATOR), гардал пропускал запись во
    // вложенный каталог конфигов, а atomic_write её создавал
    strip_verbatim(&p.to_string_lossy())
        .to_lowercase()
        .replace('/', "\\")
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
    // Ревалидация канонической формы: canonicalize резолвит симлинки/junction
    // и 8.3, а проверка выше идёт по сырой строке. Без повтора предзасаженный
    // линк уводил запись в защищённую локацию мимо блок-листа. Провал
    // канонизации (экзотическая ФС) — не фейл: проверяем то, что смогли
    let canon_target = match target.parent() {
        Some(parent) if parent.exists() => match std::fs::canonicalize(parent) {
            Ok(base) => base.join(target.file_name().unwrap_or_default()),
            Err(_) => target.to_path_buf(),
        },
        _ => target.to_path_buf(),
    };
    rejects_sensitive_path(&canon_target.to_string_lossy())?;
    let parent_inside = canon_dir(target.parent()).is_some_and(|d| starts_dir(&d, &cfg_n));
    if starts_dir(&target_n, &cfg_n) || parent_inside {
        return Err("export target must be outside the application config directory".into());
    }
    Ok(target.to_path_buf())
}

/// Сохранить экспорт-файл настроек (содержимое собрано на фронте).
/// Экспорт живёт только вне конфиг-каталога, формат — строго .json.
#[tauri::command(async)]
pub async fn settings_export_write(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<(), String> {
    // Канонизация + запись: путь может лежать на сетевом ресурсе
    tauri::async_runtime::spawn_blocking(move || {
        let target = ensure_export_target(&app, &path)?;
        // Регистронезависимо: на Windows/macOS (ФС нечувствительна к регистру)
        // EXPORT.JSON — легитимное имя; chat_export_write уже проверяет так
        if !path.to_lowercase().ends_with(".json") {
            return Err("export file must be .json".into());
        }
        // Проверка, что это валидный JSON — защита от мусора
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("export content is not valid JSON: {e}"))?;
        crate::fsutil::atomic_write(&target, content.as_bytes())
    })
    .await
    .map_err(|e| format!("settings export task failed: {e}"))?
}

/// Сохранить файл экспорта чата (.md или .json). Путь приходит из диалога
/// «Сохранить как», но команда вызывается из вебвью — гарды те же, что у
/// настроек. JSON дополнительно валидируется, чтобы «JSON» не оказался мусором.
#[tauri::command(async)]
pub async fn chat_export_write(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<(), String> {
    // Цель может лежать на сетевом ресурсе (диалог «Сохранить как»):
    // канонизация + запись — в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("chat export task failed: {e}"))?
}

/// Прочитать импорт-файл (путь контролируется фронтом: потолок 32 МБ —
/// pagefile.sys раньше читался в память целиком).
/// Модель доверия: гард закрывает только системные локации, любой файл
/// пользователя читается в вебвью осознанно — это и есть фича импорта
/// (та же модель у plugin_read и kb_add_document)
#[tauri::command(async)]
pub async fn settings_import_read(path: String) -> Result<serde_json::Value, String> {
    rejects_sensitive_path(&path)?;
    // Чтение до 32 МБ + парс — в blocking-пул: на воркере tokio это
    // вставало поперёк SSE-стримов (класс crypto_status)
    tauri::async_runtime::spawn_blocking(move || {
        // Симлинк на пути — вне модели доверия импорта («осознанное чтение
        // файла пользователем»): резолвим и ревалидируем, иначе предзасаженный
        // линк читал защищённую локацию мимо блок-листа. Канонизация здесь же,
        // в blocking-пуле: на сетевом пути это блокирующий metadata-вызов
        let canon = std::fs::canonicalize(&path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.clone());
        rejects_sensitive_path(&canon)?;
        let data = crate::fsutil::read_capped_string(std::path::Path::new(&path), 0)?;
        serde_json::from_str(&data).map_err(|e| format!("import file corrupted: {e}"))
    })
    .await
    .map_err(|e| format!("import read task failed: {e}"))?
}

/// Тумблер шифрования: перезаписывает settings.json и profiles.json,
/// шифруя (или расшифровывая) все API-ключи на месте.
/// Включение требует разблокированного хранилища (пароль уже введён).
fn set_key_encryption_blocking(app: &tauri::AppHandle, enable: bool) -> Result<(), String> {
    if enable && !crypto::has_key() {
        return Err("vault is locked: enter the master password first".into());
    }

    // settings.json: ключ + флаг encrypt_keys
    let spath = config_file(app, "settings.json")?;
    if spath.exists() {
        let data = fs::read_to_string(&spath).map_err(|e| e.to_string())?;
        // Fail-closed: битый JSON не перезаписываем — см. rekey_all
        let mut v: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("cannot parse settings.json — toggle aborted: {e}"))?;
        if let Some(key) = v.get("api_key").and_then(|x| x.as_str()).map(String::from) {
            let new_key = if enable && !key.is_empty() && !crypto::is_encrypted(&key) {
                crypto::encrypt(&key)?
            } else if !enable && crypto::is_encrypted(&key) {
                // FIX: раньше decrypt → None (заблокированное хранилище /
                // сменившийся пароль) тихо писал на диск ПУСТОЙ ключ — потеря.
                // Теперь команда падает, файл остаётся нетронутым.
                crypto::decrypt(&key)
                    .map(|plain| plain.to_string())
                    .ok_or(
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
        invalidate_settings_cache();
    }

    // profiles.json: ключи всех профилей
    let ppath = config_file(app, "profiles.json")?;
    if ppath.exists() {
        let data = fs::read_to_string(&ppath).map_err(|e| e.to_string())?;
        // Fail-closed: битый JSON не перезаписываем — см. rekey_all
        let mut v: serde_json::Value = serde_json::from_str(&data)
            .map_err(|e| format!("cannot parse profiles.json — toggle aborted: {e}"))?;
        if let Some(arr) = v.get_mut("profiles").and_then(|x| x.as_array_mut()) {
            for p in arr {
                if let Some(key) = p.get("api_key").and_then(|x| x.as_str()).map(String::from) {
                    let new_key = if enable && !key.is_empty() && !crypto::is_encrypted(&key) {
                        crypto::encrypt(&key)?
                    } else if !enable && crypto::is_encrypted(&key) {
                        // FIX: то же, что и для settings.json — без тихой потери ключа
                        crypto::decrypt(&key)
                            .map(|plain| plain.to_string())
                            .ok_or(
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

#[tauri::command(async)]
pub async fn set_key_encryption(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    // Перезаписывает settings.json и profiles.json целиком (чтение+шифрование+
    // запись каждого) — на сетевом профиле это минуты блокировки: blocking-пул
    tauri::async_runtime::spawn_blocking(move || set_key_encryption_blocking(&app, enable))
        .await
        .map_err(|e| format!("encryption switch task failed: {e}"))?
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
    /// Папка проекта: в <root>/.nocturn живут сессии проекта (фидбек 29.09,
    /// ZCode-стиль). serde default — старые projects.json без root валидны
    #[serde(default)]
    pub root: Option<String>,
}

/// Хранилище проектов — отдельный файл projects.json
fn load_projects_blocking(app: &tauri::AppHandle) -> Result<Vec<ProjectRec>, String> {
    let path = config_file(app, "projects.json")?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("projects file corrupted: {e}"))
}

#[tauri::command(async)]
pub async fn load_projects(app: tauri::AppHandle) -> Result<Vec<ProjectRec>, String> {
    tauri::async_runtime::spawn_blocking(move || load_projects_blocking(&app))
        .await
        .map_err(|e| format!("projects load task failed: {e}"))?
}

fn save_projects_blocking(
    app: &tauri::AppHandle,
    projects: Vec<ProjectRec>,
) -> Result<(), String> {
    let path = config_file(app, "projects.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&path, json.as_bytes())
}

#[tauri::command(async)]
pub async fn save_projects(app: tauri::AppHandle, projects: Vec<ProjectRec>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_projects_blocking(&app, projects))
        .await
        .map_err(|e| format!("projects save task failed: {e}"))?
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
        // Граница serde (поле ApiSettings — String): копия здесь неизбежна.
        // Честная оговорка: plain.to_string() — обычный String БЕЗ Zeroizing,
        // он живёт в ApiSettings.api_key и не затирается при drop; Zeroizing
        // внутри crypto.rs защищает только собственные буферы криптомодуля
        Some(plain) => Ok(plain.to_string()),
        None if crypto::has_key() => Err(
            "stored API key cannot be decrypted (master password changed or reset) — re-enter the key"
                .into(),
        ),
        None => Ok(String::new()),
    }
}

/// Кэш разобранного settings.json по (mtime, len). run_tool зовёт
/// load_settings на каждый инструмент — без кэша это диск+парс на каждом
/// шаге агента. В кэше лежит сырой Value КАК В ФАЙЛЕ (ключ остаётся
/// enc:v1:…): расшифровка — по-прежнему на каждом вызове, чтобы
/// расшифрованный ключ не жил в памяти дольше vault-политики.
static SETTINGS_CACHE: Mutex<Option<(std::time::SystemTime, u64, serde_json::Value)>> =
    Mutex::new(None);

/// Сброс кэша настроек. mtime-проверка в load_settings — основной механизм,
/// явная инвалидация в писателях — страховка от грубой гранулярности mtime
/// на экзотических ФС.
pub(crate) fn invalidate_settings_cache() {
    if let Ok(mut guard) = SETTINGS_CACHE.lock() {
        *guard = None;
    }
}

/// Синхронное тело load_settings: зовётся из blocking-пула командой и
/// напрямую из run_tool (его spawn_blocking-секция). Кэш валиден, пока
/// размер и mtime файла совпадают с записанными
pub(crate) fn load_settings_blocking(app: &tauri::AppHandle) -> Result<ApiSettings, String> {
    let path = config_file(app, "settings.json")?;
    // Кэш валиден, пока размер и mtime файла совпадают с записанными
    let cached = {
        let guard = SETTINGS_CACHE.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some((mtime, len, value)) => match fs::metadata(&path) {
                Ok(md) if md.len() == *len && md.modified().ok().as_ref() == Some(mtime) => {
                    Some(value.clone())
                }
                _ => None,
            },
            None => None,
        }
    };
    let value = match cached {
        Some(value) => value,
        None => {
            if !path.exists() {
                return Ok(ApiSettings::default());
            }
            let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let value: serde_json::Value =
                serde_json::from_str(&data).map_err(|e| format!("settings file corrupted: {e}"))?;
            // Заполняем кэш Best-effort: не снялись метаданные — просто
            // не кэшируем, диск прочитается в следующий раз
            if let (Ok(md), Ok(mtime)) = (fs::metadata(&path), fs::metadata(&path).and_then(|m| m.modified())) {
                if let Ok(mut guard) = SETTINGS_CACHE.lock() {
                    *guard = Some((mtime, md.len(), value.clone()));
                }
            }
            value
        }
    };
    let mut s: ApiSettings =
        serde_json::from_value(value).map_err(|e| format!("settings file corrupted: {e}"))?;
    // Прозрачно расшифровываем ключ, если он зашифрован
    if crypto::is_encrypted(&s.api_key) {
        s.api_key = decrypt_stored_key(&s.api_key)?;
    }
    Ok(s)
}

#[tauri::command(async)]
pub async fn load_settings(app: tauri::AppHandle) -> Result<ApiSettings, String> {
    tauri::async_runtime::spawn_blocking(move || load_settings_blocking(&app))
        .await
        .map_err(|e| format!("settings load task failed: {e}"))?
}

fn save_settings_blocking(app: &tauri::AppHandle, settings: ApiSettings) -> Result<(), String> {
    let path = config_file(app, "settings.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut s = settings;
    if s.encrypt_keys && !s.api_key.is_empty() && !crypto::is_encrypted(&s.api_key) {
        s.api_key = crypto::encrypt(&s.api_key)?;
    }
    let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&path, json.as_bytes())?;
    invalidate_settings_cache();
    Ok(())
}

#[tauri::command(async)]
pub async fn save_settings(app: tauri::AppHandle, settings: ApiSettings) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_settings_blocking(&app, settings))
        .await
        .map_err(|e| format!("settings save task failed: {e}"))?
}
/// Прочитать конфиг-файл как Value (модули со своей статикой: dictation и пр.)
pub(crate) fn read_json_config(
    app: &tauri::AppHandle,
    file: &str,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join(file);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
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
            // NTFS-альтернативные потоки: мимо расширений и блок-листов
            r"C:\Users\me\export.json:ads",
            r"C:\Users\me\export.json:$DATA",
            r"C:\proj\dir:stream\x.json",
            r"\\host\share\x.json:stream",
            // IPv6-литерал в UNC-хосте — двоеточие вне диска, fail closed
            r"\\[::1]\share\x.json",
            // хвостовая точка/пробел ПРОМЕЖУТОЧНОГО компонента: Win32
            // нормализует их у каждого элемента пути (аудит: обход блок-листа)
            r"C:\Windows.\evil.json",
            r"C:\Windows \evil.json",
            r"C:\ProgramData.\evil.json",
            r"C:\Program Files.\x.json",
            r"\\?\C:\Windows.\evil.json",
            // компонент из одних точек/пробелов — после нормализации пуст
            r"C:\...\evil.json",
        ] {
            assert!(
                rejects_sensitive_path(p).is_err(),
                "must reject: {p}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn config_dir_comparison_normalizes_forward_slashes() {
        // Аудит: путь с «/» и несуществующим родителем уходил мимо
        // лексического сравнения (norm_path не нормализовал слэши) —
        // гардал пропускал запись во вложенный каталог конфигов,
        // а atomic_write создавал её
        let cfg = std::path::Path::new("C:\\Users\\me\\AppData\\Roaming\\com.haloui.app");
        for target in [
            "C:/Users/me/AppData/Roaming/com.haloui.app/newdir/x.json",
            "C:/Users/me/AppData/Roaming/com.haloui.app/hooks.json",
            "C:\\Users\\me\\AppData\\Roaming\\com.haloui.app\\sub\\x.json",
        ] {
            assert!(
                starts_dir(&norm_path(std::path::Path::new(target)), &norm_path(cfg)),
                "must detect config dir inside: {target}"
            );
        }
        // Сиблинг по-прежнему не матчится
        assert!(!starts_dir(
            &norm_path(std::path::Path::new(
                "C:/Users/me/AppData/Roaming/com.haloui.app-backup/x.json"
            )),
            &norm_path(cfg)
        ));
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

    #[cfg(not(windows))]
    #[test]
    fn unix_dotdot_and_relative_fail_closed() {
        // Подъём уводил проверку топ-уровня мимо целевого каталога, а
        // относительный путь резолвился в cwd (аудит: Windows-ветка
        // отвергала и то, и другое, Unix — нет)
        assert!(rejects_sensitive_path("/home/me/proj/../../etc/cron.d/x.json").is_err());
        assert!(rejects_sensitive_path("../settings-export.json").is_err());
        assert!(rejects_sensitive_path("export/file.json").is_err());
        assert!(rejects_sensitive_path("/home/me/export/file.json").is_ok());
    }

    #[test]
    fn mask_secrets_blanks_mcp_headers_and_env() {
        // «Поделенный» экспорт не должен уносить токены MCP-серверов:
        // headers (Authorization: Bearer …) и env (API-ключи серверов)
        let mut v: serde_json::Value = serde_json::json!([
            {
                "name": "github",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": { "GITHUB_TOKEN": "ghp_topsecret" },
                "headers": { "Authorization": "Bearer sk-topsecret" }
            },
            {
                "name": "remote",
                "transport": "http",
                "url": "https://mcp.example/sse",
                "headers": { "X-Api-Key": "k" }
            }
        ]);
        mask_secrets("mcp.json", &mut v);
        assert_eq!(v[0]["env"]["GITHUB_TOKEN"], "");
        assert_eq!(v[0]["headers"]["Authorization"], "");
        assert_eq!(v[1]["headers"]["X-Api-Key"], "");
        // не-секретные поля не тронуты
        assert_eq!(v[0]["command"], "npx");
        assert_eq!(v[0]["args"][0], "-y");
        assert_eq!(v[1]["url"], "https://mcp.example/sse");
    }

    #[test]
    fn mask_secrets_blanks_every_secret_branch() {
        // Золотой вектор на КАЖДУЮ ветку mask_secrets (правило 7): опечатка
        // в имени поля новой ветки не должна проходить молча — регресс
        // маскирования не ловился бы ничем (аудит 2026-10-04)
        let mut settings = serde_json::json!({ "api_key": "sk-topsecret", "encrypt_keys": true });
        mask_secrets("settings.json", &mut settings);
        assert_eq!(settings["api_key"], "");

        let mut profiles = serde_json::json!({ "profiles": [ { "api_key": "sk-a" }, { "api_key": "sk-b" } ] });
        mask_secrets("profiles.json", &mut profiles);
        assert_eq!(profiles["profiles"][0]["api_key"], "");
        assert_eq!(profiles["profiles"][1]["api_key"], "");

        let mut imagegen = serde_json::json!({ "api_key": "enc:v1:zzz" });
        mask_secrets("imagegen.json", &mut imagegen);
        assert_eq!(imagegen["api_key"], "");

        let mut websearch = serde_json::json!({ "brave_key": "enc:v1:zzz" });
        mask_secrets("websearch.json", &mut websearch);
        assert_eq!(websearch["brave_key"], "");

        let mut telegram = serde_json::json!({ "bot_token": "123:ABC" });
        mask_secrets("telegram.json", &mut telegram);
        assert_eq!(telegram["bot_token"], "");

        let mut network = serde_json::json!({ "proxy": "http://user:pass@host:3128" });
        mask_secrets("network.json", &mut network);
        assert_eq!(network["proxy"], "");
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

    // --- rekey_staged_bytes: ядро миграции PBKDF2→Argon2id (№2 аудита v5) ---

    fn enc_with(key: &[u8], plain: &str) -> String {
        crypto::encrypt_with(key, plain).expect("encrypt in test")
    }

    #[test]
    fn rekey_migrates_all_five_config_shapes() {
        let old = [1u8; 32];
        let new = [2u8; 32];

        // settings.json: api_key верхнего уровня
        let data = serde_json::json!({ "api_key": enc_with(&old, "sk-top"), "encrypt_keys": true });
        let out = rekey_staged_bytes("settings.json", &data.to_string(), &old, &new).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            crypto::decrypt_with(&new, v["api_key"].as_str().unwrap()).map(|p| p.to_string()),
            Some("sk-top".into())
        );

        // profiles.json: api_key каждого профиля
        let data = serde_json::json!({
            "profiles": [
                { "name": "a", "api_key": enc_with(&old, "sk-p1") },
                { "name": "b", "api_key": enc_with(&old, "sk-p2") }
            ]
        });
        let out = rekey_staged_bytes("profiles.json", &data.to_string(), &old, &new).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        for (i, want) in ["sk-p1", "sk-p2"].iter().enumerate() {
            let stored = v["profiles"][i]["api_key"].as_str().unwrap();
            assert_eq!(
                crypto::decrypt_with(&new, stored).map(|p| p.to_string()),
                Some((*want).into())
            );
        }

        // Секретные конфиги: одно enc-поле с индивидуальным именем
        for (file, field, plain) in [
            ("imagegen.json", "api_key", "sk-img"),
            ("websearch.json", "brave_key", "brave-1"),
            ("telegram.json", "bot_token", "123:ABC"),
        ] {
            let data = serde_json::json!({ field: enc_with(&old, plain) });
            let out = rekey_staged_bytes(file, &data.to_string(), &old, &new).unwrap();
            let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
            assert_eq!(
                crypto::decrypt_with(&new, v[field].as_str().unwrap()).map(|p| p.to_string()),
                Some(plain.into()),
                "{file}"
            );
        }
    }

    #[test]
    fn rekey_keeps_plaintext_and_non_target_fields() {
        let old = [1u8; 32];
        let new = [2u8; 32];
        // Для websearch.json таргет — brave_key: plaintext в нём не трогается,
        // а enc в api_key (не таргет ЭТОГО файла) остаётся байт-в-байт
        let enc_foreign = enc_with(&old, "brave-1");
        let data = serde_json::json!({
            "brave_key": "plaintext-key",
            "api_key": enc_foreign,
            "model": "gpt"
        });
        let out = rekey_staged_bytes("websearch.json", &data.to_string(), &old, &new).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["brave_key"].as_str().unwrap(), "plaintext-key");
        assert_eq!(v["api_key"].as_str().unwrap(), enc_foreign);
        assert_eq!(v["model"], "gpt");
    }

    #[test]
    fn rekey_aborts_on_undecryptable_field() {
        let old = [1u8; 32];
        let new = [2u8; 32];
        // enc под ЧУЖИМ ключом (рассинхрон vault) — аборт, ничего не пишется
        let stranger = [7u8; 32];
        let data = serde_json::json!({ "api_key": enc_with(&stranger, "x") });
        let err = rekey_staged_bytes("imagegen.json", &data.to_string(), &old, &new).unwrap_err();
        assert!(err.contains("cannot be decrypted"), "{err}");
        // битый JSON — fail-closed Err, не пустышка
        let err = rekey_staged_bytes("telegram.json", "{oops", &old, &new).unwrap_err();
        assert!(err.contains("cannot parse"), "{err}");
    }
}