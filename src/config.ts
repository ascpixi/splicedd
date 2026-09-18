import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { BaseDirectory } from "@tauri-apps/api/path";
import { useState } from "react";
import { IN_TAURI } from "./native";

/**
 * Represents the user configuration file of Splicedd.
 */
export interface SpliceddConfig {
  sampleDir: string;
  placeholders: boolean;
  darkMode: boolean;
  checkUpdates: boolean;

  /** The release tag (e.g. "v1.2.0") the user chose to skip, if any. */
  skippedUpdateVersion: string;

  configured: boolean;
}

let globalCfg: SpliceddConfig;
let saveQueue: Promise<void> = Promise.resolve();

function defaultCfg(): SpliceddConfig {
  return {
    sampleDir: "",
    darkMode: true,
    placeholders: false,
    checkUpdates: true,
    skippedUpdateVersion: "",
    configured: false
  }
}

/**
 * Returns the global configuration object. The returned object should be treated as immutable.
 */
export function cfg(): SpliceddConfig {
  return globalCfg;
}

/**
 * Changes select values of the user configuration and saves it to the config file.
 */
export async function mutateCfg(values: Partial<SpliceddConfig>) {
  globalCfg = { ...globalCfg, ...values }
  await saveConfig();
}

/**
 * Loads user configuration from the config file. Usually is called only called once on startup.
 */
export async function loadConfig() {
  // Outside of Tauri (plain-browser UI development) there is no filesystem;
  // use an in-memory config and skip the first-time setup modal.
  if (!IN_TAURI) {
    globalCfg = { ...defaultCfg(), configured: true };
    return;
  }

  globalCfg = defaultCfg();

  try {
    if (!await exists("config.json", { baseDir: BaseDirectory.AppConfig }))
      return;

    const raw = await readTextFile("config.json", {
      baseDir: BaseDirectory.AppConfig,
    });
    globalCfg = { ...defaultCfg(), ...JSON.parse(raw) };
  } catch (err) {
    // A missing, unreadable, or malformed config must never prevent the UI
    // from mounting. Keep the defaults and allow the next save to repair it.
    console.error("failed to load config; using defaults:", err);
  }
}

/**
 * Synchronizes the in-memory configuration object with the config file stored on disk.
 */
export async function saveConfig() {
  if (!IN_TAURI)
    return;

  // Keep writes ordered. Settings controls can update in quick succession and
  // concurrent writeTextFile calls can otherwise leave an older snapshot on
  // disk after a newer one has completed.
  const serialized = JSON.stringify(globalCfg, null, 2);
  const write = saveQueue
    .catch(() => {}) // a failed write must not prevent later retries
    .then(() => writeTextFile("config.json", serialized, {
      baseDir: BaseDirectory.AppConfig
    }));

  saveQueue = write;
  await write;
}

/**
 * Represents the synchronized state between a React component and the configuration object.
 */
interface ConfigSyncedState<T> {
  key: keyof SpliceddConfig;
  state: T;
  setState: React.Dispatch<React.SetStateAction<T>>
}

/**
 * Allows for synchronization between React components and a single key-value pair of the configuration object.
 */
export function useCfgSyncedState<T>(key: keyof SpliceddConfig) {
  const [state, setState] = useState<T>(globalCfg[key] as T);
  return { key, state, setState }
}

/**
 * Changes the value of the key specified by the target `state` to the given `value`,
 * synchronizing it with the configuration object and the config file.
 */
export function mutateCfgSync<T>(value: T, state: ConfigSyncedState<T>) {
  (globalCfg as any)[state.key] = value;
  state.setState(value);
  return saveConfig();
}
