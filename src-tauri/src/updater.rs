use std::io::Write;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_http::reqwest;
use tauri_plugin_shell::ShellExt;

const RELEASES_API_URL: &str = "https://api.github.com/repos/ascpixi/splicedd/releases";
const DOWNLOAD_URL_PREFIX: &str = "https://github.com/ascpixi/splicedd/releases/download/";

/// Fetches the metadata of the project's GitHub releases, newest first. The raw
/// release JSON array is returned to the frontend, which decides whether an
/// update should be offered and builds the changelog from the release notes.
///
/// This runs on the Rust side (rather than as a webview `fetch`) because the
/// GitHub API rejects requests without a `User-Agent` header, which webviews
/// don't allow overriding.
#[tauri::command]
pub async fn fetch_releases() -> Result<serde_json::Value, String> {
    let resp = reqwest::Client::new()
        .get(RELEASES_API_URL)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "splicedd")
        .send().await
        .map_err(|e| format!("Failed to contact GitHub: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", resp.status()));
    }

    let body = resp.text().await
        .map_err(|e| format!("Failed to read the GitHub response: {e}"))?;

    serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse the GitHub response: {e}"))
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Downloads the installer at `url` (which must point to a splicedd GitHub
/// release asset) into the temp directory, launches it, and exits the app so
/// the installer can replace our files.
#[tauri::command]
pub async fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    // The frontend only ever passes asset URLs from our own releases; this is
    // just a backstop so this command can't be used to run arbitrary files.
    if !url.starts_with(DOWNLOAD_URL_PREFIX) {
        return Err("Refusing to download an update from an unknown URL".into());
    }

    let file_name = url.rsplit('/').next().unwrap_or_default();
    if file_name.is_empty() || file_name.contains("..") {
        return Err("Malformed download URL".into());
    }

    let mut resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "splicedd")
        .send().await
        .map_err(|e| format!("Failed to start the download: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", resp.status()));
    }

    let total = resp.content_length();
    let path = std::env::temp_dir().join(file_name);

    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("Failed to create {}: {e}", path.display()))?;

    let mut downloaded: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write the installer: {e}"))?;

        downloaded += chunk.len() as u64;
        let _ = app.emit("update-download-progress", DownloadProgress { downloaded, total });
    }

    drop(file);

    // `Shell::open` is deprecated in favor of the opener plugin, but it works
    // fine for launching installers and saves us from pulling in another plugin.
    #[allow(deprecated)]
    app.shell().open(path.to_string_lossy(), None)
        .map_err(|e| format!("Failed to launch the installer: {e}"))?;

    app.exit(0);
    Ok(())
}
