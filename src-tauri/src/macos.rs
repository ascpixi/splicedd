//! On macOS, apps are expected to keep running after their window is closed, and to
//! bring it back when their Dock icon is clicked. We hide the main window instead of
//! destroying it, so that the state of the frontend (e.g. the search) is kept, too.

use tauri::{AppHandle, Manager, Window};

use crate::MAIN_LABEL;

/// Hides the main window, as if it was closed.
pub fn hide_main_window(window: &Window) {
    // Hiding just the window while it's in fullscreen would leave its (now empty)
    // space behind, so the entire app has to be hidden instead.
    let result = match window.is_fullscreen() {
        Ok(true) => window.app_handle().hide(),
        _ => window.hide()
    };

    if let Err(e) = result {
        log::error!("failed to hide the main window: {e}");
    }
}

/// Brings back the main window, regardless of whether it was closed or minimized.
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return log::error!("there's no main window to show");
    };

    let result = window.unminimize()
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus());

    if let Err(e) = result {
        log::error!("failed to show the main window: {e}");
    }
}
