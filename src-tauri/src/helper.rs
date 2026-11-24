//! The hidden webview that searches are made from.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::logging;

// Run the helper on the GraphQL origin itself. Fetching from splice.com requires
// a CORS preflight, which Cloudflare can challenge before the search is sent.
// Same-origin requests retain browser security and use the helper's cookies.
const LABEL: &str = "splice-helper";
const URL: &str = "https://surfaces-graphql.splice.com/graphql";
const INIT_SCRIPT: &str = include_str!("splice-helper.js");

/// How long a search may go unacknowledged before the helper is loaded again. Searches time out after
/// 20 seconds, so this leaves enough time for the one that's waiting to still succeed.
const ACKNOWLEDGE_TIMEOUT: Duration = Duration::from_secs(8);

/// Detects when the helper has failed to load, e.g. because there was no internet connection when
/// the app was started. Webviews don't try to load a page again on their own.
#[derive(Default)]
struct Watchdog {
    /// When each of the searches that are yet to be acknowledged was first sent.
    unacknowledged: HashMap<String, Instant>,
}

impl Watchdog {
    /// Called whenever the frontend sends a search, which it keeps doing until there's a result.
    /// Returns whether the helper should be loaded again.
    fn search_sent(&mut self, id: String, now: Instant) -> bool {
        let first_sent = *self.unacknowledged.entry(id).or_insert(now);
        if now - first_sent < ACKNOWLEDGE_TIMEOUT {
            return false;
        }

        self.unacknowledged.clear();
        true
    }

    /// Called whenever the helper shows any sign of life. It acknowledges every search it receives.
    fn helper_responded(&mut self) {
        self.unacknowledged.clear();
    }
}

#[derive(Deserialize)]
struct Search {
    id: String,
}

/// Creates the helper, and makes sure that it remains functional.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Mutex::new(Watchdog::default()));

    // These must be listened for before the helper is created.
    let handle = app.clone();
    app.listen("splice-helper-log", move |event| {
        handle.state::<Mutex<Watchdog>>().lock().unwrap().helper_responded();
        logging::log_helper_message(event.payload());
    });

    let handle = app.clone();
    app.listen("splice-search", move |event| {
        let Ok(Search { id }) = serde_json::from_str(event.payload()) else {
            return;
        };

        let should_load = handle.state::<Mutex<Watchdog>>().lock().unwrap().search_sent(id, Instant::now());
        if should_load {
            load(&handle);
        }
    });

    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(URL.parse().unwrap()))
        .title("splice-helper")
        .visible(false)
        .skip_taskbar(true)
        .initialization_script(INIT_SCRIPT)
        .build()?;

    Ok(())
}

/// Makes the helper load its page (again).
fn load(app: &AppHandle) {
    log::warn!("the splice helper isn't responding, loading it again");

    let Some(webview) = app.get_webview_window(LABEL) else {
        return log::error!("there's no splice helper to load");
    };

    if let Err(e) = webview.navigate(URL.parse().unwrap()) {
        log::error!("failed to load the splice helper: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RETRY: Duration = Duration::from_millis(1500);

    #[test]
    fn unresponsive_helpers_are_loaded_again() {
        let mut watchdog = Watchdog::default();
        let start = Instant::now();

        // Same as what the frontend does, which gives up after 20 seconds.
        let loads: Vec<u32> = (0..=13).filter(|&i| watchdog.search_sent("a".into(), start + RETRY * i)).collect();
        assert_eq!(loads, [6, 13]);
    }

    #[test]
    fn responsive_helpers_are_left_alone() {
        let mut watchdog = Watchdog::default();
        let start = Instant::now();

        for i in 0..=13 {
            assert!(!watchdog.search_sent("slow".into(), start + RETRY * i));
            watchdog.helper_responded();
        }
    }

    #[test]
    fn searches_are_told_apart() {
        let mut watchdog = Watchdog::default();
        let start = Instant::now();

        assert!(!watchdog.search_sent("a".into(), start));
        assert!(!watchdog.search_sent("b".into(), start + ACKNOWLEDGE_TIMEOUT));
        assert!(watchdog.search_sent("a".into(), start + ACKNOWLEDGE_TIMEOUT));
    }
}
