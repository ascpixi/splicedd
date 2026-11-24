import { emit, listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "../native";
import { mockSearch } from "../dev/mock";
import { createLogger, LogSpan } from "../log";
import { SpliceRequest, SpliceSearchResponse } from "./api";
import { createSearchTransport } from "./search-transport";

const nativeSearch = createSearchTransport({ emit, listen }, createLogger("search"));

/**
 * Runs a Splice GraphQL request through the hidden helper webview (see `splice-helper`
 * in the Rust backend), which fetches from the API's own origin. This avoids the CORS
 * preflight that can be rejected by Splice's browser verification.
 */
export function spliceSearch(body: string): Promise<string> {
  return IN_TAURI ? nativeSearch(body) : Promise.resolve(mockSearch(body));
}

/**
 * Runs a search request, and unwraps its response. Rejects if Splice responds with an error.
 * @param span Ended by the time the search is done, no matter the outcome.
 */
export async function searchAssets<T>(payload: SpliceRequest<unknown>, span: LogSpan) {
  let raw = "";

  try {
    raw = await spliceSearch(JSON.stringify(payload));
    span.step("got response", { chars: raw.length });

    // GraphQL errors are returned as regular (i.e. HTTP 200) responses that lack the data.
    const response: { data?: Partial<SpliceSearchResponse<T>["data"]> | null, errors?: { message: string }[] } = JSON.parse(raw);
    const data = response.data?.assetsSearch;

    if (data == null)
      throw new Error(response.errors?.[0]?.message ?? "Splice returned an empty response.");

    span.end("done", {
      results: data.items.length,
      records: data.response_metadata.records,
      page: data.pagination_metadata.currentPage,
      totalPages: data.pagination_metadata.totalPages
    });

    return data;
  }
  catch (err) {
    span.fail(err, { raw: raw.slice(0, 500) });
    throw err;
  }
}
