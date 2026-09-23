use std::fs;

pub use chat::AbortRegistry;
pub use settings::{ApiProfile, ApiSettings, ProfilesStore};

use std::collections::HashMap;
use std::sync::Mutex;

pub mod browser;
pub mod chat;
mod crypto;
pub mod computer;
mod files;
pub mod hooks;
pub mod imagegen;
mod network;
mod notes;
mod plugins;
mod settings;
mod tooling;
pub mod mcp;
mod perm;
mod proc;
mod pty;
mod tools;


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
            if let Some(v) = read("network.json") {
                network::set_config(serde_json::from_value(v).unwrap_or_default());
            }
            if let Some(v) = read("browser.json") {
                browser::set_config(serde_json::from_value(v).unwrap_or_default());
            }
            if let Some(v) = read("computer.json") {
                computer::set_config(serde_json::from_value(v).unwrap_or_default());
            }
            if let Some(v) = read("imagegen.json") {
                // Ключ может быть зашифрован (vault): расшифровка ленивая —
                // в generate()/imagegen_get_config, когда хранилище уже разблокировано
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
            build_tray(app.handle())?;
            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            settings::load_profiles,
            settings::save_profiles,
            settings::set_key_encryption,
            settings::crypto_status,
            settings::crypto_setup,
            settings::crypto_unlock,
            settings::crypto_reset,
            settings::load_projects,
            settings::save_projects,
            settings::settings_read_all,
            settings::settings_write_all,
            settings::settings_export_write,
            settings::settings_import_read,
            chat::test_connection,
            chat::chat_stream,
            chat::chat_abort,
            chat::detect_ollama,
            tooling::load_sessions,
            tooling::save_sessions,
            tooling::run_tool,
            tooling::get_tool_schemas,
            tooling::perm_set,
            tooling::perm_get,
            tooling::browser_get_config,
            tooling::browser_set_config,
            tooling::computer_get_config,
            tooling::computer_set_config,
            tooling::imagegen_get_config,
            tooling::imagegen_set_config,
            tooling::sound_import,
            tooling::sound_data,
            tooling::sound_delete,
            tooling::keep_awake,
            tooling::browser_view_start,
            tooling::browser_view_stop,
            tooling::browser_view_size,
            plugins::hooks_load,
            plugins::hooks_save,
            plugins::hooks_test,
            plugins::hooks_run_event,
            plugins::shortcuts_load,
            plugins::shortcuts_save,
            plugins::usage_colors_load,
            plugins::usage_colors_save,
            plugins::subagents_load,
            plugins::subagents_save,
            plugins::commands_load,
            plugins::commands_save,
            plugins::plugin_read,
            plugins::plugins_load,
            plugins::plugins_save,
            files::list_dir,
            files::git_status,
            files::checkpoint_save,
            files::checkpoint_list,
            files::checkpoint_restore,
            files::checkpoint_delete,
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            notes::notes_list,
            notes::notes_read,
            notes::notes_write,
            notes::notes_delete,
            mcp::mcp_list_servers,
            mcp::mcp_save_servers,
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_status,
            mcp::mcp_autoconnect,
            network::network_get_config,
            network::network_set_config,
            hide_to_tray
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Гасим дочерние MCP/PTY/браузерные процессы при выходе,
            // чтобы не оставлять сирот; заодно чистим temp-профили браузера
            if let tauri::RunEvent::Exit = event {
                if let Some(registry) = app.try_state::<mcp::McpRegistry>() {
                    registry.kill_all();
                }
                if let Some(registry) = app.try_state::<pty::PtyRegistry>() {
                    registry.kill_all();
                }
                if let Some(registry) = app.try_state::<browser::BrowserRegistry>() {
                    registry.kill_all();
                }
                cleanup_browser_profiles();
            }
        });
}


/// «Скрывать в трей»: крестик и системная кнопка закрытия прячут окно;
/// настоящий выход — из меню трея (там RunEvent::Exit гасит дочерние процессы)
#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Трей: иконка (иконка приложения), левый клик — показать окно,
/// меню: Открыть / Выход
fn build_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Manager;

    let open = MenuItem::with_id(app, "open", "Open Nocturn", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open, &quit]).map_err(|e| e.to_string())?;

    let mut tray = TrayIconBuilder::with_id("nocturn-tray")
        .menu(&menu)
        .tooltip("Nocturn")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

/// Удаление временных профилей браузера: на каждый запуск создаётся
/// haloui-browser-{port} в %TEMP%, при успешной сессии он не удалялся —
/// накапливались сотни мегабайт. Вызывается на выходе приложения.
fn cleanup_browser_profiles() {
    let tmp = std::env::temp_dir();
    if let Ok(entries) = fs::read_dir(&tmp) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("haloui-browser-") {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
}











#[cfg(test)]
mod tests {
    use super::*;

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
}
