import { invoke } from '@tauri-apps/api/tauri';

/**
 * Writes a file to the path retriveved by combining `baseDir` and `relativePath`.
 * The path is required to end with ".wav".
 */
// /src-tauri/src/files.rs
export async function writeSampleFile(baseDir: string, relativePath: string, buffer: Buffer) {
  await invoke("write_sample_file", {
    baseDir,
    relativePath,
    buffer: Array.from(buffer)
  });
}

/**
 * Checks if a file exists on the path retriveved by combining `baseDir` and `relativePath`.
 */
// /src-tauri/src/files.rs
export async function checkFileExists(baseDir: string, relativePath: string) {
  return await invoke<boolean>("file_exists", {
    baseDir,
    relativePath
  });
}

/**
 * Creates an empty placeholder file on the path retriveved by combining "baseDir" and "relativePath".
 */
// /src-tauri/src/files.rs
export async function createPlaceholder(baseDir: string, relativePath: string) {
  await invoke("create_placeholder_file", {
    baseDir,
    relativePath
  });
}

