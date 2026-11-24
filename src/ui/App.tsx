import { useEffect, useRef, useState } from "react";

import { Alert, AlertContent, AlertDescription, AlertIndicator, AlertTitle, Button, ListBox, ListBoxItem, ListBoxItemIndicator, ModalBackdrop, ModalCloseTrigger, ModalContainer, ModalDialog, ProgressCircle, ProgressCircleFillCircle, ProgressCircleTrack, ProgressCircleTrackCircle, useOverlayState } from "@heroui/react";
import { InputGroup, InputGroupInput, InputGroupPrefix, InputGroupSuffix, Modal, Popover, PopoverContent, PopoverDialog, Select, SelectIndicator, SelectPopover, SelectTrigger, SelectValue } from "@heroui/react";
import { ArrowUpDown, ChevronDown, Disc3, Guitar, Layers, Metronome, MoveRight, Music2, Repeat, Search, Wrench, X } from "lucide-react";
import { cfg } from "../config";
import { SpliceSample, SpliceSamplePack, SpliceSearchResponse, createRandomSeed, createSearchRequest } from "../splice/api";
import { spliceSearch } from "../splice/request";
import { ChordType, MusicKey, SpliceSampleType, SpliceSortBy, SpliceTag } from "../splice/entities";

import SampleListEntry from "./components/SampleListEntry";
import SettingsModalContent from "./components/SettingsModalContent";
import UpdateModal from "./components/UpdateModal";
import { UpdateInfo, checkForUpdates } from "../updater";
import KeyScaleSelection from "./components/KeyScaleSelection";
import BpmSelection, { BpmFilter, BpmFilterType } from "./components/BpmSelection";
import ModeToggle, { BrowsingMode } from "./components/ModeToggle";
import PackList from "./components/PackList";
import ResultPagination from "./components/ResultPagination";
import StatusMessage from "./components/StatusMessage";
import TagPills from "./components/TagPills";
import { usePackSearch } from "./packSearch";
import { PlaybackController } from "./playback";
import { checkDirExists } from "../native";
import { createLogger } from "../log";
import { FIELD_BUTTON_CLASSES, NO_PRESS_SCALE } from "./fieldStyles";

const log = createLogger("search");

let searchCount = 0;

function App() {
  const settings = useOverlayState({
    defaultOpen: !cfg().configured
  });

  const [mode, setMode] = useState<BrowsingMode>("samples");
  const packSearch = usePackSearch(mode == "packs");

  const [bpmType, setBpmType] = useState<BpmFilterType>("exact");
  const [bpm, setBpm] = useState<BpmFilter>();
  const [bpmOpen, setBpmOpen] = useState(false);

  const [query, setQuery] = useState("");

  const [results, setResults] = useState<SpliceSample[]>([]);
  const resultContainer = useRef<HTMLDivElement | null>(null);

  const [queryTimer, setQueryTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const [sortBy, setSortBy] = useState<SpliceSortBy>("popularity");
  const [sampleType, setSampleType] = useState<SpliceSampleType | "any">("any")

  const [knownInstruments, setKnownInstruments] = useState<{name: string, uuid: string}[]>([]);
  const [knownGenres, setKnownGenres] = useState<{name: string, uuid: string}[]>([]);

  const [instruments, setInstruments] = useState(new Set<string>([]));
  const [genres, setGenres] = useState(new Set<string>([]));
  let [tags, setTags] = useState<SpliceTag[]>([]);

  const [knownTags, setKnownTags] = useState<SpliceTag[]>([]);

  const [musicKey, setMusicKey] = useState<MusicKey | null>(null);
  const [chordType, setChordType] = useState<ChordType | null>(null);

  const [packFilter, setPackFilter] = useState<SpliceSamplePack | null>(null);

  // Where the pack that's being filtered by was picked, which is where the user is taken back to afterwards.
  const [packOrigin, setPackOrigin] = useState<BrowsingMode>("samples");

  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  // Drags silently fail when the sample folder doesn't exist (e.g. it was deleted,
  // or lives on a drive that's been unplugged), so warn about it up front.
  const [sampleDirMissing, setSampleDirMissing] = useState(false);

  useEffect(() => {
    if (settings.isOpen)
      return; // re-check once the user is done changing settings

    const refresh = () => {
      checkDirExists(cfg().sampleDir)
        .then(exists => {
          if (!exists) {
            log.warn("sample folder not found", { sampleDir: cfg().sampleDir });
          }

          setSampleDirMissing(!exists);
        })
        .catch(err => log.error("failed to check the sample folder", { err }));
    };

    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [settings.isOpen]);

  useEffect(() => {
    checkForUpdates()
      .then(setUpdate)
      .catch(err => log.error("update check failed", { err }));
  }, []);

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

  const [playback] = useState(() => new PlaybackController());

  // Stop any playing sample when the window loses focus (e.g. the user tabs
  // away or drags a sample into their DAW).
  useEffect(() => {
    const stopOnBlur = () => playback.stop();
    window.addEventListener("blur", stopOnBlur);
    return () => window.removeEventListener("blur", stopOnBlur);
  }, [playback]);

  useEffect(() => {
    resultContainer.current?.scrollTo({ top: 0, left: 0 });
  }, [packFilter]);

  function changeMode(newMode: BrowsingMode) {
    playback.stop(); // the sample that's playing is about to be hidden
    setMode(newMode);
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
    if (mode == "packs") {
      packSearch.setQuery(ev.target.value);
      return;
    }

    setQuery(ev.target.value);

    if (queryTimer != null) {
      clearTimeout(queryTimer);
    }

    // We set a timer, as to not overload Splice with needless requests while the user is typing.
    let selfTimer = setTimeout(() => updateSearch(ev.target.value, true), 250);
    setQueryTimer(selfTimer);
  }

  function handleSearchKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key != "Enter")
      return;

    if (mode == "packs") {
      packSearch.submit();
    }
    else {
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
    setPackOrigin("samples");
    setCurrentPage(1);
  }

  function clearPackFilter() {
    setPackFilter(null);
    setCurrentPage(1);
    changeMode(packOrigin);
  }

  /**
   * Shows all samples from a pack picked from the list of packs. Whatever was searched for beforehand
   * is unrelated to the pack, and would most likely hide everything that's in it.
   */
  function openPack(pack: SpliceSamplePack) {
    if (queryTimer != null) {
      clearTimeout(queryTimer);
    }

    setQuery("");
    setTags([]);
    setInstruments(new Set());
    setGenres(new Set());
    setMusicKey(null);
    setChordType(null);
    setBpm(undefined);
    setSampleType("any");

    setPackFilter(pack);
    setPackOrigin("packs");
    setCurrentPage(1);
    changeMode("samples");
  }

  async function updateSearch(newQuery: string, resetPage = false) {
      const payload = createSearchRequest(newQuery);
      payload.variables.sort = sortBy;
      if (sortBy == "random") {
        payload.variables.random_seed = createRandomSeed();
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

      const searchId = ++searchCount;
      const { attributes, legacy, limit, order, ...params } = payload.variables;
      const span = log.span("search", params);

      let raw: string;
      try {
        // Routed through the hidden splice.com helper webview so the request clears
        // Cloudflare Bot Management (which blocks non-browser TLS fingerprints) and
        // Splice's CORS. A direct browser fetch from our own origin can't do this
        // without disabling web security, which breaks Tauri v2 IPC.
        raw = await spliceSearch(JSON.stringify(payload));
        span.step("got response", { chars: raw.length });
        setSearchError(null);
      }
      catch (err) {
        span.fail(err);
        setSearchError(err instanceof Error ? err.message : String(err));
        return;
      }
      finally {
        setSearchLoading(false);
      }

      if (searchId != searchCount) {
        span.log("warn", "a newer search was started in the meantime, but these results are displayed anyway", {
          newerSearches: searchCount - searchId
        });
      }

      playback.stop(); // stop any sample that's currently playing

      let data: SpliceSearchResponse["data"]["assetsSearch"];
      try {
        const respData: SpliceSearchResponse = JSON.parse(raw);
        data = respData.data.assetsSearch;

        span.step("parsed");
        span.end("done", {
          results: data.items.length,
          records: data.response_metadata.records,
          page: data.pagination_metadata.currentPage,
          totalPages: data.pagination_metadata.totalPages
        });
      }
      catch (err) {
        span.fail(err, { raw: raw.slice(0, 500) });
        throw err;
      }

      setResults(data.items);

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
            <ModalDialog className="max-h-full min-h-0 max-w-2xl">
              {cfg().configured && <ModalCloseTrigger />}
              <SettingsModalContent onClose={settings.close} />
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>

      { update != null &&
        <UpdateModal update={update} onDismiss={() => setUpdate(null)} />
      }

      <div className="flex gap-2">
        <ModeToggle mode={mode} onChange={changeMode} />

        <InputGroup className="flex-1">
          <InputGroupPrefix>
            <Search className="size-5" />
          </InputGroupPrefix>
          <InputGroupInput
            type="text"
            aria-label={`Search for ${mode}`}
            placeholder={`Search for ${mode}...`}
            value={mode == "packs" ? packSearch.query : query}
            onKeyDown={handleSearchKeyDown}
            onChange={handleSearchInput}
          />
          { /* With no query or filters, a search only fetches the filter options
               in the background (results aren't shown), so don't show a spinner */ }
          { (mode == "packs" ? packSearch.loading : searchLoading && (query.length > 0 || filtersActive)) &&
            <InputGroupSuffix>
              <ProgressCircle aria-label="Loading results..." isIndeterminate className="size-5">
                <ProgressCircleTrack>
                  <ProgressCircleTrackCircle />
                  <ProgressCircleFillCircle />
                </ProgressCircleTrack>
              </ProgressCircle>
            </InputGroupSuffix>
          }
        </InputGroup>

        <Select
          aria-label="Sort by"
          value={mode == "packs" ? packSearch.sortBy : sortBy}
          onChange={v => (mode == "packs" ? packSearch.setSortBy : setSortBy)(v as SpliceSortBy)}
          className="w-48"
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

      { /* The results of both modes are kept around, so that switching back and forth doesn't lose them. */ }
      <div className={mode == "samples" ? "contents" : "hidden"}>
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
              { /* Render only the label here; the per-item icons belong in the dropdown. */ }
              <SelectValue>{({ selectedText }) => selectedText}</SelectValue>
              <SelectIndicator />
            </SelectTrigger>
            <SelectPopover>
              <ListBox>
                <ListBoxItem id="any" textValue="Any">
                  <span className="size-4 shrink-0" aria-hidden="true" />
                  Any<ListBoxItemIndicator />
                </ListBoxItem>
                <ListBoxItem id="oneshot" textValue="One-Shots">
                  <MoveRight className="size-4 shrink-0 text-muted" />
                  One-Shots<ListBoxItemIndicator />
                </ListBoxItem>
                <ListBoxItem id="loop" textValue="Loops">
                  <Repeat className="size-4 shrink-0 text-muted" />
                  Loops<ListBoxItemIndicator />
                </ListBoxItem>
              </ListBox>
            </SelectPopover>
          </Select>
        </div>

        { (query.length > 0 || filtersActive) && knownTags.length > 0 &&
          <TagPills tags={knownTags} selected={tags} onToggle={toggleTag} expandLabel="Show all tags" collapseLabel="Show fewer tags" />
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
              aria-label={packOrigin == "packs" ? "Go back to packs" : `Stop filtering by ${packFilter.name}`}
              onClick={clearPackFilter}
              className="flex items-center justify-center w-8 h-8 rounded-full shrink-0
                         cursor-pointer transition-colors hover:bg-surface-tertiary"
            >
              <X className="size-4" />
            </button>
          </div>
        }
      </div>

      { sampleDirMissing && cfg().configured &&
        <Alert status="warning" className="items-center">
          <AlertIndicator />
          <AlertContent>
            <AlertTitle>Sample folder not found</AlertTitle>
            <AlertDescription>
              Drag-and-drop won't work until you choose an existing folder in the settings.
            </AlertDescription>
          </AlertContent>
          <Button size="sm" variant="secondary" onClick={settings.open}>Open settings</Button>
        </Alert>
      }

      <div className={mode == "samples" ? "contents" : "hidden"}>
        {
          searchError != null
          ? <StatusMessage icon="img/blob-think.png" details={searchError}>Something went wrong while searching.</StatusMessage>
          : (query.length > 0 || filtersActive)
          ? results.length == 0
          ? <StatusMessage icon="img/blob-think.png">Couldn't find anything. Try changing your query and filters.</StatusMessage>
          : <div ref={resultContainer}
              className="flex-1 min-h-0 mt-2 overflow-y-auto scrollbar-thin shadow-md bg-surface p-6 rounded-3xl flex flex-col gap-6"
          >
                <div className={`flex-1 flex flex-col transition-opacity duration-150
                                ${searchLoading ? "opacity-50 pointer-events-none" : ""}`}
                >
                { results.map(
                  x => <SampleListEntry key={x.uuid} sample={x} onTagClick={handleTagClick} onPackClick={handlePackClick} playback={playback}/>
                ) }
                </div>

                <ResultPagination currentPage={currentPage} totalPages={totalPages} onChange={changePage} />
              </div>
            : <StatusMessage icon="img/blob-salute.png">Waiting for your command!</StatusMessage>
        }
      </div>

      <div className={mode == "packs" ? "contents" : "hidden"}>
        <PackList search={packSearch} onPackOpen={openPack} />
      </div>
    </main>
  );
}

export default App;
