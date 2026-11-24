interface SearchEvents {
  emit(event: string, payload: unknown): Promise<void>;
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

interface SearchLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

interface SearchResult {
  id: string;
  ok: boolean;
  body?: string;
  error?: string;
}

/**
 * Sends searches to the helper. Requests are sent repeatedly until there's a result, as
 * the helper might still be loading, or might reload while searching. It ignores requests
 * it's already handling, so this never causes overlapping searches.
 */
export function createSearchTransport(events: SearchEvents, log?: SearchLogger) {
  return (body: string): Promise<string> => {
    const id = crypto.randomUUID();
    const startedAt = performance.now();
    const elapsedMs = () => performance.now() - startedAt;
    return new Promise((resolve, reject) => {
      let settled = false;
      let retry: ReturnType<typeof setInterval> | undefined;
      const unlisten: (() => void)[] = [];
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(retry);
        unlisten.splice(0).forEach(off => off());
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const timeout = setTimeout(() => {
        log?.error("request timed out", { id, elapsedMs: elapsedMs() });
        fail(new Error("Splice search timed out (the helper may still be loading)."));
      }, 20000);
      const register = <T>(name: string, handler: (event: { payload: T }) => void) =>
        events.listen<T>(name, handler).then(off => {
          // Listener registration can finish after a timeout or another failure.
          if (settled) off();
          else unlisten.push(off);
        });
      const send = () => {
        if (!settled) events.emit("splice-search", { id, body }).catch(fail);
      };

      register<SearchResult>("splice-result", ({ payload }) => {
        if (payload.id !== id || settled) return;
        log?.debug("got response", {
          id, ok: payload.ok, chars: payload.body?.length, error: payload.error, elapsedMs: elapsedMs()
        });
        if (!payload.ok || payload.body == null) {
          fail(new Error(payload.error ?? "Splice search failed"));
          return;
        }
        settled = true;
        cleanup();
        resolve(payload.body);
      }).then(() => {
        if (settled) return;
        retry = setInterval(() => {
          log?.debug("no response yet, sending the request again", { id, elapsedMs: elapsedMs() });
          send();
        }, 1500);
        log?.debug("sending request", { id, chars: body.length, elapsedMs: elapsedMs() });
        send();
      }).catch(fail);
    });
  };
}
