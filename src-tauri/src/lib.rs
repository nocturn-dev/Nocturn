use std::fs;

pub use chat::AbortRegistry;
pub use settings::{ApiProfile, ApiSettings, ProfilesStore};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Жив ли трей. На Linux DE без StatusNotifier (GNOME без AppIndicator,
/// часть Wayland-композиторов) построение трея падает — а «скрыть в трей»
/// без иконки делает приложение недостижимым (Alt+Tab скрытое окно не
/// показывает). hide_to_tray деградирует в minimize, пока флаг false
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

pub mod browser;
pub mod chat;
mod colibri;
mod clipboard;
mod crypto;
pub mod computer;
mod files;
mod fonts;
mod fsutil;
pub mod gguf;
pub mod hooks;
mod importer;
pub mod imagegen;
mod media;
mod memory;
mod websearch;
mod network;
mod telegram;
mod notes;
mod plugins;
mod dictation;
mod settings;
mod tooling;
mod tts;
mod voice;
mod kb;
pub mod lsp;
pub mod mcp;
pub mod mcp_oauth;
mod perm;
#[cfg(target_os = "linux")]
mod portal;
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
        .plugin(tauri_plugin_opener::init())
        .manage(AbortRegistry(Mutex::new(HashMap::new())))
        .manage(pty::PtyRegistry(Mutex::new(HashMap::new())))
        .manage(mcp::McpRegistry::default())
        .manage(browser::BrowserRegistry::default())
        .manage(colibri::ColibriRegistry::default())
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
                // set_config читает CA синхронно и может висеть на UNC-пути
                // до SMB-таймаута: старт окна не должен ждать его
                let cfg: network::NetworkConfig = serde_json::from_value(v).unwrap_or_default();
                std::thread::spawn(move || network::set_config(cfg));
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
            if let Some(v) = read("websearch.json") {
                // Раньше websearch.json писался, но никогда не читался на
                // старте: тумблер и ключи молча сбрасывались каждым рестартом
                websearch::set_config(serde_json::from_value(v).unwrap_or_default());
            }
            if let Some(v) = read("lsp.json") {
                lsp::set_config(serde_json::from_value(v).unwrap_or_default());
            }
            if let Some(v) = read("telegram.json") {
                // Telegram-бот уведомлений: polling стартует только если
                // конфиг enabled (модуль мёртв до явного включения)
                telegram::set_config(serde_json::from_value(v).unwrap_or_default());
                telegram::apply_runtime(app.handle().clone());
            }
            // Сгенерированные картинки показываются в чате через asset-протокол:
            // каталог images разрешается целиком один раз (пишет туда только
            // само приложение) — пофайловое разрешение потребовало бы тянуть
            // AppHandle вглубь execute_tool_inner
            let images_dir = app.path().app_data_dir()?.join("images");
            fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;
            app.asset_protocol_scope()
                .allow_directory(&images_dir, false)
                .map_err(|e| e.to_string())?;
            // Пользовательские шрифты раздаются так же (FontFace на фронте)
            let fonts_dir = app.path().app_data_dir()?.join("fonts");
            fs::create_dir_all(&fonts_dir).map_err(|e| e.to_string())?;
            app.asset_protocol_scope()
                .allow_directory(&fonts_dir, false)
                .map_err(|e| e.to_string())?;
            // Temp-файлы atomic_write, оставшиеся после краха (rename не дошёл),
            // иначе копятся вечно
            if let Ok(entries) = fs::read_dir(&cfg_dir) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') && name.contains(".tmp-") {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
            // Активный авто-лок хранилища: без таймера ключ AES жил в памяти,
            // пока приложение свернуто (ленивая проверка срабатывала только
            // на крипто-операциях). Раз в минуту — свип просроченного ключа;
            // vault_sweep — тот же единый гейт, что и у крипто-операций,
            // без гонки «проверка, затем стирание»
            tauri::async_runtime::spawn(async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    crypto::vault_sweep();
                }
            });
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
            // Трей не критичен для запуска: на Linux DE без StatusNotifier
            // (GNOME без AppIndicator, часть Wayland-композиторов) его
            // построение падает — не разваливаем весь старт приложения
            match build_tray(app.handle()) {
                Ok(()) => TRAY_AVAILABLE.store(true, Ordering::Relaxed),
                Err(e) => eprintln!("tray unavailable: {e}"),
            }
            // Тёмный фон окна/вебвью: дефолт WebView2 — белый, и при ресайзах
            // (maximize/restore) непрокрашенный кадр вспыхивал белым каркасом
            if let Some(w) = app.get_webview_window("main") {
                // #262624 — --halo-bg тёмной темы
                let _ = w.set_background_color(Some(tauri::window::Color(0x26, 0x26, 0x24, 255)));
            }
            // Quick Entry: дефолтное комбо; сохранённый ремап фронт применит
            // на старте через quickentry_set_bind. Провал не критичен: комбо
            // может быть занято другим приложением, а на Wayland-подобных
            // системах глобальные хоткеи недоступны вовсе — статус отдаём
            // фронту (quickentry_status), чтобы он сообщил об этом тостом,
            // а не молчанием
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                // ctrl+shift+space, не ctrl+alt+space: Ctrl+Alt = AltGr на
                // уровне Win32-хоткеев, и на AZERTY дефолт перехватывал
                // AltGr+Space — типографский пробел во ВСЕХ приложениях
                // (аудит A3-6)
                match app.global_shortcut().register("ctrl+shift+space") {
                    Ok(()) => QUICKENTRY_REGISTERED.store(true, Ordering::Relaxed),
                    Err(e) => {
                        QUICKENTRY_REGISTERED.store(false, Ordering::Relaxed);
                        eprintln!("quickentry shortcut unavailable: {e}");
                        // Wayland: XGrabKey недоступен в принципе — пробуем
                        // портал (композитор покажет диалог подтверждения)
                        quickentry_portal_fallback(app.handle(), "ctrl+shift+space");
                    }
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Второй запуск: фокусируем существующее окно вместо открытия
            // копии. Заодно закрывает конфликт cleanup_browser_profiles,
            // когда два экземпляра чистили профили друг друга
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                // show обязателен: скрытое (close-to-tray) окно unminimize+focus
                // не возвращает — второй запуск был единственным способом
                // поднять его, и тот тоже молчал
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Автозапуск с ОС (тумблер в «Основном»): Windows — реестр Run,
        // macOS — LaunchAgent, Linux — .desktop в autostart
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Quick Entry: глобальное комбо показывает/прячет окно быстрого ввода
        // у верхнего края экрана (любое приложение → одна задача, Enter)
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Handler зовётся и на Pressed, и на Released: toggle
                    // только по нажатию, иначе окно гасло на отпускании
                    // клавиши — появлялось на миг и исчезало
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_quickentry(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            clipboard::clipboard_write,
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
            settings::chat_export_write,
            settings::settings_import_read,
            settings::config_toml_import,
            importer::import_fetch_url,
            chat::test_connection,
            chat::chat_once,
            chat::chat_stream,
            chat::chat_abort,
            chat::detect_local_runtimes,
            gguf::gguf_pull,
            gguf::gguf_export,
            gguf::gguf_cut,
            gguf::gguf_cancel,
            gguf::gguf_lab_files,
            gguf::gguf_inspect,
            gguf::gguf_llama_status,
            gguf::gguf_llama_set_path,
            gguf::gguf_serve_start,
            gguf::gguf_serve_stop,
            gguf::gguf_llama_download,
            gguf::gguf_ollama_import,
            tooling::load_sessions,
            tooling::load_project_sessions,
            tooling::save_project_sessions,
            tooling::save_sessions,
            tooling::ambient_video_register,
            tooling::run_tool,
            tooling::get_tool_schemas,
            tooling::perm_set,
            tooling::browser_get_config,
            tooling::browser_set_config,
            tooling::computer_get_config,
            tooling::computer_set_config,
            tooling::imagegen_get_config,
            tooling::imagegen_set_config,
            tooling::websearch_get_config,
            tooling::websearch_set_config,
            tooling::lsp_get_config,
            tooling::lsp_set_config,
            telegram::telegram_get_config,
            telegram::telegram_set_config,
            telegram::telegram_status,
            telegram::telegram_unbind,
            telegram::telegram_notify,
            fonts::font_import,
            fonts::font_list,
            fonts::font_delete,
            tooling::wallpaper_register,
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
            files::git_branch_diff,
            files::project_rules_read,
            files::checkpoint_save,
            files::checkpoint_list,
            files::checkpoint_files,
            files::checkpoint_restore,
            files::checkpoint_delete,
            files::git_autocommit,
            fsutil::storage_stats,
            fsutil::storage_cleanup,
            open_file_external,
            media::media_status,
            media::media_control,
            media::lyrics_fetch,
            memory::memory_list,
            memory::memory_add,
            memory::memory_delete,
            memory::memory_clear,
            dictation::dictation_status,
            dictation::dictation_set_config,
            dictation::dictation_download_model,
            dictation::dictation_transcribe,
            tts::tts_speak,
            tts::tts_stop,
            tts::audio_outputs,
            kb::kb_create,
            kb::kb_list,
            kb::kb_delete,
            kb::kb_add_document,
            kb::kb_remove_document,
            kb::kb_documents,
            kb::kb_query,
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
            mcp_oauth::mcp_oauth_authorize,
            mcp_oauth::mcp_oauth_revoke,
            network::network_get_config,
            network::network_set_config,
            voice::voice_status,
            voice::voice_download_models,
            voice::voice_read_model,
            hide_to_tray,
            set_tray_variant,
            quickentry_set_bind,
            quickentry_status,
            quickentry_submit,
            window_toggle_maximize,
            window_toggle_fullscreen,
            factory_reset,
            colibri::colibri_start,
            colibri::colibri_stop,
            colibri::colibri_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Гасим дочерние MCP/PTY/браузерные процессы при выходе,
            // чтобы не оставлять сирот; заодно чистим temp-профили браузера
            // Главное окно закрыли (крестик без «скрывать в трей») — выходим.
            // Без этого: скрытое окно quickentry держало процесс живым, в трее
            // оставалась «зомби»-иконка с нерабочим Open Nocturn
            if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
                if label == "main" {
                    // Destroyed — реальное закрытие окна (hide в трей им не является)
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        app.exit(0);
                    }
                    // Во время «затмения» topmost держится ТОЛЬКО при фокусе:
                    // постоянный always-on-top накрывал собой приложения,
                    // выбранные через ALT+TAB/панель задач.
                    // ФИКС (фидбек 29.09, «Alt+Tab и Win+D не работают, пока
                    // Nocturn на фоне»): tao-шный set_always_on_top на Windows
                    // ставит z-порядок БЕЗ SWP_NOACTIVATE — HWND_NOTOPMOST/
                    // HWND_TOPMOST АКТИВИРУЮТ окно → каждое переключение фокуса
                    // дёргало активацию, окно воровало фокус обратно, петля:
                    // «вообще никак не уйти». Теперь z-порядок меняем сырым
                    // SetWindowPos c SWP_NOACTIVATE и только при реальной смене
                    // состояния — активация не дёргается, петли нет
                    if let tauri::WindowEvent::Focused(focused) = event {
                        let eclipsed = FS_SAVE
                            .lock()
                            .map(|s| s.is_some())
                            .unwrap_or(false);
                        if eclipsed {
                            if let Some(w) = app.get_webview_window("main") {
                                #[cfg(windows)]
                                {
                                    if let Ok(hwnd) = w.hwnd() {
                                        set_topmost_noactivate(hwnd.0 as isize, *focused);
                                    }
                                    // Win+D сворачивает окно и в «затмении»: topmost
                                    // shell не защищает. При восстановлении tao
                                    // прикладывает протухшую внутреннюю геометрию —
                                    // вместо монитора появляется маленькое окно с
                                    // чёрным кадром, drag в котором «прыгает» по
                                    // столу. Целевые границы хранит FS_MON —
                                    // возвращаем их на первом же фокусе
                                    if *focused && !w.is_minimized().unwrap_or(true) {
                                        let target = FS_MON
                                            .lock()
                                            .unwrap_or_else(|p| p.into_inner())
                                            .as_ref()
                                            .copied();
                                        if let Some(full) = target {
                                            if let Ok(hwnd) = w.hwnd() {
                                                let hwnd = hwnd.0 as isize;
                                                let cur =
                                                    window_rect(&w).unwrap_or((0, 0, 0, 0));
                                                let (fx, fy, fcx, fcy) =
                                                    expand_by_borders(&w, full);
                                                if cur != (fx, fy, fcx, fcy) {
                                                    set_window_bounds(hwnd, fx, fy, fcx, fcy);
                                                    nudge_window(&w);
                                                }
                                            }
                                        }
                                    }
                                }
                                #[cfg(not(windows))]
                                {
                                    let _ = w.set_always_on_top(*focused);
                                }
                            }
                        }
                    }
                }
            }
            if let tauri::RunEvent::Exit = &event {
                if let Some(registry) = app.try_state::<mcp::McpRegistry>() {
                    registry.kill_all();
                }
                if let Some(registry) = app.try_state::<pty::PtyRegistry>() {
                    registry.kill_all();
                }
                if let Some(registry) = app.try_state::<browser::BrowserRegistry>() {
                    registry.kill_all();
                }
                if let Some(registry) = app.try_state::<colibri::ColibriRegistry>() {
                    colibri::kill_on_exit(&registry);
                }
                tts::kill_on_exit();
                lsp::kill_all();
                // GGUF-сессия — static вне реестров: без этого llama-server
                // переживал приложение с моделью в памяти (аудит 07.10 A1-11)
                gguf::kill_session_on_exit();
                cleanup_browser_profiles();
            }
        });
}


static TRAY_BOLD: &[u8] = include_bytes!("../icons/tray-bold.png");
static TRAY_CLASSIC: &[u8] = include_bytes!("../icons/tray-classic.png");

/// Сменить иконку трея (Кастомизация → знак приложения: bold/classic)
#[tauri::command]
fn set_tray_variant(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    
    let bytes: &[u8] = if kind == "classic" {
        TRAY_CLASSIC
    } else {
        TRAY_BOLD
    };
    let img = tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("nocturn-tray") {
        tray.set_icon(Some(img)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// «Скрывать в трей»: крестик и системная кнопка закрытия прячут окно;
/// настоящий выход — из меню трея (там RunEvent::Exit гасит дочерние процессы).
/// Если трея нет (см. TRAY_AVAILABLE) — сворачиваем вместо скрытия: окно
/// остаётся достижимым через таскбар
#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        if !TRAY_AVAILABLE.load(Ordering::Relaxed) {
            return w.minimize().map_err(|e| e.to_string());
        }
        w.hide().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Открыть файл системным приложением (кнопка Open в карточке изменений,
/// стиль референса). Относительный путь fs_write резолвится от корня проекта.
/// Гардал пути — тот же rejects_sensitive_path: системные локации не
/// открываем; файлы проекта агента — легитимная пользовательская цель.
/// Команда, а не прямое opener-разрешение вебвью: capability opener:default
/// остаётся только на http/https — вебвью не получает право открыть
/// произвольный путь.
/// mode: "open" (дефолт) — системное приложение; "explorer" — показать в
/// папке (Проводник с выделением); "vscode" — открыть в VS Code
/// (`code <path>`, честная ошибка если не установлен)
#[tauri::command(async)]
async fn open_file_external(
    app: tauri::AppHandle,
    root: Option<String>,
    path: String,
    mode: Option<String>,
) -> Result<(), String> {
    let owned;
    let target: &std::path::Path = {
        let p = std::path::Path::new(&path);
        if p.is_absolute() {
            p
        } else {
            let root = root
                .filter(|r| !r.trim().is_empty())
                .ok_or("relative path without project root")?;
            owned = std::path::Path::new(root.trim()).join(&path);
            &owned
        }
    };
    crate::settings::rejects_sensitive_path(&target.to_string_lossy())?;
    let mode = mode.as_deref().unwrap_or("open").to_string();
    let target_str = target.to_string_lossy().to_string();
    let app2 = app.clone();
    // is_file + запуск процесса/открытие — блокирующие вызовы (до 20 с на
    // тупящем `code`-шиме): в blocking-пул, а не на воркер tokio
    // (класс b451fd4, аудит A1-6)
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // VS Code открывает и несуществующий путь (новый файл) — проверка
        // существования только для open/explorer
        if mode != "vscode" && !std::path::Path::new(&target_str).is_file() {
            return Err(format!("file does not exist: {target_str}"));
        }
        match mode.as_str() {
            "explorer" => {
                // Показать файл в папке: Проводник с выделением (Windows),
                // Reveal в Finder (macOS), xdg-open каталога (Linux)
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let mut c = std::process::Command::new("explorer");
                    // /select, требует запятую и обратные слэши
                    c.raw_arg(format!("/select,\"{}\"", target_str.replace('/', "\\")));
                    crate::proc::run_command_opts(&mut c, std::time::Duration::from_secs(10), None, None)
                        .map_err(|e| format!("explorer failed: {e}"))?;
                    Ok(())
                }
                #[cfg(target_os = "macos")]
                {
                    let mut c = std::process::Command::new("open");
                    c.arg("-R").arg(&target_str);
                    crate::proc::run_command_opts(&mut c, std::time::Duration::from_secs(10), None, None)
                        .map_err(|e| format!("reveal failed: {e}"))?;
                    Ok(())
                }
                #[cfg(all(unix, not(target_os = "macos")))]
                {
                    let dir = std::path::Path::new(&target_str)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| target_str.clone());
                    let mut c = std::process::Command::new("xdg-open");
                    c.arg(&dir);
                    crate::proc::run_command_opts(&mut c, std::time::Duration::from_secs(10), None, None)
                        .map_err(|e| format!("xdg-open failed: {e}"))?;
                    Ok(())
                }
            }
            "vscode" => {
                // `code` — .cmd-шим на Windows: только через cmd /C с raw_arg
                // (конвенция проекта). Не установлен — честная ошибка наружу
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    let mut c = std::process::Command::new("cmd");
                    c.args(["/C"])
                        .raw_arg(format!("code \"{}\"", target_str.replace('"', "")))
                        .creation_flags(CREATE_NO_WINDOW);
                    crate::proc::run_command_opts(&mut c, std::time::Duration::from_secs(20), None, None)
                        .map_err(|e| format!("vscode failed: {e}"))?;
                    Ok(())
                }
                #[cfg(not(windows))]
                {
                    let mut c = std::process::Command::new("code");
                    c.arg(&target_str);
                    crate::proc::run_command_opts(&mut c, std::time::Duration::from_secs(20), None, None)
                        .map_err(|e| format!("vscode failed: {e}"))?;
                    Ok(())
                }
            }
            _ => {
                use tauri_plugin_opener::OpenerExt;
                app2.opener()
                    .open_path(target_str, None::<String>)
                    .map_err(|e| e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("open task failed: {e}"))?
}

/// Развернуть/свернуть главное окно. Нативный maximize: DWM сам играет
/// плавную анимацию (морфит старый кадр — вебвью не перерисовывается в полёте).
/// Известный хвост (tao#471, WebView2Feedback#2549): после выхода из
/// maximized-состояния WebView2/shell иногда остаются со старой геометрией —
/// чёрная полоса на месте таскбара, съехавший контент. Лечится одноразовым
/// nudge: сдвиг на 1px заставляет всё перерисоваться в правильных границах
#[tauri::command(async)]
fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let w = app.get_webview_window("main").ok_or("main window not found")?;
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    // Кнопка maximize во время «затмения» — возвращаем прежнюю геометрию
    if FS_SAVE.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        return window_toggle_fullscreen(app);
    }
    if w.is_maximized().unwrap_or(false) {
        w.unmaximize().map_err(|e| e.to_string())?;
        nudge_window(&w);
        return Ok(());
    }
    w.maximize().map_err(|e| e.to_string())
}

/// «Затмение» (F11) на Windows: окно накрывает ВЕСЬ монитор, включая область
/// панели задач — shell сам прячет таскбар для сфокуссированного окна в
/// границах монитора (как у borderless-игр). НИКАКОЙ native fullscreen:
/// set_fullscreen на безрамочных окнах Windows бит апстримом (tauri#7473/
/// #7328/#8383 — таскбар не прячется, размеры теряются, циклы ломаются).
/// Вне Windows используется штатный set_fullscreen (см. вторую ветку ниже)
/// Прежние границы окна (x, y, ширина, высота) + был ли нативно развёрнут
type SavedBounds = ((i32, i32, i32, i32), bool);
static FS_SAVE: Mutex<Option<SavedBounds>> = Mutex::new(None);

/// Прямоугольник монитора, накрытого «затмением»: Focused-хук лечит
/// геометрию после Win+D-минимизации по нему (монитор из MonitorFromWindow
/// после сломанного restore не годится — окно может лежать на другом экране)
#[cfg(windows)]
static FS_MON: Mutex<Option<WinRect>> = Mutex::new(None);

/// Текущее topmost-состояние главного окна в «затмении»: guard, чтобы
/// Focused-хук не дёргал SetWindowPos при каждом событии без смены значения
#[cfg(windows)]
static ECLIPSE_TOPMOST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// z-порядок БЕЗ активации окна: tao-шный set_always_on_top ставит
/// HWND_TOPMOST/NOTOPMOST без SWP_NOACTIVATE, а этиplacement-константы
/// АКТИВИРУЮТ окно — переключение фокуса в «затмении» запускало петлю
/// воровства фокуса (Alt+Tab/Win+D «не работали»)
#[cfg(windows)]
fn set_topmost_noactivate(hwnd: isize, topmost: bool) {
    use std::sync::atomic::Ordering;
    if ECLIPSE_TOPMOST.load(Ordering::Relaxed) == topmost {
        return;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: isize,
            after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    const HWND_TOPMOST: isize = -1;
    const HWND_NOTOPMOST: isize = -2;
    const SWP_NOSIZE: u32 = 0x1;
    const SWP_NOMOVE: u32 = 0x2;
    const SWP_NOACTIVATE: u32 = 0x10;
    unsafe {
        SetWindowPos(
            hwnd,
            if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST },
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
    ECLIPSE_TOPMOST.store(topmost, Ordering::Relaxed);
}

/// Синхронизировать guard при входе/выходе из «затмения» (там topmost
/// выставляется через set_always_on_top — guard обязан знать значение)
#[cfg(windows)]
fn sync_eclipse_topmost(topmost: bool) {
    use std::sync::atomic::Ordering;
    ECLIPSE_TOPMOST.store(topmost, Ordering::Relaxed);
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

/// Полная и рабочая области монитора, где находится окно.
/// #[cfg(windows)] обязателен: #[link] уходит линкеру безусловно, и без
/// гейта сборка на macOS/Linux падала на «library not found for -luser32»
#[cfg(windows)]
fn monitor_rects(hwnd: isize) -> Result<(WinRect, WinRect), String> {
    #[link(name = "user32")]
    extern "system" {
        fn MonitorFromWindow(hwnd: isize, dw_flags: u32) -> isize;
        fn GetMonitorInfoW(h_monitor: isize, lpmi: *mut MonitorInfoW) -> i32;
    }
    #[repr(C)]
    struct MonitorInfoW {
        cb_size: u32,
        rc_monitor: WinRect,
        rc_work: WinRect,
        dw_flags: u32,
    }
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    let mut mi = MonitorInfoW {
        cb_size: std::mem::size_of::<MonitorInfoW>() as u32,
        rc_monitor: WinRect::default(),
        rc_work: WinRect::default(),
        dw_flags: 0,
    };
    let ok = unsafe { GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut mi) };
    if ok == 0 {
        return Err("failed to query monitor info".to_string());
    }
    Ok((mi.rc_monitor, mi.rc_work))
}

/// Атомарный move+size одним SetWindowPos: раздельные set_position/set_size
/// дают два разрыва кадра
#[cfg(windows)]
fn set_window_bounds(hwnd: isize, x: i32, y: i32, cx: i32, cy: i32) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    const SWP_NOZORDER: u32 = 0x4;
    const SWP_NOACTIVATE: u32 = 0x10;
    unsafe {
        SetWindowPos(hwnd, 0, x, y, cx.max(1), cy.max(1), SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

#[cfg(windows)]
fn window_rect(w: &tauri::WebviewWindow) -> Result<(i32, i32, i32, i32), String> {
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    Ok((pos.x, pos.y, size.width as i32, size.height as i32))
}

#[cfg(windows)]
#[tauri::command(async)]
fn window_toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let w = app.get_webview_window("main").ok_or("main window not found")?;
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    let hwnd = w.hwnd().map_err(|e| e.to_string())?.0 as isize;

    // Выход из «затмения»: назад к прежним границам (и в maximize, если
    // оттуда пришли)
    let saved = FS_SAVE.lock().unwrap_or_else(|p| p.into_inner()).take();
    FS_MON.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(((x, y, cx, cy), was_max)) = saved {
        if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
        }
        let _ = w.set_always_on_top(false);
        sync_eclipse_topmost(false);
        set_window_bounds(hwnd, x, y, cx, cy);
        if was_max {
            let _ = w.maximize();
        }
        nudge_window(&w);
        return Ok(());
    }

    // Вход: сохранить состояние и накрыть ВЕСЬ монитор. Топмост обязателен:
    // панель задач — тоже topmost, обычное окно под неё не заходит («ЗА
    // таскбаром»). Невидимые DWM-границы безрамочного окна (shadow) дают
    // видимые отступы по бокам — компенсируем их расширением цели
    let (full, _work) = monitor_rects(hwnd)?;
    *FS_MON.lock().unwrap_or_else(|p| p.into_inner()) = Some(full);
    let from = window_rect(&w)?;
    let was_max = w.is_maximized().unwrap_or(false);
    *FS_SAVE.lock().unwrap_or_else(|p| p.into_inner()) = Some((from, was_max));
    if was_max {
        let _ = w.unmaximize();
    }
    let _ = w.set_always_on_top(true);
    sync_eclipse_topmost(true);
    // Прыжок одним атомарным SetWindowPos. Живой ресайз шагами заставляет
    // WebView2 догонять окно (смаз/тёмные края в каждом кадре — «нескриншот-
    // еляемые» артефакты); DWM на одиночном прыжке просто растягивает старый
    // кадр на 1-2 кадра — чисто
    let (fx, fy, fcx, fcy) = expand_by_borders(&w, full);
    set_window_bounds(hwnd, fx, fy, fcx, fcy);
    Ok(())
}

/// F11 вне Windows: native borderless fullscreen. Win32-«затмение» — чисто
/// Windows-паттерн (таскбар-поведение tauri#7473 не применимо), а штатный
/// set_fullscreen на macOS/Linux корректно прячет док/панели и не требует
/// ручной геометрии. FS_SAVE остаётся пустым: Focused-хук и toggle_maximize
/// на его is_some() просто работают в штатном режиме
#[cfg(not(windows))]
#[tauri::command(async)]
fn window_toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let w = app.get_webview_window("main").ok_or("main window not found")?;
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    // Tauri 2: fullscreen() переименован в is_fullscreen(), set_fullscreen
    // принимает bool, а не Option<Fullscreen>
    let active = w.is_fullscreen().map_err(|e| e.to_string())?;
    w.set_fullscreen(!active).map_err(|e| e.to_string())
}

/// Невидимые DWM-границы безрамочного окна (outer - inner), чтобы видимый
/// контент накрыл монитор вплотную
#[cfg(windows)]
fn expand_by_borders(
    w: &tauri::WebviewWindow,
    full: WinRect,
) -> (i32, i32, i32, i32) {
    let outer = w.outer_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or((0, 0));
    let inner = w.inner_size().map(|s| (s.width as i32, s.height as i32)).unwrap_or(outer);
    let bx = ((outer.0 - inner.0) / 2).max(0);
    let by = ((outer.1 - inner.1) / 2).max(0);
    (
        full.left - bx,
        full.top - by,
        (full.right - full.left) + bx * 2,
        (full.bottom - full.top) + by * 2,
    )
}

/// Одноразовый сдвиг на 1px и обратно: перерисовка вебвью и панели задач
/// после смены maximized-состояния. Пауза между сдвигами живёт в отдельном
/// потоке: sleep на потоке event loop замораживал окно на кадр при каждом
/// возврате фокуса (класс «sleep в UI-потоке»)
fn nudge_window(w: &tauri::WebviewWindow) {
    let Ok(pos) = w.outer_position() else { return };
    let _ = w.set_position(tauri::PhysicalPosition::new(pos.x + 1, pos.y));
    let w = w.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(16));
        let _ = w.set_position(pos);
    });
}

/// Quick Entry у верхнего центра монитора под курсором. Окно без декораций,
/// позиция из конфига не годится — геометрию экрана знаем только в рантайме.
/// current_monitor() самого (скрытого) окна не годится: в мультимониторной
/// конфигурации окно всегда всплывало на одном и том же экране
fn position_quickentry(app: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    let monitor = app.cursor_position().ok().and_then(|pos| {
        app.available_monitors().ok().and_then(|ms| {
            ms.into_iter().find(|m| {
                let p = m.position();
                let s = m.size();
                let (cx, cy) = (pos.x.round() as i32, pos.y.round() as i32);
                cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
            })
        })
    });
    let Some(m) = monitor.or_else(|| w.current_monitor().ok().flatten()) else { return };
    // Аудит: LogicalPosition конвертируется tao по scale ОКНА, а не целевого
    // монитора, и без m.position() точка уходила в глобальные координаты —
    // на втором мониторе окно всплывало top-center primary. Считаем в
    // ФИЗИЧЕСКИХ пикселях целевого монитора: размер окна переводим в
    // логические величины по scale самого окна, затем в физику монитора
    let win_scale = w.scale_factor().unwrap_or_else(|_| m.scale_factor());
    let ww_logical = w
        .inner_size()
        .map(|s| s.width as f64 / win_scale)
        .unwrap_or(540.0);
    let target_scale = m.scale_factor();
    let ww_phys = (ww_logical * target_scale).round() as i32;
    let x = m.position().x + (m.size().width as i32 - ww_phys).max(0) / 2;
    let y = m.position().y + (80.0 * target_scale).round() as i32;
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Зарегистрирован ли сейчас глобальный комбо Quick Entry (setup/ремап):
/// на Wayland-подобных системах регистрация проваливается — фронт по
/// quickentry_status сообщит пользователю вместо тишины
static QUICKENTRY_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Показ/скрытие Quick Entry по глобальному комбо
fn toggle_quickentry(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("quickentry") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            position_quickentry(app, &w);
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// Ремап комбо Quick Entry (MainSection → запись в «Основном»).
/// Строку парсит плагин: парсер case-insensitive, формат "ctrl+shift+space"
#[tauri::command]
fn quickentry_set_bind(app: tauri::AppHandle, combo: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    match gs.register(combo.as_str()) {
        Ok(()) => {
            QUICKENTRY_REGISTERED.store(true, Ordering::Relaxed);
            Ok(())
        }
        Err(e) => {
            // unregister_all сорвал и прежнее комбо: возвращаем дефолт,
            // иначе хоткей умирал до рестарта (а фронт был уверен в обратном).
            // Дефолт дублируется строкой — держать синхронно с setup выше
            let restored = gs.register("ctrl+shift+space").is_ok();
            QUICKENTRY_REGISTERED.store(restored, Ordering::Relaxed);
            // Wayland: плагин не смог — пробуем портал для нового комбо
            // (одобренный раньше триггер композитор переспрашивать не будет)
            if !restored {
                quickentry_portal_fallback(&app, &combo);
            }
            Err(format!("combo busy: {e}"))
        }
    }
}

/// Зарегистрирован ли сейчас глобальный комбо Quick Entry. На Wayland-подобных
/// системах регистрация проваливается в setup молча — фронт на старте читает
/// статус и сообщает пользователю тостом вместо вечной тишины
#[tauri::command(async)]
fn quickentry_status() -> bool {
    QUICKENTRY_REGISTERED.load(Ordering::Relaxed)
}

/// Портальная попытка для Wayland: только там, где она вообще имеет смысл.
/// На остальных ОС — no-op (плагин global-shortcut покрывает все случаи).
#[cfg(target_os = "linux")]
fn quickentry_portal_fallback(app: &tauri::AppHandle, combo: &str) {
    if portal::wayland_session() {
        portal::start(app.clone(), combo.to_string());
    }
}

#[cfg(not(target_os = "linux"))]
fn quickentry_portal_fallback(_app: &tauri::AppHandle, _combo: &str) {}

/// Enter в Quick Entry: спрятать окно, сфокусировать главное и отдать ему
/// текст новой задачи (через событие — паттерн clear-data-request)
#[tauri::command]
fn quickentry_submit(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    if let Some(w) = app.get_webview_window("quickentry") {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    app.emit_to("main", "quickentry-task", text)
        .map_err(|e| e.to_string())
}

/// Трей: иконка (иконка приложения), левый клик — показать окно,
/// меню: Открыть / Clear All Data / Выход
fn build_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{Emitter, Manager};

    let open = MenuItem::with_id(app, "open", "Open Nocturn", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let clear = MenuItem::with_id(app, "clear-data", "Clear All Data…", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open, &sep, &clear, &sep, &quit])
        .map_err(|e| e.to_string())?;

    let mut tray = TrayIconBuilder::with_id("nocturn-tray")
        .menu(&menu)
        .tooltip("Nocturn")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            match id.as_str() {
                "open" | "clear-data" => {
                    if let Some(w) = app.get_webview_window("main") {
                        // Форс-показ: show+unminimize иногда недостаточно —
                        // окно всплывает за другими окнами (foreground-lock
                        // Windows). Классический приём: мигнуть always-on-top
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_always_on_top(true);
                        let _ = w.set_always_on_top(false);
                        let _ = w.set_focus();
                    }
                    if id == "clear-data" {
                        // Деструктив сам по себе не исполняется: окно показано,
                        // подтверждение — через clear-data-request (ResetConfirmModal)
                        let _ = app.emit("clear-data-request", ());
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            }
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
                    let _ = w.unminimize();
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

/// Полный сброс «Clear All Data»: стирает каталоги пользовательских данных
/// (конфиги, чаты, профили, заметки, картинки, звуки, чекпоинты, vault) и
/// перезапускает приложение в заводское состояние. Разрушающая операция —
/// требует серверного подтверждения confirm="RESET" (паритет с crypto_reset):
/// единственная фронтовая модалка — недостаточный барьер для необратимого
/// стирания всей локальной копии данных.
#[tauri::command(async)]
async fn factory_reset(app: tauri::AppHandle, confirm: Option<String>) -> Result<(), String> {
    if confirm.as_deref() != Some("RESET") {
        return Err("confirmation required: pass confirm=\"RESET\" to wipe all local data".into());
    }
    use tauri::Manager;
    let app2 = app.clone();
    // remove_dir_all гигабайтных данных (images не ограничен по размеру) на
    // сетевом профиле — минуты блокировки: в blocking-пул, не на воркер
    // tokio (класс b451fd4, аудит A1-6)
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut roots = Vec::new();
        if let Ok(d) = app2.path().app_config_dir() {
            roots.push(d);
        }
        if let Ok(d) = app2.path().app_data_dir() {
            // На Windows каталоги совпадают — второй прогон увидит несуществующий
            roots.push(d);
        }
        for d in roots {
            if d.exists() {
                fs::remove_dir_all(&d).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("factory reset task failed: {e}"))??;
    // Не возвращает: процесс перезапускается, фронт стартует с онбординга
    app.restart();
}

/// Удаление временных профилей браузера: на каждый запуск создаётся
/// haloui-browser-{uuid} в %TEMP% (uuid вместо порта — см. browser.rs),
/// при успешной сессии он не удалялся — накапливались сотни мегабайт.
/// Вызывается на выходе приложения.
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
