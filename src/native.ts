import { InvokeArgs, InvokeOptions, invoke as rawInvoke } from '@tauri-apps/api/core';
import { createLogger, LogFields } from './log';

const log = createLogger("native");

/**
 * Whether the app is running inside the Tauri shell. When `false` (e.g. when
 * running `yarn dev` in a plain browser for UI work), native functionality is
 * unavailable and the app falls back to in-memory config and mock search data.
 */
export const IN_TAURI = "__TAURI_INTERNALS__" in window;

/** Whether the app is running on Windows. */
export const IS_WINDOWS = navigator.userAgent.includes("Windows");

/** Whether the app is running on macOS. */
export const IS_MACOS = navigator.userAgent.includes("Macintosh");

/**
 * The longest path (in UTF-16 code units, excluding the null terminator) that the
 * Windows shell accepts. Dragging files with longer paths isn't possible.
 */
export const WINDOWS_MAX_PATH = 259;

/**
 * Invokes a command, logging how long it took. As arguments can be huge, only the given `fields` are logged.
 */
export async function invoke<T>(command: string, args?: InvokeArgs, fields?: LogFields, options?: InvokeOptions): Promise<T> {
  const startedAt = performance.now();
  log.trace(`invoking ${command}`, fields);

  try {
    const result = await rawInvoke<T>(command, args, options);
    log.trace(`${command} returned`, { elapsedMs: performance.now() - startedAt });
    return result;
  }
  catch (err) {
    log.error(`${command} failed`, { ...fields, err, elapsedMs: performance.now() - startedAt });
    throw err;
  }
}

/**
 * Writes a file to the path retriveved by combining `baseDir` and `relativePath`.
 * The path is required to end with ".wav".
 */
// /src-tauri/src/files.rs
export async function writeSampleFile(baseDir: string, relativePath: string, data: Uint8Array) {
  const startedAt = performance.now();

  // The data makes up the entire body of the request, so that it's sent over as-is - which leaves
  // only the headers for everything else. These can't contain any non-ASCII characters.
  const file = JSON.stringify({ baseDir, relativePath })
    .replace(/[\u007f-\uffff]/g, x => "\\u" + x.charCodeAt(0).toString(16).padStart(4, "0"));

  await invoke(
    "write_sample_file", data,
    { relativePath, bytes: data.byteLength },
    { headers: { "sample-file": file } }
  );

  // The backend logs how long the write itself took, so what remains is the IPC overhead.
  log.debug("write_sample_file timing", {
    bytes: data.byteLength,
    invokeMs: performance.now() - startedAt
  });
}

/**
 * Checks if a file exists (and isn't empty) on the path retriveved by combining `baseDir` and `relativePath`.
 */
// /src-tauri/src/files.rs
export async function checkFileExists(baseDir: string, relativePath: string) {
  return await invoke<boolean>("file_exists", { baseDir, relativePath }, { relativePath });
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

/**
 * Creates an empty placeholder file on the path retriveved by combining "baseDir" and "relativePath".
 */
// /src-tauri/src/files.rs
export async function createPlaceholder(baseDir: string, relativePath: string) {
  await invoke("create_placeholder_file", { baseDir, relativePath }, { relativePath });
}

/**
 * Removes a file created by `createPlaceholder`, unless something has already been written to it.
 */
// /src-tauri/src/files.rs
export async function removePlaceholder(baseDir: string, relativePath: string) {
  await invoke("remove_placeholder_file", { baseDir, relativePath }, { relativePath });
}
