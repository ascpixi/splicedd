import { useEffect, useRef, useState } from "react";

import { Button, ListBox, ListBoxItem, ListBoxItemIndicator, ModalBackdrop, ModalCloseTrigger, ModalContainer, ModalDialog, Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationNextIcon, PaginationPrevious, PaginationPreviousIcon, ProgressCircle, ProgressCircleFillCircle, ProgressCircleTrack, ProgressCircleTrackCircle, ToggleButton, useOverlayState } from "@heroui/react";
import { InputGroup, InputGroupInput, InputGroupPrefix, Modal, Popover, PopoverContent, PopoverDialog, Select, SelectIndicator, SelectPopover, SelectTrigger, SelectValue } from "@heroui/react";
import { ArrowUpDown, ChevronDown, Disc3, EllipsisVertical, Guitar, Layers, Metronome, Music2, Search, Wrench, X } from "lucide-react";
import { emit, listen } from "@tauri-apps/api/event";
import { cfg } from "../config";
import { SpliceSample, SpliceSamplePack, SpliceSearchResponse, createSearchRequest } from "../splice/api";
import { ChordType, MusicKey, SpliceSampleType, SpliceSortBy, SpliceTag } from "../splice/entities";

import SampleListEntry from "./components/SampleListEntry";
import SettingsModalContent from "./components/SettingsModalContent";
import KeyScaleSelection from "./components/KeyScaleSelection";
import BpmSelection, { BpmFilter, BpmFilterType } from "./components/BpmSelection";
import { SamplePlaybackCancellation, SamplePlaybackContext } from "./playback";
import { IN_TAURI } from "../native";
import { mockSearch } from "../dev/mock";
import { FIELD_BUTTON_CLASSES, NO_PRESS_SCALE, TAG_PILL_CLASSES } from "./fieldStyles";

/**
 * Runs a Splice GraphQL request through the hidden splice.com helper webview
 * (see `splice-helper` in the Rust backend), which fetches from the splice.com
 * origin so it clears Cloudflare Bot Management and Splice's CORS. Communication
 * is a one-shot event round-trip correlated by a request id.
 */
function spliceSearch(body: string): Promise<string> {
  if (!IN_TAURI) {
    return Promise.resolve(mockSearch(body));
  }

  const id = crypto.randomUUID();

  return new Promise<string>((resolve, reject) => {
    let unlisten: (() => void) | null = null;

    // Re-emit periodically: the helper webview may not have registered its
    // listener yet (it's still loading splice.com / clearing Cloudflare), and
    // Tauri drops events that have no listener rather than queuing them.
    const reEmit = setInterval(() => { emit("splice-search", { id, body }); }, 1500);

    const settle = () => { clearInterval(reEmit); clearTimeout(timer); unlisten?.(); };

    const timer = setTimeout(() => {
      settle();
      reject(new Error("Splice search timed out (the helper webview may still be clearing Cloudflare)."));
    }, 20000);

    listen<{ id: string, ok: boolean, body?: string, error?: string }>("splice-result", ev => {
      if (ev.payload.id !== id) return;

      settle();

      if (ev.payload.ok && ev.payload.body != null) {
        resolve(ev.payload.body);
      } else {
        reject(new Error(ev.payload.error ?? "Splice search failed"));
      }
    }).then(fn => {
      unlisten = fn;
      emit("splice-search", { id, body });
    });
  });
}

function buildPageList(current: number, total: number): (number | "ellipsis")[] {
  const pages: (number | "ellipsis")[] = [];
  for (let p = 1; p <= total; p++) {
    if (p === 1 || p === total || Math.abs(p - current) <= 2) {
      pages.push(p);
    } else if (pages[pages.length - 1] !== "ellipsis") {
      pages.push("ellipsis");
    }
  }
  return pages;
}

function App() {
  const settings = useOverlayState({
    defaultOpen: !cfg().configured
  });

  const [bpmType, setBpmType] = useState<BpmFilterType>("exact");
  const [bpm, setBpm] = useState<BpmFilter>();
  const [bpmOpen, setBpmOpen] = useState(false);

  const [query, setQuery] = useState("");

  const [results, setResults] = useState<SpliceSample[]>([]);
  const [resultCount, setResultCount] = useState(0);
  const resultContainer = useRef<HTMLDivElement | null>(null);

  const [queryTimer, setQueryTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const [sortBy, setSortBy] = useState<SpliceSortBy>("relevance");
  const [sampleType, setSampleType] = useState<SpliceSampleType | "any">("any")

  const [knownInstruments, setKnownInstruments] = useState<{name: string, uuid: string}[]>([]);
  const [knownGenres, setKnownGenres] = useState<{name: string, uuid: string}[]>([]);

  const [instruments, setInstruments] = useState(new Set<string>([]));
  const [genres, setGenres] = useState(new Set<string>([]));
  let [tags, setTags] = useState<SpliceTag[]>([]);

  const [knownTags, setKnownTags] = useState<SpliceTag[]>([]);
  const [tagsExpanded, setTagsExpanded] = useState(false);

  const [musicKey, setMusicKey] = useState<MusicKey | null>(null);
  const [chordType, setChordType] = useState<ChordType | null>(null);

  const [packFilter, setPackFilter] = useState<SpliceSamplePack | null>(null);

  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Results should be visible not only when a text query is entered, but also
  // when the user is filtering solely by tags, key, BPM, etc.
  const filtersActive =
    tags.length > 0 || instruments.size > 0 || genres.size > 0 ||
    musicKey != null || chordType != null || bpm != null || sampleType != "any" ||
    packFilter != null;

  useEffect(() => {
    updateSearch(query);
  }, [
    sortBy, bpm, bpmType, sampleType,
    instruments, genres, currentPage,
    musicKey, chordType, packFilter
  ]);

  const [smplCancellation, smplSetCancellation] = useState<SamplePlaybackCancellation | null>(null);
  const pbCtx: SamplePlaybackContext = {
    cancellation: smplCancellation,
    setCancellation: smplSetCancellation
  }

  function ensureContraintsGathered() {
    if (knownInstruments.length == 0 || knownGenres.length == 0) {
      updateSearch("");
    }
  }

  function changePage(n: number) {
    setCurrentPage(n);
    resultContainer.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  }

  function handleSearchInput(ev: React.ChangeEvent<HTMLInputElement>) {
    setQuery(ev.target.value);

    if (queryTimer != null) {
      clearTimeout(queryTimer);
    }

    // We set a timer, as to not overload Splice with needless requests while the user is typing.
    let selfTimer = setTimeout(() => updateSearch(ev.target.value, true), 250);
    setQueryTimer(selfTimer);
  }

  function handleSearchKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key == "Enter") {
      updateSearch(query, true);
    }
  }

  function toggleTag(tag: SpliceTag) {
    tags = tags.some(x => x.uuid == tag.uuid)
      ? tags.filter(x => x.uuid != tag.uuid)
      : [...tags, tag];

    setTags(tags);
    updateSearch(query, true);
  }

  function handleTagClick(tag: SpliceTag) {
    if (tags.some(x => x.uuid == tag.uuid)) {
      return;
    }

    toggleTag(tag);
  }

  function handlePackClick(pack: SpliceSamplePack) {
    if (packFilter?.uuid == pack.uuid) {
      return;
    }

    setPackFilter(pack);
    setCurrentPage(1);
  }

  async function updateSearch(newQuery: string, resetPage = false) {
      const payload = createSearchRequest(newQuery);
      payload.variables.sort = sortBy;
      if (sortBy == "random") {
        payload.variables.random_seed = Math.floor(Math.random() * 10000000000).toString();
      }

      payload.variables.tags = tags.map(x => x.uuid);

      if (bpmType == "exact") {
        payload.variables.bpm = bpm?.bpm;
      } else {
        payload.variables.min_bpm = bpm?.minBpm;
        payload.variables.max_bpm = bpm?.maxBpm;
      }

      if (sampleType != "any") {
        payload.variables.asset_category_slug = sampleType;
      }

      payload.variables.tags.push(...instruments);
      payload.variables.tags.push(...genres);

      payload.variables.chord_type = chordType ?? undefined;
      payload.variables.key = musicKey ?? undefined;

      if (packFilter != null) {
        payload.variables.parent_asset_uuid = packFilter.uuid;
        payload.variables.parent_asset_type = "pack";
      }

      payload.variables.page = resetPage ? 1 : currentPage;

      setSearchLoading(true);

      let raw: string;
      try {
        // Routed through the hidden splice.com helper webview so the request clears
        // Cloudflare Bot Management (which blocks non-browser TLS fingerprints) and
        // Splice's CORS. A direct browser fetch from our own origin can't do this
        // without disabling web security, which breaks Tauri v2 IPC.
        raw = await spliceSearch(JSON.stringify(payload));
        setSearchError(null);
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setSearchLoading(false);
      }

      pbCtx.cancellation?.(); // stop any sample that's currently playing

      const respData: SpliceSearchResponse = JSON.parse(raw);
      const data = respData.data.assetsSearch;

      setResults(data.items);
      setResultCount(data.response_metadata.records);

      setCurrentPage(resetPage ? 1 : data.pagination_metadata.currentPage);
      setTotalPages(data.pagination_metadata.totalPages);

      function findConstraints(name: "Genre" | "Instrument") {
        return data.tag_summary.map(x => x.tag)
          .filter(x => x.taxonomy.name == name)
          .map(x => ({ name: x.label, uuid: x.uuid }));
      }

      setKnownGenres(findConstraints("Genre"));
      setKnownInstruments(findConstraints("Instrument"));

      const seenTags = new Set<string>();
      setKnownTags(
        [...data.tag_summary]
          .sort((a, b) => b.count - a.count)
          .map(x => x.tag)
          .filter(x => !seenTags.has(x.uuid) && (seenTags.add(x.uuid), true))
          .map(x => ({ uuid: x.uuid, label: x.label }))
      );
  }

  return (
    <main className="flex flex-col gap-2 h-screen p-6">
      <Modal isOpen={settings.isOpen} onOpenChange={settings.setOpen}>
        <ModalBackdrop isDismissable={false}>
          <ModalContainer size="lg">
            <ModalDialog>
              {cfg().configured && <ModalCloseTrigger />}
              <SettingsModalContent onClose={settings.close} />
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>

      <div className="flex gap-2">
        <InputGroup className="flex-1">
          <InputGroupPrefix>
            <Search className="size-5" />
          </InputGroupPrefix>
          <InputGroupInput
            type="text"
            aria-label="Search for samples"
            placeholder="Search for samples..."
            value={query}
            onKeyDown={handleSearchKeyDown}
            onChange={handleSearchInput}
          />
        </InputGroup>

        <Select
          aria-label="Sort by"
          value={sortBy}
          onChange={v => setSortBy(v as SpliceSortBy)}
        >
          <SelectTrigger>
            <ArrowUpDown className="size-4 me-2 self-center shrink-0 text-muted" />
            <SelectValue />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox>
              <ListBoxItem id="relevance" textValue="Most relevant">Most relevant<ListBoxItemIndicator /></ListBoxItem>
              <ListBoxItem id="popularity" textValue="Most popular">Most popular<ListBoxItemIndicator /></ListBoxItem>
              <ListBoxItem id="recency" textValue="Most recent">Most recent<ListBoxItemIndicator /></ListBoxItem>
              <ListBoxItem id="random" textValue="Random">Random<ListBoxItemIndicator /></ListBoxItem>
            </ListBox>
          </SelectPopover>
        </Select>

        <Button isIconOnly variant="outline" className={FIELD_BUTTON_CLASSES} aria-label="Settings" onClick={settings.open}>
          <Wrench className="size-4" />
        </Button>
      </div>

      <div className="flex gap-2">
        <Select aria-label="Instruments"
          selectionMode="multiple"
          placeholder="Instruments"
          value={Array.from(instruments)}
          onChange={x => setInstruments(new Set(x as string[]))}
          className="flex-1 min-w-0"
          fullWidth
        >
          <SelectTrigger onPress={ensureContraintsGathered} className="max-w-full">
            <Guitar className="size-4 me-2 self-center shrink-0 text-muted" />
            <SelectValue className="truncate" />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox items={knownInstruments}>
              {(x: {name: string, uuid: string}) => <ListBoxItem id={x.uuid} textValue={x.name}>{x.name}<ListBoxItemIndicator /></ListBoxItem>}
            </ListBox>
          </SelectPopover>
        </Select>

        <Select aria-label="Genres"
          selectionMode="multiple"
          placeholder="Genres"
          value={Array.from(genres)}
          onChange={x => setGenres(new Set(x as string[]))}
          className="flex-1 min-w-0"
          fullWidth
        >
          <SelectTrigger onPress={ensureContraintsGathered} className="max-w-full">
            <Disc3 className="size-4 me-2 self-center shrink-0 text-muted" />
            <SelectValue className="truncate" />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox items={knownGenres}>
              {(x: {name: string, uuid: string}) => <ListBoxItem id={x.uuid} textValue={x.name}>{x.name}<ListBoxItemIndicator /></ListBoxItem>}
            </ListBox>
          </SelectPopover>
        </Select>

        <Popover>
          <Button variant="outline" className={`${FIELD_BUTTON_CLASSES} flex-1 min-w-0 group ${NO_PRESS_SCALE}`}>
            <Music2 className="size-4 shrink-0 text-muted" />
            <span className="flex-1 truncate text-left">
              {
                (musicKey == null && chordType == null) ? "Key"
                  : `${musicKey ?? ""}${chordType == null ? "" : chordType == "major" ? " Major" : " Minor"}`
              }
            </span>
            <ChevronDown className="size-4 shrink-0 transition-transform duration-150 group-aria-expanded:rotate-180" />
          </Button>

          <PopoverContent placement="bottom">
            <PopoverDialog className="flex p-6">
              <KeyScaleSelection
                onChordSet={setChordType} onKeySet={setMusicKey}
                selectedChord={chordType} selectedKey={musicKey}
              />
            </PopoverDialog>
          </PopoverContent>
        </Popover>

        <Popover isOpen={bpmOpen} onOpenChange={setBpmOpen}>
          <Button variant="outline" className={`${FIELD_BUTTON_CLASSES} flex-1 min-w-0 group ${NO_PRESS_SCALE}`}>
            <Metronome className="size-4 shrink-0 text-muted" />
            <span className="flex-1 truncate text-left">
              { (bpmType == "exact" && bpm?.bpm
                  ? `${bpm?.bpm} BPM`
                  : bpmType == "range" && bpm?.maxBpm && bpm.minBpm
                    ? `${bpm.minBpm} – ${bpm.maxBpm} BPM`
                    : "BPM"
                )
              }
            </span>
            <ChevronDown className="size-4 shrink-0 transition-transform duration-150 group-aria-expanded:rotate-180" />
          </Button>

          <PopoverContent placement="bottom">
            <PopoverDialog className="p-6">
              <BpmSelection
                bpmType={bpmType}
                bpm={bpm}
                onSave={(type, newBpm) => {
                  setBpmType(type);
                  setBpm(newBpm);
                  setBpmOpen(false);
                }}
                onClear={() => {
                  setBpm(undefined);
                  setBpmOpen(false);
                }}
              />
            </PopoverDialog>
          </PopoverContent>
        </Popover>

        <Select aria-label="Type"
          value={sampleType}
          onChange={v => setSampleType(v as SpliceSampleType | "any")}
          className="flex-1 min-w-0"
        >
          <SelectTrigger>
            <Layers className="size-4 me-2 self-center shrink-0 text-muted" />
            <SelectValue />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox>
              <ListBoxItem id="any" textValue="Any">Any<ListBoxItemIndicator /></ListBoxItem>
              <ListBoxItem id="oneshot" textValue="One-Shots">One-Shots<ListBoxItemIndicator /></ListBoxItem>
              <ListBoxItem id="loop" textValue="Loops">Loops<ListBoxItemIndicator /></ListBoxItem>
            </ListBox>
          </SelectPopover>
        </Select>
      </div>

      { (query.length > 0 || filtersActive) && knownTags.length > 0 &&
        <div className="flex items-start gap-2">
          { /* Selected tags are pinned to the front; the rest follow, most popular first. */ }
          <div className={`flex-1 min-w-0 flex flex-wrap gap-2 ${tagsExpanded ? "" : "h-9 md:h-8 overflow-hidden"}`}>
            { [...tags, ...knownTags.filter(x => !tags.some(y => y.uuid == x.uuid))].map(x =>
              <ToggleButton key={x.uuid} size="sm" className={TAG_PILL_CLASSES}
                isSelected={tags.some(y => y.uuid == x.uuid)}
                onChange={() => toggleTag(x)}
              >{x.label}</ToggleButton>
            )}
          </div>

          <ToggleButton size="sm" isIconOnly className={TAG_PILL_CLASSES}
            aria-label={tagsExpanded ? "Show fewer tags" : "Show all tags"}
            isSelected={tagsExpanded}
            onChange={setTagsExpanded}
          >
            <EllipsisVertical className="size-4" />
          </ToggleButton>
        </div>
      }

      { /* Active pack filter banner; visually distinct from the tag pills so
           it's obvious results are narrowed down to a single pack. */ }
      { packFilter != null &&
        <div className="flex items-center gap-3 px-3 py-2 rounded-2xl bg-surface shadow-md">
          <img
            src={packFilter.files.find(x => x.asset_file_type_slug == "cover_image")?.url ?? "img/missing-cover.png"}
            alt="" width={36} height={36}
            className="rounded-sm object-cover shrink-0"
            draggable={false}
          />

          <div className="flex-1 min-w-0 flex flex-col">
            <span className="text-xs text-muted">
              Filtering by pack
            </span>
            <span className="truncate font-medium">{packFilter.name}</span>
          </div>

          <button
            type="button"
            aria-label={`Stop filtering by ${packFilter.name}`}
            onClick={() => {
              setPackFilter(null);
              setCurrentPage(1);
            }}
            className="flex items-center justify-center w-8 h-8 rounded-full shrink-0
                       cursor-pointer transition-colors hover:bg-surface-tertiary"
          >
            <X className="size-4" />
          </button>
        </div>
      }

      {
        searchError != null
        ? <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
            <img className="w-12 select-none" src="img/blob-think.png" alt="" draggable={false} />
            <div className="space-y-1">
              <p className="text-muted">Something went wrong while searching.</p>
              <p className="text-sm text-muted/75 max-w-xl">{searchError}</p>
            </div>
          </div>
        : (query.length > 0 || filtersActive)
        ? results.length == 0
        ? <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
            <img className="w-12 select-none" src="img/blob-think.png" alt="" draggable={false} />
            <p className="text-muted">Couldn't find anything. Try changing your query and filters.</p>
          </div>
        : <div ref={resultContainer}
            className="flex-1 min-h-0 mt-2 overflow-y-auto scrollbar-thin shadow-md bg-surface p-6 rounded-3xl flex flex-col gap-6"
        >
              <div className="flex justify-between items-start">
                <div className="space-y-1">
                  <h4 className="text-base font-medium">Samples</h4>
                  <p className="text-sm text-muted">
                    Found {resultCount.toLocaleString("en-US")} sample{resultCount != 1 ? "s" : ""} in total.
                  </p>
                </div>

                <div> { searchLoading &&
                  <ProgressCircle aria-label="Loading results..." isIndeterminate>
                    <ProgressCircleTrack>
                      <ProgressCircleTrackCircle />
                      <ProgressCircleFillCircle />
                    </ProgressCircleTrack>
                  </ProgressCircle>
                } </div>
              </div>

              <div className={`flex-1 flex flex-col transition-opacity duration-150
                              ${searchLoading ? "opacity-50 pointer-events-none" : ""}`}
              >
              { results.map(
                x => <SampleListEntry key={x.uuid} sample={x} onTagClick={handleTagClick} onPackClick={handlePackClick} ctx={pbCtx}/>
              ) }
              </div>

              { totalPages > 1 &&
                <div className="w-full flex justify-center">
                  <Pagination>
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          onClick={() => changePage(Math.max(1, currentPage - 1))}
                          isDisabled={currentPage <= 1}
                        >
                          <PaginationPreviousIcon />
                        </PaginationPrevious>
                      </PaginationItem>
                      {buildPageList(currentPage, totalPages).map((p, i) =>
                        p === "ellipsis"
                          ? <PaginationItem key={`ellipsis-${i}`}><PaginationEllipsis /></PaginationItem>
                          : <PaginationItem key={p}>
                              <PaginationLink isActive={p === currentPage} onClick={() => changePage(p)}>{p}</PaginationLink>
                            </PaginationItem>
                      )}
                      <PaginationItem>
                        <PaginationNext
                          onClick={() => changePage(Math.min(totalPages, currentPage + 1))}
                          isDisabled={currentPage >= totalPages}
                        >
                          <PaginationNextIcon />
                        </PaginationNext>
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                </div>
              }
            </div>
          : <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
              <img className="w-12 select-none" src="img/blob-salute.png" alt="" draggable={false} />
              <p className="text-muted">Waiting for your command!</p>
            </div>
      }
    </main>
  );
}

export default App;
