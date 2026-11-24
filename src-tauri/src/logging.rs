use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::panic;
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};

use log::{Level, LevelFilter};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::{FileOpenStrategy, RotationStrategy, Target, TargetKind};
use tauri_plugin_shell::ShellExt;
use time::OffsetDateTime;

/// The log target prefix of everything that originates from the frontend.
/// The scope of the logger (see `src/log.ts`) is appended to it.
const UI_TARGET: &str = "ui";

/// The name of the log file of the current session, without its extension. The names
/// of the log files of earlier sessions begin with it, too.
const FILE_NAME: &str = "splicedd";

/// How much of (the end of) a log file can be displayed in the settings.
const MAX_VIEWED_SIZE: u64 = 1024 * 1024;

/// The key under which the original (frontend) timestamp of a record is stored,
/// as milliseconds since the Unix epoch.
const TIMESTAMP_KEY: &str = "ts";

/// Log messages that come from a webview are truncated to this many characters.
const MAX_MESSAGE_LEN: usize = 8192;

/// How large a single log file may get before it's rotated.
const MAX_FILE_SIZE: u128 = 10 * 1024 * 1024;

/// How many log files of previous sessions (or of the current one, if it's
/// large enough to have been rotated) to keep.
const KEPT_FILES: usize = 9;

/// Initializes logging. Each app session begins a new `splicedd.log` file in the
/// OS-specific log directory, and the files of earlier sessions are kept around
/// with the date they were rotated on appended to their name.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok();

    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: Some(FILE_NAME.into()) }),
        ])
        .file_open_strategy(FileOpenStrategy::Rotate)
        .rotation_strategy(RotationStrategy::KeepSome(KEPT_FILES))
        .max_file_size(MAX_FILE_SIZE)
        // What our own code may log is controlled at runtime (see `set_verbose`),
        // and our dependencies only get to speak up when something's off.
        .level(LevelFilter::Warn)
        .level_for("splicedd", LevelFilter::Trace)
        .level_for(UI_TARGET, LevelFilter::Trace)
        .format(move |out, message, record| {
            // Records from the frontend arrive late, especially when something is
            // hogging the IPC, so they carry the time they were actually logged at.
            let timestamp = record.key_values()
                .get(TIMESTAMP_KEY.into())
                .and_then(|x| x.to_i64())
                .and_then(|x| OffsetDateTime::from_unix_timestamp_nanos(x as i128 * 1_000_000).ok())
                .unwrap_or_else(OffsetDateTime::now_utc);

            // Multi-line messages (e.g. stack traces) get indented, so that every
            // line that's not indented is guaranteed to be the start of a record.
            let mut message = message.to_string().replace("\r\n", "\n").replace('\n', "\n    ");
            if let Some(home) = &home {
                message = redact_home(&message, home);
            }

            out.finish(format_args!(
                "{} {:<5} [{}] {}",
                format_timestamp(timestamp), record.level(), record.target(), message
            ))
        })
        .build()
}

/// Formats an UTC timestamp as RFC 3339, always with three subsecond digits.
fn format_timestamp(x: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        x.year(), u8::from(x.month()), x.day(), x.hour(), x.minute(), x.second(), x.millisecond()
    )
}

/// Replaces the path of the user's home directory (which usually contains their
/// name) with `~`, as logs are meant to be attached to public bug reports.
fn redact_home(message: &str, home: &str) -> String {
    if home.len() <= 1 {
        return message.into();
    }

    message
        .replace(&home.replace('\\', "\\\\"), "~") // as seen in JSON or `{:?}`
        .replace(&home.replace('\\', "/"), "~")
        .replace(home, "~")
}

/// Formats a duration for logging, in milliseconds.
pub fn ms(duration: Duration) -> String {
    format!("{:.1}ms", duration.as_secs_f64() * 1000.0)
}

/// Strips the query and fragment off an URL, as they may contain credentials.
pub fn strip_query(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or_default()
}

/// Truncates a message that came from a webview.
pub fn truncate(message: &str) -> String {
    match message.char_indices().nth(MAX_MESSAGE_LEN) {
        Some((end, _)) => format!("{}... (truncated, {} bytes in total)", &message[..end], message.len()),
        None => message.into(),
    }
}

/// Changes whether debug and trace messages are logged. They always are in
/// development builds.
fn set_verbose(enabled: bool) {
    let verbose = cfg!(debug_assertions) || enabled;
    log::set_max_level(
        match verbose {
            true => LevelFilter::Trace,
            false => LevelFilter::Info
        }
    );
}

/// Applies the verbosity set by the user in the config file, and logs basic
/// information about the app and the system it's running on.
pub fn start_session(app: &AppHandle) {
    // The frontend calls `set_verbose_logging` after it loads the config, but by
    // then we'd miss everything that has happened while starting up.
    let verbose = app.path().app_config_dir().ok()
        .and_then(|x| std::fs::read_to_string(x.join("config.json")).ok())
        .and_then(|x| serde_json::from_str::<serde_json::Value>(&x).ok())
        .and_then(|x| x.get("developerMode")?.as_bool())
        .unwrap_or(false);

    set_verbose(verbose);

    log::info!(
        "Splicedd v{} ({} build) on {}/{}, webview {}, log level {}",
        app.package_info().version,
        match cfg!(debug_assertions) {
            true => "debug",
            false => "release"
        },
        std::env::consts::OS,
        std::env::consts::ARCH,
        tauri::webview_version().unwrap_or_else(|e| format!("unknown ({e})")),
        log::max_level()
    );

    log::debug!(
        "config dir: {:?}, log dir: {:?}, available parallelism: {:?}",
        app.path().app_config_dir(), app.path().app_log_dir(), std::thread::available_parallelism()
    );
}

/// Makes panics end up in the log file before they (possibly) bring the app down.
pub fn install_panic_hook() {
    let default_hook = panic::take_hook();

    panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        log::error!(
            "thread '{}' panicked: {info}\n{}",
            thread.name().unwrap_or("<unnamed>"),
            std::backtrace::Backtrace::force_capture()
        );

        default_hook(info);
    }));
}

/// A single log message sent by the frontend.
#[derive(Deserialize)]
pub struct FrontendLogEntry {
    timestamp: i64,
    level: String,
    scope: String,
    message: String,
}

/// Writes a batch of log messages from the frontend to the log file.
#[tauri::command]
pub async fn write_log_entries(entries: Vec<FrontendLogEntry>) {
    for entry in entries {
        let level = entry.level.parse().unwrap_or(Level::Info);
        let target = format!("{UI_TARGET}::{}", entry.scope);

        log::log!(
            target: &target, level,
            ts = entry.timestamp;
            "{}", truncate(&entry.message)
        );
    }
}

/// A single log message sent by the splice.com helper webview.
#[derive(Deserialize)]
struct HelperLogEntry {
    timestamp: i64,
    level: String,
    message: String,
}

/// Handles a `splice-helper-log` event, which the splice.com helper webview uses
/// to write to the log file, as it can't invoke any commands.
pub fn log_helper_message(payload: &str) {
    let entry: HelperLogEntry = match serde_json::from_str(payload) {
        Ok(entry) => entry,
        Err(e) => return log::warn!("malformed log message from the splice helper: {e}"),
    };

    log::log!(
        target: "ui::splice-helper", entry.level.parse().unwrap_or(Level::Info),
        ts = entry.timestamp;
        "{}", truncate(&entry.message)
    );
}

/// Changes whether debug and trace messages are logged.
#[tauri::command]
pub async fn set_verbose_logging(enabled: bool) {
    set_verbose(enabled);
    log::info!("log level is now {}", log::max_level());
}

fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_log_dir().map_err(|e| format!("Failed to determine the log directory: {e}"))
}

fn is_log_file_name(name: &str) -> bool {
    name.starts_with(FILE_NAME) && name.ends_with(".log") && !name.contains(['/', '\\'])
}

/// Describes a single log file.
#[derive(Serialize)]
pub struct LogFile {
    name: String,
    size: u64,

    /// When the file was last written to, in milliseconds since the Unix epoch.
    modified: u64,
}

/// Lists the available log files, the most recent ones (and as such, the one of the
/// current session) first.
#[tauri::command]
pub async fn list_log_files(app: AppHandle) -> Result<Vec<LogFile>, String> {
    let entries = fs::read_dir(log_dir(&app)?)
        .map_err(|e| format!("Failed to list the log files: {e}"))?;

    let mut files: Vec<LogFile> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            let meta = entry.metadata().ok()?;
            let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;

            (meta.is_file() && is_log_file_name(&name)).then(|| LogFile {
                name,
                size: meta.len(),
                modified: modified.as_millis() as u64
            })
        })
        .collect();

    files.sort_by_key(|x| std::cmp::Reverse(x.modified));
    Ok(files)
}

/// Reads (the end of) the log file of the given name.
#[tauri::command]
pub async fn read_log_file(app: AppHandle, name: String) -> Result<String, String> {
    if !is_log_file_name(&name) {
        return Err("Not a log file".into());
    }

    read_tail(log_dir(&app)?.join(&name), MAX_VIEWED_SIZE)
        .map_err(|e| format!("Failed to read {name}: {e}"))
}

/// Reads at most `max_size` bytes off the end of a file, without any partial lines.
fn read_tail(path: PathBuf, max_size: u64) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let start = file.metadata()?.len().saturating_sub(max_size);
    file.seek(SeekFrom::Start(start))?;

    let mut data = Vec::new();
    file.read_to_end(&mut data)?;

    let text = String::from_utf8_lossy(&data);
    if start == 0 {
        return Ok(text.into());
    }

    // The first line is most likely incomplete.
    Ok(text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default())
}

/// Opens the directory that contains the log files in the system's file manager.
#[tauri::command]
pub async fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let path = log_dir(&app)?;

    #[allow(deprecated)] // see `updater::install_update`
    app.shell().open(path.to_string_lossy(), None).map_err(|e| {
        log::error!("failed to open the log directory {path:?}: {e}");
        format!("Failed to open {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_timestamps_with_milliseconds() {
        let at = |ms: i128| OffsetDateTime::from_unix_timestamp_nanos(ms * 1_000_000).unwrap();
        assert_eq!(format_timestamp(at(0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_timestamp(at(1_700_000_000_042)), "2023-11-14T22:13:20.042Z");
    }

    #[test]
    fn redacts_home_directories() {
        assert_eq!(redact_home("/Users/bob/Splice/a.wav", "/Users/bob"), "~/Splice/a.wav");
        assert_eq!(redact_home(r"C:\Users\bob\a.wav", r"C:\Users\bob"), r"~\a.wav");
        assert_eq!(redact_home(r#""C:\\Users\\bob\\a.wav""#, r"C:\Users\bob"), r#""~\\a.wav""#);
        assert_eq!(redact_home("C:/Users/bob/a.wav", r"C:\Users\bob"), "~/a.wav");
        assert_eq!(redact_home("/a/b", "/"), "/a/b");
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate("zażółć"), "zażółć");
        assert!(truncate(&"ż".repeat(MAX_MESSAGE_LEN + 1)).contains("truncated"));
    }

    #[test]
    fn only_accepts_log_file_names() {
        assert!(is_log_file_name("splicedd.log"));
        assert!(is_log_file_name("splicedd_2026-11-23_23-57-05.log"));
        assert!(!is_log_file_name("config.json"));
        assert!(!is_log_file_name("splicedd/../../a.log"));
        assert!(!is_log_file_name("splicedd\\..\\a.log"));
    }

    #[test]
    fn reads_whole_lines_off_the_end() {
        let path = std::env::temp_dir().join(format!("splicedd-test-{}.txt", std::process::id()));
        fs::write(&path, "first\nsecond\nthird\n").unwrap();

        assert_eq!(read_tail(path.clone(), 100).unwrap(), "first\nsecond\nthird\n");
        assert_eq!(read_tail(path.clone(), 9).unwrap(), "third\n");

        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn strips_queries() {
        assert_eq!(strip_query("https://a.b/c?d=e#f"), "https://a.b/c");
        assert_eq!(strip_query("https://a.b/c#f"), "https://a.b/c");
    }
}
