// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod logging;
#[cfg(target_os = "macos")]
mod macos;
mod restore;
mod updater;

use tauri::webview::PageLoadEvent;
use tauri::{Listener, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// The label Tauri gives to the window defined in `tauri.conf.json`.
#[cfg(target_os = "macos")]
const MAIN_LABEL: &str = "main";

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

    logging::install_panic_hook();

    tauri::Builder::default()
        // Needs to come first, so that the other plugins can log.
        .plugin(logging::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .on_page_load(|webview, payload| {
            // A page load of the main window that isn't the first one means that the
            // webview was reloaded, or that its process crashed and got restarted.
            log::info!(
                "[{}] page load {}: {}",
                webview.label(),
                match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                },
                logging::strip_query(payload.url().as_str())
            );
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(focused) => log::debug!("[{}] focused: {focused}", window.label()),
            #[cfg(target_os = "macos")]
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_LABEL => {
                log::info!("[{}] close requested, hiding", window.label());
                api.prevent_close();
                macos::hide_main_window(window);
            }
            WindowEvent::CloseRequested { .. } => log::info!("[{}] close requested", window.label()),
            WindowEvent::Destroyed => log::info!("[{}] destroyed", window.label()),
            _ => {}
        })
        .setup(|app| {
            logging::start_session(app.handle());

            // This must be listened for before the helper is created.
            app.listen("splice-helper-log", |event| logging::log_helper_message(event.payload()));

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
            restore::restore_sample,
            updater::fetch_releases,
            updater::install_update,
            logging::write_log_entries,
            logging::set_verbose_logging,
            logging::list_log_files,
            logging::read_log_file,
            logging::open_log_dir
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows, .. } => {
                log::info!("reopened (has visible windows: {has_visible_windows})");
                if !has_visible_windows {
                    macos::show_main_window(_app);
                }
            }
            RunEvent::Exit => {
                log::info!("exiting");
                log::logger().flush();
            }
            _ => {}
        });
}
