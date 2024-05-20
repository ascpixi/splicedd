

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            files::write_sample_file,
            files::file_exists,
            files::create_placeholder_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
