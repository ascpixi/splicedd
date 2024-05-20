use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

#[tauri::command]
pub async fn write_sample_file(base_dir: String, relative_path: String, buffer: Vec<u8>) -> Result<(), String> {
    if !relative_path.ends_with(".wav") {
        return Err("The relative path must end with .wav".into());
    }

    let mut full_path = PathBuf::from(base_dir);
    full_path.push(relative_path);

    if let Some(parent_dir) = full_path.parent() {
        if let Err(e) = fs::create_dir_all(parent_dir) {
            return Err(format!("Failed to create directories: {}", e));
        }
    } else {
        return Err("Failed to determine parent directory".into());
    }

    match File::create(&full_path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(&buffer) {
                return Err(format!("Failed to write to file: {}", e));
            }
        },
        Err(e) => {
            return Err(format!("Failed to create file: {}", e));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn file_exists(base_dir: String, relative_path: String) -> Result<bool, String> {
    let mut full_path = PathBuf::from(base_dir);
    full_path.push(relative_path);

    Ok(full_path.exists())
}

#[tauri::command]
pub async fn create_placeholder_file(base_dir: String, relative_path: String) -> Result<(), String> {
    let mut full_path = PathBuf::from(base_dir);
    full_path.push(relative_path);

    if let Some(parent_dir) = full_path.parent() {
        if let Err(e) = fs::create_dir_all(parent_dir) {
            return Err(format!("Failed to create directories: {}", e));
        }
    } else {
        return Err("Failed to determine parent directory".into());
    }

    match File::create(&full_path) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to create file: {}", e)),
    }
}