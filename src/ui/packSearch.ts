import { useEffect, useRef, useState } from "react";

import { MAX_PACK_PAGE, SplicePackSearchResult, SpliceSearchResponse, createPackSearchRequest, createRandomSeed } from "../splice/api";
import { SpliceSortBy, SpliceTag } from "../splice/entities";
import { spliceSearch } from "../splice/request";
import { createLogger } from "../log";

const log = createLogger("packs");

/** Everything that determines which packs get displayed. */
interface PackSearchParams {
  query: string;
  sortBy: SpliceSortBy;
  genres: SpliceTag[];
  page: number;

  /** Used when sorting randomly. Kept between pages, so that packs don't repeat. */
  seed: string;
}

interface PackSearchResults {
  packs: SplicePackSearchResult[];
  genres: SpliceTag[];
  totalPages: number;
}

export type PackSearch = ReturnType<typeof usePackSearch>;

async function searchPacks({ query, sortBy, genres, page, seed }: PackSearchParams): Promise<PackSearchResults> {
  const payload = createPackSearchRequest(query);
  payload.variables.sort = sortBy;
  payload.variables.tags = genres.map(x => x.uuid);
  payload.variables.page = page;

  if (sortBy == "random") {
    payload.variables.random_seed = seed;
  }

  const span = log.span("search", payload.variables);

  try {
    const raw = await spliceSearch(JSON.stringify(payload));
    span.step("got response", { chars: raw.length });

    const response: Partial<SpliceSearchResponse<SplicePackSearchResult>> & { errors?: { message: string }[] } = JSON.parse(raw);
    const data = response.data?.assetsSearch;

    if (data == null)
      throw new Error(response.errors?.[0]?.message ?? "Splice returned an empty response.");

    span.end("done", {
      results: data.items.length,
      records: data.response_metadata.records,
      page: data.pagination_metadata.currentPage,
      totalPages: data.pagination_metadata.totalPages
    });

    return {
      // Some packs consist solely of presets, which we don't support.
      packs: data.items.filter(x => getSampleCount(x) !== 0),

      genres: data.tag_summary
        .filter(x => x.tag.taxonomy.name == "Genre")
        .sort((a, b) => b.count - a.count)
        .map(x => ({ uuid: x.tag.uuid, label: x.tag.label })),

      totalPages: Math.min(data.pagination_metadata.totalPages, MAX_PACK_PAGE)
    };
  }
  catch (err) {
    span.fail(err);
    throw err;
  }
}

/** Returns the number of samples in the given pack, or `null` if it's unknown. */
function getSampleCount(pack: SplicePackSearchResult) {
  return pack.child_asset_counts.find(x => x.type == "sample")?.count ?? null;
}

/**
 * Manages searching for sample packs.
 * @param active Whether the packs are visible to the user. Nothing is requested until they are.
 */
export function usePackSearch(active: boolean) {
  // What's currently in the text field, as opposed to `params.query`, which is only
  // updated once the user stops typing.
  const [query, setQuery] = useState("");

  const [params, setParams] = useState<PackSearchParams>(() => ({
    query: "",
    // When sorting by anything else, how well the name matches is disregarded entirely. Without
    // a query, this is equivalent to sorting by popularity.
    sortBy: "relevance",
    genres: [],
    page: 1,
    seed: createRandomSeed()
  }));

  const [results, setResults] = useState<PackSearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The parameters that were last searched for. */
  const requested = useRef<PackSearchParams | null>(null);

  useEffect(() => {
    if (!active || requested.current == params)
      return;

    requested.current = params;
    setLoading(true);

    searchPacks(params)
      .then(newResults => {
        if (requested.current != params)
          return; // a newer search was started in the meantime

        setResults(newResults);
        setError(null);
        setLoading(false);
      })
      .catch(err => {
        if (requested.current != params)
          return;

        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [active, params]);

  // Wait until the user stops typing, as to not overload Splice with needless requests.
  useEffect(() => {
    if (query == params.query)
      return;

    const timer = setTimeout(() => refine({ query }), 250);
    return () => clearTimeout(timer);
  }, [query, params.query]);

  /** Changes what's searched for, and goes back to the first page. */
  function refine(changes: Partial<PackSearchParams>) {
    setParams(x => ({ ...x, page: 1, seed: createRandomSeed(), ...changes }));
  }

  return {
    query, setQuery,
    sortBy: params.sortBy,
    genres: params.genres,
    page: params.page,
    results, loading, error,

    /** Searches for the current query immediately, even if it's already been searched for. */
    submit: () => refine({ query }),
    setSortBy: (sortBy: SpliceSortBy) => refine({ sortBy }),
    setPage: (page: number) => setParams(x => ({ ...x, page })),

    toggleGenre: (genre: SpliceTag) => refine({
      genres: params.genres.some(x => x.uuid == genre.uuid)
        ? params.genres.filter(x => x.uuid != genre.uuid)
        : [...params.genres, genre]
    })
  };
}
