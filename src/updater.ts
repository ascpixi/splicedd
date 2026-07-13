import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { cfg, mutateCfg } from "./config";
import { IN_TAURI } from "./native";

/**
 * The release notes for a single version, shown in the update dialog's changelog.
 */
export interface ReleaseNotes {
  /** The version these notes describe, e.g. "1.2.0". */
  version: string;

  /** The release tag, e.g. "v1.2.0". */
  tag: string;

  /** The raw markdown body of the GitHub release. May be empty. */
  notes: string;
}

/**
 * Describes an available update, as determined by `checkForUpdates`.
 */
export interface UpdateInfo {
  /** The version of the update, e.g. "1.2.0". */
  version: string;

  /** The release tag of the update, e.g. "v1.2.0". */
  tag: string;

  /** The version we're currently running, e.g. "1.1.1". */
  currentVersion: string;

  /** The GitHub page of the release, for manual downloads. */
  releaseUrl: string;

  /** The download URL of the installer for this platform, or `null` if none was found. */
  installerUrl: string | null;

  /**
   * The release notes for every version between the one we're running and the
   * update, newest first, so the user can see everything they've missed.
   */
  changelog: ReleaseNotes[];
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  body: string | null;
  assets: GithubReleaseAsset[];
}

function parseVersion(version: string) {
  return version.replace(/^v/, "").split(".").map(x => parseInt(x, 10) || 0);
}

/** Orders two version strings: negative if `a` < `b`, positive if `a` > `b`. */
function compareVersions(a: string, b: string) {
  const x = parseVersion(a);
  const y = parseVersion(b);

  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff != 0)
      return diff;
  }

  return 0;
}

function isNewer(candidate: string, current: string) {
  return compareVersions(candidate, current) > 0;
}

/**
 * Picks the release asset that is an installer for the current platform,
 * most preferred format first. Returns `null` if the release has none.
 */
function pickInstaller(assets: GithubReleaseAsset[]) {
  const ua = navigator.userAgent;

  const preferences: ((name: string) => boolean)[] =
    ua.includes("Windows") ? [x => x.endsWith("-setup.exe"), x => x.endsWith(".msi")]
    : ua.includes("Mac") ? [x => x.endsWith(".dmg")]
    : [x => x.endsWith(".AppImage"), x => x.endsWith(".deb")];

  for (const matches of preferences) {
    const asset = assets.find(x => matches(x.name));
    if (asset != null)
      return asset.browser_download_url;
  }

  return null;
}

/**
 * Checks GitHub for a newer release of Splicedd. Returns `null` when we're
 * up to date, when update checks are disabled, or when the user chose to
 * skip the latest version.
 */
// /src-tauri/src/updater.rs
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  if (!IN_TAURI || !cfg().checkUpdates)
    return null;

  const releases = await invoke<GithubRelease[]>("fetch_releases");

  // Only stable releases are offered as updates, newest first.
  const stable = releases
    .filter(x => !x.draft && !x.prerelease)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));

  const latest = stable[0];
  if (latest == null)
    return null;

  if (latest.tag_name == cfg().skippedUpdateVersion)
    return null;

  const currentVersion = await getVersion();
  if (!isNewer(latest.tag_name, currentVersion))
    return null;

  const changelog: ReleaseNotes[] = stable
    .filter(x => isNewer(x.tag_name, currentVersion))
    .map(x => ({
      version: x.tag_name.replace(/^v/, ""),
      tag: x.tag_name,
      notes: (x.body ?? "").trim()
    }));

  return {
    version: latest.tag_name.replace(/^v/, ""),
    tag: latest.tag_name,
    currentVersion,
    releaseUrl: latest.html_url,
    installerUrl: pickInstaller(latest.assets),
    changelog
  };
}

/**
 * Downloads and launches the installer for the given update, terminating
 * Splicedd if successful. If no installer is available for this platform,
 * opens the release page in the browser instead.
 */
// /src-tauri/src/updater.rs
export async function installUpdate(update: UpdateInfo) {
  if (update.installerUrl == null) {
    await open(update.releaseUrl);
    return;
  }

  await invoke("install_update", { url: update.installerUrl });
}

/**
 * Stops the given update from being suggested again. Newer versions will
 * still be suggested.
 */
export async function skipUpdate(update: UpdateInfo) {
  await mutateCfg({ skippedUpdateVersion: update.tag });
}

/**
 * Disables update checks entirely. Can be re-enabled from the settings.
 */
export async function disableUpdateChecks() {
  await mutateCfg({ checkUpdates: false });
}
