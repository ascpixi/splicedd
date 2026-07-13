import { exists, readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { BaseDirectory, appConfigDir } from "@tauri-apps/api/path";
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

  const appConfig = await appConfigDir();
  await mkdir(appConfig, { recursive: true }).catch(() => {});

  if (!await exists("config.json", { baseDir: BaseDirectory.AppConfig })) {
    globalCfg = defaultCfg();
  } else {
    const raw = await readTextFile("config.json", {
      baseDir: BaseDirectory.AppConfig,
    });

    globalCfg = { ...defaultCfg(), ...JSON.parse(raw) };
  }
}

/**
 * Synchronizes the in-memory configuration object with the config file stored on disk.
 */
export async function saveConfig() {
  if (!IN_TAURI)
    return;

  await writeTextFile("config.json", JSON.stringify(globalCfg, null, 2), {
    baseDir: BaseDirectory.AppConfig
  });
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
  saveConfig();
}
