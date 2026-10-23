(function () {
  const GRAPHQL_URL = "https://surfaces-graphql.splice.com/graphql";
  // Only the API document may relay searches, including after navigation.
  if (location.origin !== new URL(GRAPHQL_URL).origin || window.__spliceHelperReady) return;
  window.__spliceHelperReady = true;

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

  async function search(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let lastError = "Splice search failed";
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const response = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: controller.signal
          });
          const text = await response.text();
          const challenge = response.headers.get("cf-mitigated") === "challenge";
          if (response.ok && !challenge) {
            // A challenge page must never reach the UI's JSON parser.
            try { JSON.parse(text); } catch {
              return { ok: false, error: "Splice returned a non-JSON response. Browser verification may be required." };
            }
            return { ok: true, body: text };
          }
          lastError = challenge
            ? "Splice requires browser verification (HTTP " + response.status + ")."
            : "Splice returned HTTP " + response.status;
          if (![403, 408, 429].includes(response.status) && response.status < 500) break;
        } catch (error) {
          if (controller.signal.aborted) break;
          lastError = String(error);
        }
        if (attempt < 3 && !controller.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, 700 * 2 ** attempt));
        }
        if (controller.signal.aborted) break;
      }
      return { ok: false, error: controller.signal.aborted ? "Splice search timed out." : lastError };
    } finally {
      clearTimeout(timer);
    }
  }

  function start() {
    const event = getEventApi();
    if (!event) { setTimeout(start, 100); return; }
    const emit = (name, payload) => event.emit(name, payload).catch(console.error);
    event.listen("splice-search", async ({ payload: { id, body } }) => {
      if (typeof id !== "string" || typeof body !== "string") return;
      // Acknowledge even duplicates, so a lost acknowledgement can be retried.
      emit("splice-search-accepted", { id });
      if (completed.has(id)) {
        emit("splice-result", completed.get(id));
        return;
      }
      if (pending.has(id)) return;
      pending.add(id);
      try {
        const result = { id, ...await search(body) };
        completed.set(id, result);
        if (completed.size > 32) completed.delete(completed.keys().next().value);
        emit("splice-result", result);
      } finally {
        pending.delete(id);
      }
    }).catch(console.error);
  }

  start();
})();
