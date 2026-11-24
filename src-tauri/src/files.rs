use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::logging::ms;

/// Logs the error that a command is about to fail with.
fn fail<T>(message: String) -> Result<T, String> {
    log::error!("{message}");
    Err(message)
}

fn create_parent_dirs(full_path: &Path) -> Result<(), String> {
    let Some(parent_dir) = full_path.parent() else {
        return fail("Failed to determine parent directory".into());
    };

    if let Err(e) = fs::create_dir_all(parent_dir) {
        return fail(format!("Failed to create directories for {full_path:#?}: {e}"));
    }

    Ok(())
}

#[tauri::command]
pub async fn write_sample_file(base_dir: String, relative_path: String, buffer: Vec<u8>) -> Result<(), String> {
    // By the time we get here, the (potentially huge) buffer has already been sent over
    // and deserialized. Comparing the time of this message to the one logged by the
    // frontend just before invoking the command tells how long that took.
    log::debug!("write_sample_file: received {} bytes for {relative_path:?}", buffer.len());

    let started = Instant::now();

    if !relative_path.ends_with(".wav") {
        return fail(format!("The relative path must end with .wav (got {relative_path:?})"));
    }

    let mut full_path = PathBuf::from(base_dir);
    full_path.push(relative_path);

    create_parent_dirs(&full_path)?;
    let dirs_created = started.elapsed();

    match File::create(&full_path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(&buffer) {
                return fail(format!("Failed to write to file {full_path:?}: {e}"));
            }
        },
        Err(e) => {
            return fail(format!("Failed to create file {full_path:?}: {e}"));
        }
    }

    log::info!(
        "wrote {} bytes to {full_path:?} in {} (of which creating directories took {})",
        buffer.len(), ms(started.elapsed()), ms(dirs_created)
    );

    Ok(())
}

#[tauri::command]
pub async fn file_exists(base_dir: String, relative_path: String) -> Result<bool, String> {
    let mut full_path = PathBuf::from(base_dir);
    full_path.push(relative_path);

    match fs::metadata(&full_path) {
        // Either a placeholder that's still being filled, or the remains of a failed download.
        Ok(meta) if meta.len() == 0 => log::warn!("file_exists: {full_path:?} exists, but is empty"),
        Ok(meta) => log::debug!("file_exists: {full_path:?} exists ({} bytes)", meta.len()),
        Err(e) => log::debug!("file_exists: {full_path:?} isn't accessible: {e}"),
    }

    Ok(full_path.exists())
}

#[tauri::command]
pub async fn dir_exists(path: String) -> Result<bool, String> {
    let exists = !path.trim().is_empty() && PathBuf::from(&path).is_dir();
    log::trace!("dir_exists: {path:?} -> {exists}");
    Ok(exists)
}

#[tauri::command]
pub async fn create_placeholder_file(base_dir: String, relative_path: String) -> Result<(), String> {
    let mut full_path = PathBuf::from(base_dir);
    full_path.push(relative_path);

    create_parent_dirs(&full_path)?;

    match File::create(&full_path) {
        Ok(_) => {
            log::info!("created a placeholder at {full_path:?}");
            Ok(())
        },
        Err(e) => fail(format!("Failed to create file {full_path:?}: {e}")),
    }
}
