use serde::Deserialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::{InvokeBody, Request};

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleTarget {
    base_dir: String,
    relative_path: String,
}

// All exports are RIFF WAVs. Reject empty placeholders and truncated containers
// without reading a potentially large cached file into memory.
fn complete_wav_header(header: &[u8], file_len: u64) -> bool {
    if header.len() < 12 || file_len <= 44 || &header[..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return false;
    }
    let declared_len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64 + 8;
    declared_len > 44 && declared_len <= file_len
}

fn sample_file_ready(path: &Path) -> io::Result<bool> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() <= 44 {
        return Ok(false);
    }
    let mut header = [0; 12];
    file.read_exact(&mut header)?;
    Ok(complete_wav_header(&header, metadata.len()))
}

fn write_wav_file(path: &Path, buffer: &[u8]) -> Result<(), String> {
    if !complete_wav_header(buffer, buffer.len() as u64) {
        return Err("The exported WAV is empty or incomplete.".into());
    }
    let parent = path
        .parent()
        .ok_or("Failed to determine parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let (temporary, mut file) = loop {
        let serial = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(".splicedd-{}-{serial}.tmp", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    };
    // Publish only a fully written file. A failed export cannot truncate an
    // existing sample or leave the target pointing at a partially written WAV.
    let result = (|| -> io::Result<()> {
        file.write_all(buffer)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Failed to write sample: {error}"))
}

#[tauri::command]
pub async fn write_sample_file(request: Request<'_>) -> Result<(), String> {
    let header = request
        .headers()
        .get("x-splicedd-target")
        .ok_or("Missing sample destination")?
        .to_str()
        .map_err(|error| error.to_string())?;
    let target: SampleTarget = serde_json::from_str(header).map_err(|error| error.to_string())?;
    if !target.relative_path.ends_with(".wav") {
        return Err("The relative path must end with .wav".into());
    }
    let InvokeBody::Raw(buffer) = request.body() else {
        return Err("Expected binary WAV data".into());
    };
    write_wav_file(
        &PathBuf::from(target.base_dir).join(target.relative_path),
        buffer,
    )
}

#[tauri::command]
pub async fn file_exists(base_dir: String, relative_path: String) -> Result<bool, String> {
    sample_file_ready(&PathBuf::from(base_dir).join(relative_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dir_exists(path: String) -> Result<bool, String> {
    Ok(!path.trim().is_empty() && PathBuf::from(path).is_dir())
}

// Never truncate a complete WAV or an export another drag is preparing.
fn create_placeholder(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing parent directory"))?;
    fs::create_dir_all(parent)?;
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn create_placeholder_file(
    base_dir: String,
    relative_path: String,
) -> Result<(), String> {
    create_placeholder(&PathBuf::from(base_dir).join(relative_path))
        .map_err(|error| format!("Failed to create placeholder: {error}"))
}
