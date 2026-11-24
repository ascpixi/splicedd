import { emit, listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "../native";
import { mockSearch } from "../dev/mock";
import { createLogger } from "../log";

const log = createLogger("search");

/**
 * Runs a Splice GraphQL request through the hidden splice.com helper webview
 * (see `splice-helper` in the Rust backend), which fetches from the splice.com
 * origin so it clears Cloudflare Bot Management and Splice's CORS. Communication
 * is a one-shot event round-trip correlated by a request id.
 */
export function spliceSearch(body: string): Promise<string> {
  if (!IN_TAURI) {
    return Promise.resolve(mockSearch(body));
  }

  const id = crypto.randomUUID();
  const startedAt = performance.now();
  const elapsedMs = () => performance.now() - startedAt;

  return new Promise<string>((resolve, reject) => {
    let unlisten: (() => void) | null = null;

    // Re-emit periodically: the helper webview may not have registered its
    // listener yet (it's still loading splice.com / clearing Cloudflare), and
    // Tauri drops events that have no listener rather than queuing them.
    const reEmit = setInterval(() => {
      log.debug("no response yet, sending the request again", { id, elapsedMs: elapsedMs() });
      emit("splice-search", { id, body });
    }, 1500);

    const settle = () => { clearInterval(reEmit); clearTimeout(timer); unlisten?.(); };

    const timer = setTimeout(() => {
      log.error("request timed out", { id, elapsedMs: elapsedMs() });
      settle();
      reject(new Error("Splice search timed out (the helper webview may still be clearing Cloudflare)."));
    }, 20000);

    listen<{ id: string, ok: boolean, body?: string, error?: string }>("splice-result", ev => {
      if (ev.payload.id !== id) return;

      settle();
      log.debug("got response", {
        id, ok: ev.payload.ok, chars: ev.payload.body?.length, error: ev.payload.error, elapsedMs: elapsedMs()
      });

      if (ev.payload.ok && ev.payload.body != null) {
        resolve(ev.payload.body);
      }
      else {
        reject(new Error(ev.payload.error ?? "Splice search failed"));
      }
    }).then(fn => {
      unlisten = fn;
      log.debug("sending request", { id, chars: body.length, elapsedMs: elapsedMs() });
      emit("splice-search", { id, body });
    });
  });
}
