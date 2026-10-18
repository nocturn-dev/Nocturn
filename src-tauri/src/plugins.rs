//! Конфиги расширений: хуки, плагины, slash-команды, сабагенты,
//! горячие клавиши, цвета статистики — команды чтения/записи JSON.

use crate::hooks;
use crate::settings::{config_file, rejects_sensitive_path};
use std::fs;

// ---------- Хуки ----------

// Мьютекс для сериализации чтения и записи hooks.json:
// параллельные вызовы из разных окон или при установке плагинов
// не должны перезаписывать друг друга посреди цикла чтения-модификации-записи
static HOOKS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn hooks_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|e| format!("failed to determine config directory: {e}"))
}

#[tauri::command(async)]
pub async fn hooks_load(app: tauri::AppHandle) -> Result<hooks::HookFile, String> {
    // Чтение hooks.json — в blocking-пул под общим мьютексом
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = HOOKS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        Ok(hooks::load(&hooks_dir(&app)?))
    })
    .await
    .map_err(|e| format!("hooks load task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn hooks_save(app: tauri::AppHandle, file: hooks::HookFile) -> Result<(), String> {
    for h in &file.hooks {
        if !hooks::EVENTS.contains(&h.event.as_str()) {
            return Err(format!("unknown hook event: {}", h.event));
        }
    }
    // Сохранённый хук исполняется на КАЖДОМ вызове инструмента с правами пользователя.
    // Подтверждаем запись нативным диалогом с перечнем включённых команд
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let list: Vec<String> = file
            .hooks
            .iter()
            .filter(|h| h.enabled)
            .map(|h| format!("[{}] {}", h.event, h.command.trim()))
            .collect();
        let confirmed = app
            .dialog()
            .message(if list.is_empty() {
                "Save hooks configuration?".to_string()
            } else {
                format!(
                    "These hook commands will run on every matching tool call:

{}

Save?",
                    list.join("
")
                )
            })
            .title("Hooks configuration")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Save".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        if !confirmed {
            return Err("hooks save cancelled".into());
        }
    }
    // Запись hooks.json — в blocking-пуле под общим мьютексом для исключения гонок
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = HOOKS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        hooks::save(&hooks_dir(&app)?, &file)
    })
    .await
    .map_err(|e| format!("hooks save task failed: {e}"))?
}

/// Прогнать один хук на пробном payload (кнопка «Тест» в настройках)
#[tauri::command(async)]
pub async fn hooks_test(
    app: tauri::AppHandle,
    hook: hooks::Hook,
    payload: serde_json::Value,
) -> Result<hooks::HookOutcome, String> {
    // тест исполнял ЛЮБУЮ команду из IPC без сохранения
    // и без следа на диске — один invoke из компрометированного webview
    // давал исполнение shell-команды. Нативное подтверждение с текстом
    // команды — барьер, недоступный вебвью
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let confirmed = app
            .dialog()
            .message(format!(
                "Run this hook command now?

{}",
                hook.command.trim()
            ))
            .title("Hook test")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Run once".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        if !confirmed {
            return Err("hook test cancelled".into());
        }
    }
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
    if !hooks::EVENTS.contains(&event.as_str()) {
        return Err(format!("unknown hook event: {event}"));
    }
    let dir = hooks_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || hooks::run_event(&dir, &event, "", &payload))
        .await
        .map_err(|e| format!("hook task failed: {e}"))
}

// ---------- Пользовательские горячие клавиши (shortcuts.json) ----------

#[tauri::command(async)]
pub async fn shortcuts_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "shortcuts.json")?;
        if !path.exists() {
            return Ok(serde_json::json!({}));
        }
        let data = crate::fsutil::read_capped_string(&path, 0)?;
        serde_json::from_str(&data).map_err(|e| format!("shortcuts file corrupted: {e}"))
    })
    .await
    .map_err(|e| format!("shortcuts load task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn shortcuts_save(app: tauri::AppHandle, binds: serde_json::Value) -> Result<(), String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "shortcuts.json")?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&binds).map_err(|e| e.to_string())?;
        crate::fsutil::atomic_write(&path, json.as_bytes())
    })
    .await
    .map_err(|e| format!("shortcuts save task failed: {e}"))?
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
        // Канонизируем путь через dunce без вербатим-префикса на Windows
        let canon = dunce::canonicalize(&p).map_err(|e| format!("cannot resolve path: {e}"))?;
        let manifest = if canon.is_dir() {
            let m = canon.join("plugin.json");
            let m_canon = dunce::canonicalize(&m).map_err(|e| format!("cannot resolve plugin.json: {e}"))?;
            if !m_canon.starts_with(&canon) {
                return Err("plugin.json symlink escapes plugin directory".into());
            }
            m_canon
        } else if canon.file_name().map(|n| n == "plugin.json").unwrap_or(false) {
            canon
        } else {
            return Err("only plugin.json files can be read".into());
        };
        rejects_sensitive_path(&manifest.to_string_lossy())?;
        let data = crate::fsutil::read_capped_string(&manifest, 0)?;
        let val: serde_json::Value = serde_json::from_str(&data).map_err(|e| format!("plugin.json corrupted: {e}"))?;

        // Проверяем события хуков в манифесте по белому списку разрешённых событий
        if let Some(hooks_arr) = val.get("hooks").and_then(|h| h.as_array()) {
            for h in hooks_arr {
                if let Some(ev) = h.get("event").and_then(|e| e.as_str()) {
                    if !hooks::EVENTS.contains(&ev) {
                        return Err(format!("plugin.json contains invalid hook event: {ev}"));
                    }
                }
            }
        }

        Ok(val)
    })
    .await
    .map_err(|e| format!("plugin read task failed: {e}"))?
}

/// Реестр установленных плагинов (plugins.json)
#[tauri::command(async)]
pub async fn plugins_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "plugins.json")?;
        if !path.exists() {
            return Ok(serde_json::json!({}));
        }
        let data = crate::fsutil::read_capped_string(&path, 0)?;
        serde_json::from_str(&data).map_err(|e| format!("plugins file corrupted: {e}"))
    })
    .await
    .map_err(|e| format!("plugins load task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn plugins_save(app: tauri::AppHandle, file: serde_json::Value) -> Result<(), String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "plugins.json")?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        crate::fsutil::atomic_write(&path, json.as_bytes())
    })
    .await
    .map_err(|e| format!("plugins save task failed: {e}"))?
}

/// Пользовательские slash-команды (commands.json): { commands: [{name, description, template}] }
#[tauri::command(async)]
pub async fn commands_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "commands.json")?;
        if !path.exists() {
            return Ok(serde_json::json!({}));
        }
        let data = crate::fsutil::read_capped_string(&path, 0)?;
        serde_json::from_str(&data).map_err(|e| format!("commands file corrupted: {e}"))
    })
    .await
    .map_err(|e| format!("commands load task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn commands_save(app: tauri::AppHandle, file: serde_json::Value) -> Result<(), String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "commands.json")?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        crate::fsutil::atomic_write(&path, json.as_bytes())
    })
    .await
    .map_err(|e| format!("commands save task failed: {e}"))?
}

/// Конфиг субагентов (subagents.json): { enabled, maxParallel, roles: [...] }
#[tauri::command(async)]
pub async fn subagents_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "subagents.json")?;
        if !path.exists() {
            return Ok(serde_json::json!({}));
        }
        let data = crate::fsutil::read_capped_string(&path, 0)?;
        serde_json::from_str(&data).map_err(|e| format!("subagents file corrupted: {e}"))
    })
    .await
    .map_err(|e| format!("subagents load task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn subagents_save(app: tauri::AppHandle, config: serde_json::Value) -> Result<(), String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "subagents.json")?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        crate::fsutil::atomic_write(&path, json.as_bytes())
    })
    .await
    .map_err(|e| format!("subagents save task failed: {e}"))?
}

/// Цвета моделей в статистике (colors.json): { "<model>": "#rrggbb" }
#[tauri::command(async)]
pub async fn usage_colors_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "colors.json")?;
        if !path.exists() {
            return Ok(serde_json::json!({}));
        }
        let data = crate::fsutil::read_capped_string(&path, 0)?;
        serde_json::from_str(&data).map_err(|e| format!("colors file corrupted: {e}"))
    })
    .await
    .map_err(|e| format!("colors load task failed: {e}"))?
}

#[tauri::command(async)]
pub async fn usage_colors_save(
    app: tauri::AppHandle,
    colors: serde_json::Value,
) -> Result<(), String> {
    // sync-диск, в blocking-пул
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_file(&app, "colors.json")?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&colors).map_err(|e| e.to_string())?;
        crate::fsutil::atomic_write(&path, json.as_bytes())
    })
    .await
    .map_err(|e| format!("colors save task failed: {e}"))?
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

        // читается ТОЛЬКО plugin.json — произвольный файл
        // (в т.ч. broken.json) отвергается по имени
        let broken = dir.join("broken.json");
        std::fs::write(&broken, "{ not json").unwrap();
        let err = tauri::async_runtime::block_on(plugin_read(broken.display().to_string()))
            .expect_err("non-plugin.json must fail");
        assert!(err.contains("only plugin.json"), "неожиданная ошибка: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// plugin_read: валидирует события хуков по белому списку hooks::EVENTS
    #[test]
    fn plugin_read_validates_hook_events() {
        let dir = std::env::temp_dir().join(format!("nocturn-plugins-events-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let file = dir.join("plugin.json");

        // Невалидное событие
        std::fs::write(&file, r#"{"name":"bad","hooks":[{"event":"InvalidEventName","command":"dir"}]}"#).unwrap();
        let err = tauri::async_runtime::block_on(plugin_read(file.display().to_string()))
            .expect_err("invalid hook event must be rejected");
        assert!(err.contains("invalid hook event"), "неожиданная ошибка: {err}");

        // Валидное событие
        std::fs::write(&file, r#"{"name":"good","hooks":[{"event":"PreToolUse","command":"echo 1"}]}"#).unwrap();
        let ok = tauri::async_runtime::block_on(plugin_read(file.display().to_string()))
            .expect("valid hook event must succeed");
        assert_eq!(ok.get("name").and_then(|v| v.as_str()), Some("good"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
