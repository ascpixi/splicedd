import { emit, listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "../native";
import { mockSearch } from "../dev/mock";
import { createLogger } from "../log";
import { createSearchTransport } from "./search-transport";

// The helper acknowledges delivery before starting the request, so a slow
// search cannot cause the frontend to launch overlapping retries.
const nativeSearch = createSearchTransport({ emit, listen }, createLogger("search"));

/**
 * Runs a Splice GraphQL request through the hidden helper webview (see `splice-helper`
 * in the Rust backend), which fetches from the API's own origin. This avoids the CORS
 * preflight that can be rejected by Splice's browser verification.
 */
export function spliceSearch(body: string): Promise<string> {
  return IN_TAURI ? nativeSearch(body) : Promise.resolve(mockSearch(body));
}
