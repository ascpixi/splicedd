import { invoke } from '@tauri-apps/api/core';
import { sampleTargetHeader } from './splice/export';

/**
 * Whether the app is running inside the Tauri shell. When `false` (e.g. when
 * running `yarn dev` in a plain browser for UI work), native functionality is
 * unavailable and the app falls back to in-memory config and mock search data.
 */
export const IN_TAURI = "__TAURI_INTERNALS__" in window;

/** Whether the app is running on Windows. */
export const IS_WINDOWS = navigator.userAgent.includes("Windows");

/**
 * The longest path (in UTF-16 code units, excluding the null terminator) that the
 * Windows shell accepts. Dragging files with longer paths isn't possible.
 */
export const WINDOWS_MAX_PATH = 259;

/**
 * Writes a file to the path retriveved by combining `baseDir` and `relativePath`.
 * The path is required to end with ".wav".
 */
// /src-tauri/src/files.rs
export async function writeSampleFile(baseDir: string, relativePath: string, buffer: Uint8Array) {
  // Send raw bytes instead of expanding a multi-megabyte WAV into a JSON array.
  await invoke("write_sample_file", buffer, {
    headers: { "x-splicedd-target": sampleTargetHeader(baseDir, relativePath) }
  });
}

/**
 * Checks whether a cached WAV is complete; empty placeholders are regenerated.
 */
// /src-tauri/src/files.rs
export async function checkFileExists(baseDir: string, relativePath: string) {
  return await invoke<boolean>("file_exists", {
    baseDir,
    relativePath
  });
}

/**
 * Checks if `path` points to an existing directory. Always `true` outside of Tauri.
 */
// /src-tauri/src/files.rs
export async function checkDirExists(path: string) {
  if (!IN_TAURI)
    return true;

  return await invoke<boolean>("dir_exists", { path });
}

/** Create an empty drag target without truncating an existing sample. */
export async function createPlaceholder(baseDir: string, relativePath: string) {
  await invoke("create_placeholder_file", { baseDir, relativePath });
}
