// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod updater;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// Run the helper on the GraphQL origin itself. Fetching from splice.com requires
// a CORS preflight, which Cloudflare can challenge before the search is sent.
// Same-origin requests retain browser security and use the helper's cookies.
const SPLICE_HELPER_LABEL: &str = "splice-helper";
const SPLICE_HELPER_URL: &str = "https://surfaces-graphql.splice.com/graphql";
const SPLICE_HELPER_INIT: &str = include_str!("splice-helper.js");

fn main() {
    // WebKitGTK's DMA-BUF renderer fails on many Linux GPU setups (notably NVIDIA
    // and some Wayland compositors), leaving the window completely blank. Fall
    // back to the older renderer unless the user has explicitly chosen otherwise.
    // This must happen before any threads are spawned (set_var isn't thread-safe).
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Create this before the frontend starts. The config loader and
            // writer can then safely access config.json through the fs plugin.
            std::fs::create_dir_all(app.path().app_config_dir()?)?;

            WebviewWindowBuilder::new(
                app,
                SPLICE_HELPER_LABEL,
                WebviewUrl::External(SPLICE_HELPER_URL.parse().unwrap()),
            )
            .title("splice-helper")
            .visible(false)
            .skip_taskbar(true)
            .initialization_script(SPLICE_HELPER_INIT)
            .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::write_sample_file,
            files::file_exists,
            files::dir_exists,
            files::create_placeholder_file,
            updater::fetch_releases,
            updater::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
