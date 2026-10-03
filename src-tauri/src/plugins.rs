//! Конфиги расширений: хуки, плагины, slash-команды, сабагенты,
//! горячие клавиши, цвета статистики — команды чтения/записи JSON.

use crate::hooks;
use crate::settings::{config_file, rejects_sensitive_path};
use std::fs;

// ---------- Хуки ----------

pub fn hooks_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))
}

#[tauri::command(async)]
pub fn hooks_load(app: tauri::AppHandle) -> Result<hooks::HookFile, String> {
    Ok(hooks::load(&hooks_dir(&app)?))
}

#[tauri::command(async)]
pub fn hooks_save(app: tauri::AppHandle, file: hooks::HookFile) -> Result<(), String> {
    for h in &file.hooks {
        if !hooks::EVENTS.contains(&h.event.as_str()) {
            return Err(format!("unknown hook event: {}", h.event));
        }
    }
    hooks::save(&hooks_dir(&app)?, &file)
}

/// Прогнать один хук на пробном payload (кнопка «Тест» в настройках)
#[tauri::command(async)]
pub async fn hooks_test(
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
pub async fn hooks_run_event(
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
pub fn shortcuts_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "shortcuts.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = crate::fsutil::read_capped_string(&path, 0)?;
    serde_json::from_str(&data).map_err(|e| format!("shortcuts file corrupted: {e}"))
}

#[tauri::command(async)]
pub fn shortcuts_save(app: tauri::AppHandle, binds: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "shortcuts.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&binds).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&path, json.as_bytes())
}

/// Прочитать манифест плагина (plugin.json) из папки или файла.
/// async + spawn_blocking: sync-команда в Tauri 2 исполняется на главном
/// потоке — чтение с сетевого диска замораживало весь UI. Потолок размера:
/// путь контролируется фронтом, pagefile.sys раньше читался целиком (OOM)
#[tauri::command(async)]
pub async fn plugin_read(path: String) -> Result<serde_json::Value, String> {
    rejects_sensitive_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::PathBuf::from(&path);
        let manifest = if p.is_dir() { p.join("plugin.json") } else { p };
        let data = crate::fsutil::read_capped_string(&manifest, 0)?;
        serde_json::from_str(&data).map_err(|e| format!("plugin.json corrupted: {e}"))
    })
    .await
    .map_err(|e| format!("plugin read task failed: {e}"))?
}

/// Реестр установленных плагинов (plugins.json)
#[tauri::command(async)]
pub fn plugins_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "plugins.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = crate::fsutil::read_capped_string(&path, 0)?;
    serde_json::from_str(&data).map_err(|e| format!("plugins file corrupted: {e}"))
}

#[tauri::command(async)]
pub fn plugins_save(app: tauri::AppHandle, file: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "plugins.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&path, json.as_bytes())
}

/// Пользовательские slash-команды (commands.json): { commands: [{name, description, template}] }
#[tauri::command(async)]
pub fn commands_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "commands.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = crate::fsutil::read_capped_string(&path, 0)?;
    serde_json::from_str(&data).map_err(|e| format!("commands file corrupted: {e}"))
}

#[tauri::command(async)]
pub fn commands_save(app: tauri::AppHandle, file: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "commands.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&path, json.as_bytes())
}

/// Конфиг субагентов (subagents.json): { enabled, maxParallel, roles: [...] }
#[tauri::command(async)]
pub fn subagents_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "subagents.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = crate::fsutil::read_capped_string(&path, 0)?;
    serde_json::from_str(&data).map_err(|e| format!("subagents file corrupted: {e}"))
}

#[tauri::command(async)]
pub fn subagents_save(app: tauri::AppHandle, config: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "subagents.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&path, json.as_bytes())
}

/// Цвета моделей в статистике (colors.json): { "<model>": "#rrggbb" }
#[tauri::command(async)]
pub fn usage_colors_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = config_file(&app, "colors.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let data = crate::fsutil::read_capped_string(&path, 0)?;
    serde_json::from_str(&data).map_err(|e| format!("colors file corrupted: {e}"))
}

#[tauri::command(async)]
pub fn usage_colors_save(app: tauri::AppHandle, colors: serde_json::Value) -> Result<(), String> {
    let path = config_file(&app, "colors.json")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&colors).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&path, json.as_bytes())
}
#[cfg(test)]
mod tests {
    use super::*;

    /// plugin_read: валидный JSON читается (и из каталога с plugin.json),
    /// битый файл отдаёт честную ошибку вместо паники/мусора
    #[test]
    fn plugin_read_valid_broken_and_dir() {
        let dir = std::env::temp_dir().join(format!("nocturn-plugins-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let file = dir.join("plugin.json");
        std::fs::write(&file, r#"{"name":"demo","version":1}"#).unwrap();
        let ok = tauri::async_runtime::block_on(plugin_read(file.display().to_string())).unwrap();
        assert_eq!(ok.get("name").and_then(|v| v.as_str()), Some("demo"));

        // Каталог: читается <dir>/plugin.json
        let ok_dir = tauri::async_runtime::block_on(plugin_read(dir.display().to_string())).unwrap();
        assert_eq!(ok_dir.get("name").and_then(|v| v.as_str()), Some("demo"));

        let broken = dir.join("broken.json");
        std::fs::write(&broken, "{ not json").unwrap();
        let err = tauri::async_runtime::block_on(plugin_read(broken.display().to_string()))
            .expect_err("broken manifest must fail");
        assert!(err.contains("plugin.json corrupted"), "неожиданная ошибка: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
