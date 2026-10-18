// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nocturn_lib::app_log::init_early_panic_hook();
    nocturn_lib::run()
}
