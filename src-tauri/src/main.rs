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

// Splice's GraphQL endpoint sits behind Cloudflare Bot Management, which rejects
// any client whose TLS/HTTP2 fingerprint isn't a real browser (Tauri's built-in
// HTTP client included). The only thing Cloudflare reliably accepts is an actual
// browser, and a browser fetch also needs to run from an origin Splice's CORS
// allows -- which is splice.com itself.
//
// So we spawn a hidden webview pointed at splice.com. Once it has passed
// Cloudflare's browser check, it can `fetch()` the GraphQL endpoint same-site,
// and it relays requests/responses to and from the main window over Tauri events.
// See `capabilities/splice-helper.json` for the (event-only) permissions this
// remote webview is granted.
const SPLICE_HELPER_LABEL: &str = "splice-helper";
const SPLICE_HELPER_URL: &str = "https://splice.com/sounds/search/samples";

const SPLICE_HELPER_INIT: &str = r#"
(function () {
  if (window.__spliceHelperReady) return;
  window.__spliceHelperReady = true;

  var GRAPHQL_URL = "https://surfaces-graphql.splice.com/graphql";

  // Tauri reliably injects __TAURI_INTERNALS__ into capability-granted remote
  // pages, but the high-level window.__TAURI__ global may not be present. Prefer
  // the global when available; otherwise build a minimal emit/listen on top of
  // the internals (the same commands the high-level API uses).
  function getEventApi() {
    if (window.__TAURI__ && window.__TAURI__.event) {
      return window.__TAURI__.event;
    }
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || !internals.invoke || !internals.transformCallback) {
      return null;
    }
    return {
      emit: function (event, payload) {
        return internals.invoke("plugin:event|emit", { event: event, payload: payload });
      },
      listen: function (event, handler) {
        return internals.invoke("plugin:event|listen", {
          event: event,
          target: { kind: "Any" },
          handler: internals.transformCallback(handler)
        });
      }
    };
  }

  var loadedAt = Date.now();
  var seenIds = {};

  function start() {
    var event = getEventApi();
    if (!event) { setTimeout(start, 100); return; }

    // This page can't write to the log file, so `logging::log_helper_message` does it
    // on our behalf.
    function log(level, message) {
      try {
        Promise.resolve(event.emit("splice-helper-log", {
          timestamp: Date.now(), level: level, message: message
        })).catch(function () {});
      }
      catch (e) {
        // nothing we can do about it
      }
    }

    log("info", "ready after " + (Date.now() - loadedAt) + "ms at " + location.origin + location.pathname);

    event.listen("splice-search", async function (msg) {
      var id = msg.payload.id;
      var body = msg.payload.body;
      var lastErr = null;
      var startedAt = Date.now();

      var receivedCount = seenIds[id] = (seenIds[id] || 0) + 1;
      log(
        receivedCount > 1 ? "warn" : "debug",
        "[" + id + "] received request (" + body.length + " chars" +
          (receivedCount > 1 ? ", delivery #" + receivedCount : "") + ")"
      );

      // Cloudflare clearance can take a moment after the page loads, so retry
      // a few times before giving up.
      for (var attempt = 0; attempt < 4; attempt++) {
        var attemptedAt = Date.now();
        try {
          var resp = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body
          });
          var text = await resp.text();
          log(
            "debug",
            "[" + id + "] attempt " + (attempt + 1) + ": HTTP " + resp.status + ", " + text.length +
              " chars in " + (Date.now() - attemptedAt) + "ms, total " + (Date.now() - startedAt) + "ms"
          );
          if (resp.ok) {
            event.emit("splice-result", { id: id, ok: true, body: text });
            return;
          }
          lastErr = "Splice returned HTTP " + resp.status;
        }
        catch (e) {
          lastErr = String(e);
        }
        log(
          "warn",
          "[" + id + "] attempt " + (attempt + 1) + " failed after " + (Date.now() - attemptedAt) + "ms: " + lastErr
        );
        await new Promise(function (r) { setTimeout(r, 700); });
      }

      log("error", "[" + id + "] giving up after " + (Date.now() - startedAt) + "ms");
      event.emit("splice-result", { id: id, ok: false, error: lastErr || "unknown error" });
    });
  }

  start();
})();
"#;

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
            files::create_placeholder_file,
            files::remove_placeholder_file,
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
