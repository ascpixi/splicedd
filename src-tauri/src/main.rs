// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;

use tauri::{WebviewUrl, WebviewWindowBuilder};

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

  function start() {
    var event = getEventApi();
    if (!event) { setTimeout(start, 100); return; }

    event.listen("splice-search", async function (msg) {
      var id = msg.payload.id;
      var body = msg.payload.body;
      var lastErr = null;

      // Cloudflare clearance can take a moment after the page loads, so retry
      // a few times before giving up.
      for (var attempt = 0; attempt < 4; attempt++) {
        try {
          var resp = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body
          });
          var text = await resp.text();
          if (resp.ok) {
            event.emit("splice-result", { id: id, ok: true, body: text });
            return;
          }
          lastErr = "Splice returned HTTP " + resp.status;
        } catch (e) {
          lastErr = String(e);
        }
        await new Promise(function (r) { setTimeout(r, 700); });
      }

      event.emit("splice-result", { id: id, ok: false, error: lastErr || "unknown error" });
    });
  }

  start();
})();
"#;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
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
            files::create_placeholder_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
