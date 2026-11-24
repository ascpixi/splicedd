(function () {
  const GRAPHQL_URL = "https://surfaces-graphql.splice.com/graphql";
  // Only the API document may relay searches, including after navigation.
  if (location.origin !== new URL(GRAPHQL_URL).origin || window.__spliceHelperReady) return;
  window.__spliceHelperReady = true;

  const loadedAt = Date.now();
  const pending = new Set();
  const completed = new Map();

  function getEventApi() {
    if (window.__TAURI__?.event) return window.__TAURI__.event;
    const internals = window.__TAURI_INTERNALS__;
    if (!internals?.invoke || !internals.transformCallback) return null;
    return {
      emit: (event, payload) => internals.invoke("plugin:event|emit", { event, payload }),
      listen: (event, handler) => internals.invoke("plugin:event|listen", {
        event, target: { kind: "Any" }, handler: internals.transformCallback(handler)
      })
    };
  }

  async function search(id, body, log) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let lastError = "Splice search failed";
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const attemptedAt = Date.now();
        try {
          const response = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: controller.signal
          });
          const text = await response.text();
          log(
            "debug",
            `[${id}] attempt ${attempt + 1}: HTTP ${response.status}, ${text.length} chars in ` +
              `${Date.now() - attemptedAt}ms, total ${Date.now() - startedAt}ms`
          );
          const challenge = response.headers.get("cf-mitigated") === "challenge";
          if (response.ok && !challenge) {
            // A challenge page must never reach the UI's JSON parser.
            try {
              JSON.parse(text);
            }
            catch {
              log("error", `[${id}] got a non-JSON response`);
              return { ok: false, error: "Splice returned a non-JSON response. Browser verification may be required." };
            }
            return { ok: true, body: text };
          }
          lastError = challenge
            ? "Splice requires browser verification (HTTP " + response.status + ")."
            : "Splice returned HTTP " + response.status;
          if (![403, 408, 429].includes(response.status) && response.status < 500) break;
        }
        catch (error) {
          if (controller.signal.aborted) break;
          lastError = String(error);
        }
        log("warn", `[${id}] attempt ${attempt + 1} failed after ${Date.now() - attemptedAt}ms: ${lastError}`);
        if (attempt < 3 && !controller.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, 700 * 2 ** attempt));
        }
        if (controller.signal.aborted) break;
      }
      if (controller.signal.aborted) lastError = "Splice search timed out.";
      log("error", `[${id}] giving up after ${Date.now() - startedAt}ms: ${lastError}`);
      return { ok: false, error: lastError };
    }
    finally {
      clearTimeout(timer);
    }
  }

  function start() {
    const event = getEventApi();
    if (!event) { setTimeout(start, 100); return; }
    const emit = (name, payload) => event.emit(name, payload).catch(console.error);

    // This page can't write to the log file, so `logging::log_helper_message` does it
    // on our behalf.
    const log = (level, message) => emit("splice-helper-log", { timestamp: Date.now(), level, message });

    log("info", `ready after ${Date.now() - loadedAt}ms at ${location.origin}${location.pathname}`);

    event.listen("splice-search", async ({ payload: { id, body } }) => {
      if (typeof id !== "string" || typeof body !== "string") return;
      const duplicate = pending.has(id) || completed.has(id);
      log("debug", `[${id}] received ${duplicate ? "duplicate " : ""}request (${body.length} chars)`);
      // The frontend sends requests repeatedly until it gets a result.
      if (completed.has(id)) {
        emit("splice-result", completed.get(id));
        return;
      }
      if (pending.has(id)) return;
      pending.add(id);
      try {
        const result = { id, ...await search(id, body, log) };
        completed.set(id, result);
        if (completed.size > 32) completed.delete(completed.keys().next().value);
        emit("splice-result", result);
      }
      finally {
        pending.delete(id);
      }
    }).catch(console.error);
  }

  start();
})();
