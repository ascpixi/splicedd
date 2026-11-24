import { useEffect, useRef, useState } from "react";

import { SpliceSample, SpliceSamplePack, SpliceSearchResponse, createRandomSeed, createSearchRequest } from "../splice/api";
import { ChordType, MusicKey, SpliceSampleType, SpliceSortBy, SpliceTag } from "../splice/entities";
import { searchAssets } from "../splice/request";
import { createLogger } from "../log";
import { BpmFilter, BpmFilterType } from "./components/BpmSelection";

const log = createLogger("search");

/** Everything that determines which samples get displayed. */
export interface SampleSearchParams {
  query: string;
  sortBy: SpliceSortBy;
  sampleType: SpliceSampleType | "any";
  bpmType: BpmFilterType;
  bpm: BpmFilter | undefined;

  /** The UUIDs of the instruments and genres to filter by, respectively. */
  instruments: string[];
  genres: string[];

  tags: SpliceTag[];
  musicKey: MusicKey | null;
  chordType: ChordType | null;
  pack: SpliceSamplePack | null;
  page: number;

  /** Used when sorting randomly. Kept between pages, so that samples don't repeat. */
  seed: string;
}

/** What the results can be narrowed down by. */
interface SampleSearchOptions {
  instruments: SpliceTag[];
  genres: SpliceTag[];
  tags: SpliceTag[];
}

type TagSummary = SpliceSearchResponse["data"]["assetsSearch"]["tag_summary"];

async function searchSamples(params: SampleSearchParams) {
  const payload = createSearchRequest(params.query);
  const { variables } = payload;

  variables.sort = params.sortBy;
  if (params.sortBy == "random") {
    variables.random_seed = params.seed;
  }

  variables.tags = [...params.tags.map(x => x.uuid), ...params.instruments, ...params.genres];

  if (params.bpmType == "exact") {
    variables.bpm = params.bpm?.bpm;
  }
  else {
    variables.min_bpm = params.bpm?.minBpm;
    variables.max_bpm = params.bpm?.maxBpm;
  }

  if (params.sampleType != "any") {
    variables.asset_category_slug = params.sampleType;
  }

  variables.chord_type = params.chordType ?? undefined;
  variables.key = params.musicKey ?? undefined;

  if (params.pack != null) {
    variables.parent_asset_uuid = params.pack.uuid;
    variables.parent_asset_type = "pack";
  }

  variables.page = params.page;

  const { attributes, legacy, limit, order, ...logged } = variables;
  return await searchAssets<SpliceSample>(payload, log.span("search", logged));
}

/**
 * Determines what can be picked from a list, out of what the results can be narrowed down by. Anything that's
 * already selected is always included, as otherwise it wouldn't be possible to de-select it.
 */
function listOptions(found: SpliceTag[], previous: SpliceTag[], selected: string[]) {
  // There's nothing to narrow down when there are no results, but the list is still of use for changing the selection.
  if (found.length == 0)
    return previous;

  const missing = previous.filter(x => selected.includes(x.uuid) && !found.some(y => y.uuid == x.uuid));
  return [...missing, ...found];
}

function updateOptions(previous: SampleSearchOptions, summary: TagSummary, params: SampleSearchParams): SampleSearchOptions {
  const seen = new Set<string>();
  const unique = summary.filter(x => !seen.has(x.tag.uuid) && (seen.add(x.tag.uuid), true));

  const toTag = ({ tag }: TagSummary[number]): SpliceTag => ({ uuid: tag.uuid, label: tag.label });
  const ofTaxonomy = (name: "Genre" | "Instrument") =>
    unique.filter(x => x.tag.taxonomy.name == name).map(toTag);

  return {
    instruments: listOptions(ofTaxonomy("Instrument"), previous.instruments, params.instruments),
    genres: listOptions(ofTaxonomy("Genre"), previous.genres, params.genres),
    tags: unique.sort((a, b) => b.count - a.count).map(toTag)
  };
}

/**
 * Manages searching for samples. The first search is made right away, as it also
 * determines what instruments and genres there are to choose from.
 */
export function useSampleSearch() {
  // What's currently in the text field, as opposed to `params.query`, which is only
  // updated once the user stops typing.
  const [query, setQuery] = useState("");

  const [params, setParams] = useState<SampleSearchParams>(() => ({
    query: "",
    sortBy: "popularity",
    sampleType: "any",
    bpmType: "exact",
    bpm: undefined,
    instruments: [],
    genres: [],
    tags: [],
    musicKey: null,
    chordType: null,
    pack: null,
    page: 1,
    seed: createRandomSeed()
  }));

  const [results, setResults] = useState<SpliceSample[] | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [options, setOptions] = useState<SampleSearchOptions>({ instruments: [], genres: [], tags: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The parameters that were last searched for. */
  const requested = useRef<SampleSearchParams | null>(null);

  useEffect(() => {
    if (requested.current == params)
      return;

    requested.current = params;
    setLoading(true);

    searchSamples(params)
      .then(data => {
        if (requested.current != params)
          return; // a newer search was started in the meantime

        setResults(data.items);
        setTotalPages(data.pagination_metadata.totalPages);
        setOptions(x => updateOptions(x, data.tag_summary, params));
        setError(null);
        setLoading(false);
      })
      .catch(err => {
        if (requested.current != params)
          return;

        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [params]);

  // Wait until the user stops typing, as to not overload Splice with needless requests.
  useEffect(() => {
    if (query == params.query)
      return;

    const timer = setTimeout(() => refine({ query }), 250);
    return () => clearTimeout(timer);
  }, [query, params.query]);

  /** Changes what's searched for, and goes back to the first page. */
  function refine(changes: Partial<SampleSearchParams>) {
    if (changes.query != null) {
      setQuery(changes.query);
    }

    setParams(x => ({ ...x, page: 1, seed: createRandomSeed(), ...changes }));
  }

  return {
    query, setQuery,
    params, refine,
    results, totalPages, options, loading, error,

    /** Searches for the current query immediately, even if it's already been searched for. */
    submit: () => refine({ query }),

    /** Repeats the last search. */
    retry: () => setParams(x => ({ ...x })),

    setPage: (page: number) => setParams(x => ({ ...x, page }))
  };
}
