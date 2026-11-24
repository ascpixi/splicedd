import { invoke } from "@tauri-apps/api/core";

// This module is imported by pretty much everything else, so it shouldn't depend
// on any other module of ours (e.g. `native.ts`) to avoid import cycles.
const IN_TAURI = "__TAURI_INTERNALS__" in window;

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/** Structured data attached to a log message. Displayed as `key=value` pairs. */
export type LogFields = Record<string, unknown>;

interface LogEntry {
  /** When the message was logged, in milliseconds since the Unix epoch. */
  timestamp: number;
  level: LogLevel;
  scope: string;
  message: string;
}

/** The maximum amount of messages that may be waiting to be sent to the backend. */
const MAX_PENDING = 5000;

let verbose = import.meta.env.DEV;
let pending: LogEntry[] = [];
let droppedCount = 0;
let sending = false;

/**
 * Whether messages of the "debug" and "trace" levels are logged. Use this to skip
 * collecting information that's only logged under those levels if doing so is expensive.
 */
export function isVerbose() {
  return verbose;
}

/**
 * Changes whether messages of the "debug" and "trace" levels are logged. In development
 * builds, they always are.
 */
// /src-tauri/src/logging.rs
export async function setVerbose(enabled: boolean) {
  verbose = enabled || import.meta.env.DEV;

  if (!IN_TAURI)
    return;

  try {
    await invoke("set_verbose_logging", { enabled });
  }
  catch (err) {
    console.error("failed to change the log level:", err);
  }
}

/** Describes a single log file. */
export interface LogFile {
  name: string;

  /** The size of the file, in bytes. */
  size: number;

  /** When the file was last written to, in milliseconds since the Unix epoch. */
  modified: number;
}

/**
 * Lists the available log files. The first one is always the one of the current session.
 */
// /src-tauri/src/logging.rs
export async function listLogFiles() {
  return await invoke<LogFile[]>("list_log_files");
}

/**
 * Reads the log file of the given name. If it's large, only the end of it is returned.
 */
// /src-tauri/src/logging.rs
export async function readLogFile(name: string) {
  return await invoke<string>("read_log_file", { name });
}

/**
 * Opens the directory that contains the log files in the system's file manager.
 */
// /src-tauri/src/logging.rs
export async function openLogDir() {
  await invoke("open_log_dir");
}

/**
 * Strips the query and fragment off an URL, as they may contain credentials (and
 * are very long for URLs to Splice's assets).
 */
export function shortUrl(url: string) {
  return url.startsWith("data:") ? "data:..." : url.split(/[?#]/)[0];
}

function formatError(err: Error) {
  // V8 includes the message in the stack, JavaScriptCore doesn't.
  const title = `${err.name}: ${err.message}`;
  const stack = err.stack ?? "";
  let text = stack.startsWith(title) ? stack : `${title}\n${stack}`;

  if (err.cause != null) {
    text += `\ncaused by ${formatValue(err.cause)}`;
  }

  return text.trimEnd();
}

function formatValue(value: unknown): string {
  if (value instanceof Error)
    return formatError(value);

  if (typeof value == "number" && !Number.isInteger(value))
    return value.toFixed(2);

  if (typeof value == "object" && value !== null) {
    try {
      return JSON.stringify(value);
    }
    catch {
      return String(value); // e.g. circular structures
    }
  }

  return typeof value == "string" ? JSON.stringify(value) : String(value);
}

function formatMessage(message: string, fields?: LogFields) {
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined)
      continue;

    // Errors span many lines, and the messages Tauri rejects with are plain strings.
    message += value instanceof Error
      ? `\n${key}: ${formatValue(value)}`
      : ` ${key}=${formatValue(value)}`;
  }

  return message;
}

/**
 * Sends all pending messages to the backend. There's always only one batch in flight,
 * as otherwise the order in which they're written to the file wouldn't be guaranteed.
 */
// /src-tauri/src/logging.rs
async function flush() {
  if (sending)
    return; // whatever is pending will be picked up by the ongoing flush

  sending = true;
  while (pending.length > 0) {
    const entries = pending;
    pending = [];

    if (droppedCount > 0) {
      entries.unshift({
        timestamp: Date.now(), level: "warn", scope: "log",
        message: `${droppedCount} older messages were dropped`
      });
      droppedCount = 0;
    }

    try {
      await invoke("write_log_entries", { entries });
    }
    catch (err) {
      console.error("failed to write to the log file:", err);
    }
  }

  sending = false;
}

function write(level: LogLevel, scope: string, rawMessage: string, fields?: LogFields) {
  if (!verbose && (level == "debug" || level == "trace"))
    return;

  const message = formatMessage(rawMessage, fields);

  const consoleFn = level == "trace" ? "debug" : level; // console.trace prints a stack trace
  console[consoleFn](`[${scope}] ${message}`);

  if (!IN_TAURI)
    return;

  if (pending.length >= MAX_PENDING) {
    pending.shift();
    droppedCount++;
  }

  pending.push({ timestamp: Date.now(), level, scope, message });

  // Everything logged synchronously gets sent together, but no later than that - we
  // might be just about to block the event loop, or to crash.
  queueMicrotask(flush);
}

let nextSpanId = 1;

/**
 * Represents an operation whose individual steps are timed. All messages logged via a
 * span share an ID, which makes it possible to tell concurrent operations apart.
 */
export class LogSpan {
  private readonly id = nextSpanId++;
  private readonly startedAt = performance.now();
  private lastStepAt = this.startedAt;
  private readonly steps: string[] = [];
  private ended = false;

  constructor(
    private readonly scope: string,
    private readonly name: string,
    private readonly fields?: LogFields
  ) {
    this.log("debug", "started", fields);
  }

  /** Logs a message in the context of this span. */
  log(level: LogLevel, message: string, fields?: LogFields) {
    write(level, this.scope, `${this.name}#${this.id}: ${message}`, fields);
  }

  /**
   * Marks the completion of a single step of the operation. The time elapsed since the
   * previous step is included in the summary that gets logged when the span ends.
   */
  step(name: string, fields?: LogFields) {
    const now = performance.now();
    const elapsed = now - this.lastStepAt;
    this.lastStepAt = now;

    // Outside of developer mode the individual steps aren't logged, so the summary is
    // all there is.
    const summary = `${name} ${elapsed.toFixed(0)}ms`;
    this.steps.push(verbose ? summary : formatMessage(summary, fields));

    this.log("debug", `${name} (+${elapsed.toFixed(1)}ms, total ${(now - this.startedAt).toFixed(1)}ms)`, fields);
  }

  /** Ends the span, logging a summary of how long each of the steps took. */
  end(outcome = "done", fields?: LogFields, level: LogLevel = "info") {
    if (this.ended)
      return;

    this.ended = true;

    const steps = this.steps.length > 0 ? ` [${this.steps.join(", ")}]` : "";
    this.log(
      level,
      `${outcome} after ${(performance.now() - this.startedAt).toFixed(1)}ms${steps}`,
      verbose ? fields : { ...this.fields, ...fields }
    );
  }

  /** Ends the span because of an error. */
  fail(err: unknown, fields?: LogFields) {
    this.end("failed", { ...fields, err }, "error");
  }
}

/**
 * Creates a logger, whose messages will be marked with the given `scope`.
 */
export function createLogger(scope: string) {
  const logger = (level: LogLevel) =>
    (message: string, fields?: LogFields) => write(level, scope, message, fields);

  return {
    /** Something failed, and the user most likely noticed. */
    error: logger("error"),

    /** Something's off, but we can carry on. */
    warn: logger("warn"),

    /** Notable events, logged for everyone. Shouldn't be used for anything that happens often. */
    info: logger("info"),

    /** Details of what's going on. Only logged in developer mode. */
    debug: logger("debug"),

    /** Like "debug", but for things that happen really often. */
    trace: logger("trace"),

    /** Begins a timed operation. */
    span: (name: string, fields?: LogFields) => new LogSpan(scope, name, fields)
  };
}

/** How often to check whether the event loop is being blocked. */
const HEARTBEAT_INTERVAL = 100;

/** How long the event loop needs to be blocked for to be worth mentioning. */
const STALL_THRESHOLD = 1000;
const VERBOSE_STALL_THRESHOLD = 100;

/**
 * Logs whenever something blocks the event loop for long enough to be noticeable.
 */
function watchForStalls(log: ReturnType<typeof createLogger>) {
  let last = performance.now();
  let wasHidden = document.hidden;

  setInterval(() => {
    const now = performance.now();
    const stall = now - last - HEARTBEAT_INTERVAL;
    last = now;

    // Timers are throttled while the window isn't visible.
    const reliable = !document.hidden && !wasHidden;
    wasHidden = document.hidden;

    if (!reliable || stall < VERBOSE_STALL_THRESHOLD)
      return;

    const fields = { ms: Math.round(stall), focused: document.hasFocus() };
    if (stall >= STALL_THRESHOLD) {
      log.warn("event loop was blocked (or the system was suspended)", fields);
    }
    else {
      log.debug("event loop was blocked", fields);
    }
  }, HEARTBEAT_INTERVAL);
}

/**
 * Sets up logging of everything that isn't explicitly logged by the rest of the app,
 * such as uncaught errors. Should be called once, as early as possible.
 */
export function initLogging() {
  const log = createLogger("app");

  window.addEventListener("error", ev => log.error("uncaught error", {
    err: ev.error ?? ev.message,
    at: `${shortUrl(ev.filename ?? "")}:${ev.lineno}:${ev.colno}`
  }));

  window.addEventListener("unhandledrejection", ev =>
    log.error("unhandled promise rejection", { err: ev.reason })
  );

  window.addEventListener("focus", () => log.trace("window focused"));
  window.addEventListener("blur", () => log.trace("window blurred"));
  document.addEventListener("visibilitychange", () => log.debug("visibility changed", { state: document.visibilityState }));

  watchForStalls(log);

  log.info("frontend starting", {
    version: __APP_VERSION__,
    mode: import.meta.env.MODE,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    url: shortUrl(location.href)
  });
}
