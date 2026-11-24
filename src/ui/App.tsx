import { useEffect, useRef, useState } from "react";

import { Alert, AlertContent, AlertDescription, AlertIndicator, AlertTitle, Button, ListBox, ListBoxItem, ListBoxItemIndicator, ModalBackdrop, ModalCloseTrigger, ModalContainer, ModalDialog, ProgressCircle, ProgressCircleFillCircle, ProgressCircleTrack, ProgressCircleTrackCircle, useOverlayState } from "@heroui/react";
import { InputGroup, InputGroupInput, InputGroupPrefix, InputGroupSuffix, Modal, Popover, PopoverContent, PopoverDialog, Select, SelectIndicator, SelectPopover, SelectTrigger, SelectValue } from "@heroui/react";
import { ArrowUpDown, ChevronDown, Disc3, Guitar, Layers, Metronome, MoveRight, Music2, Repeat, Search, Wrench, X } from "lucide-react";
import { cfg } from "../config";
import { SpliceSamplePack } from "../splice/api";
import { SpliceSampleType, SpliceSortBy, SpliceTag } from "../splice/entities";

import SampleListEntry from "./components/SampleListEntry";
import SettingsModalContent from "./components/SettingsModalContent";
import UpdateModal from "./components/UpdateModal";
import { UpdateInfo, checkForUpdates } from "../updater";
import KeyScaleSelection from "./components/KeyScaleSelection";
import BpmSelection from "./components/BpmSelection";
import ModeToggle, { BrowsingMode } from "./components/ModeToggle";
import PackList from "./components/PackList";
import ResultPagination from "./components/ResultPagination";
import StatusMessage from "./components/StatusMessage";
import TagPills from "./components/TagPills";
import { usePackSearch } from "./packSearch";
import { useSampleSearch } from "./sampleSearch";
import { PlaybackController } from "./playback";
import { checkDirExists } from "../native";
import { createLogger } from "../log";
import { FIELD_BUTTON_CLASSES, NO_PRESS_SCALE } from "./fieldStyles";

const log = createLogger("app");

function App() {
  const settings = useOverlayState({
    defaultOpen: !cfg().configured
  });

  const [mode, setMode] = useState<BrowsingMode>("samples");
  const packSearch = usePackSearch(mode == "packs");

  const search = useSampleSearch();
  const { sortBy, sampleType, bpmType, bpm, instruments, genres, tags, musicKey, chordType, pack: packFilter } = search.params;

  const [bpmOpen, setBpmOpen] = useState(false);

  const resultContainer = useRef<HTMLDivElement | null>(null);

  // Where the pack that's being filtered by was picked, which is where the user is taken back to afterwards.
  const [packOrigin, setPackOrigin] = useState<BrowsingMode>("samples");

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
    tags.length > 0 || instruments.length > 0 || genres.length > 0 ||
    musicKey != null || chordType != null || bpm != null || sampleType != "any" ||
    packFilter != null;

  const resultsVisible = search.query.length > 0 || filtersActive;

  const [playback] = useState(() => new PlaybackController());

  // Stop any playing sample when the window loses focus (e.g. the user tabs
  // away or drags a sample into their DAW).
  useEffect(() => {
    const stopOnBlur = () => playback.stop();
    window.addEventListener("blur", stopOnBlur);
    return () => window.removeEventListener("blur", stopOnBlur);
  }, [playback]);

  useEffect(() => {
    playback.stop(); // the sample that's playing might not be a part of the new results
    resultContainer.current?.scrollTo({ top: 0, left: 0 });
  }, [playback, search.results]);

  function changeMode(newMode: BrowsingMode) {
    playback.stop(); // the sample that's playing is about to be hidden
    setMode(newMode);
  }

  function ensureOptionsGathered() {
    const { options, error, loading } = search;
    if (error != null && !loading && (options.instruments.length == 0 || options.genres.length == 0)) {
      search.retry();
    }
  }

  function changePage(n: number) {
    search.setPage(n);
    resultContainer.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  }

  function handleSearchInput(ev: React.ChangeEvent<HTMLInputElement>) {
    if (mode == "packs") {
      packSearch.setQuery(ev.target.value);
      return;
    }

    search.setQuery(ev.target.value);
  }

  function handleSearchKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key != "Enter")
      return;

    if (mode == "packs") {
      packSearch.submit();
    }
    else {
      search.submit();
    }
  }

  function toggleTag(tag: SpliceTag) {
    search.refine({
      tags: tags.some(x => x.uuid == tag.uuid)
        ? tags.filter(x => x.uuid != tag.uuid)
        : [...tags, tag]
    });
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

    search.refine({ pack });
    setPackOrigin("samples");
  }

  function clearPackFilter() {
    search.refine({ pack: null });
    changeMode(packOrigin);
  }

  /**
   * Shows all samples from a pack picked from the list of packs. Whatever was searched for beforehand
   * is unrelated to the pack, and would most likely hide everything that's in it.
   */
  function openPack(pack: SpliceSamplePack) {
    search.refine({
      query: "",
      tags: [],
      instruments: [],
      genres: [],
      musicKey: null,
      chordType: null,
      bpm: undefined,
      sampleType: "any",
      pack
    });

    setPackOrigin("packs");
    changeMode("samples");
  }

  // When there's nothing to display, this needs to be around for the user to be able to leave the page.
  const pagination = <ResultPagination currentPage={search.params.page} totalPages={search.totalPages} onChange={changePage} />;

  return (
    <main className="flex flex-col gap-2 h-screen p-6">
      <Modal isOpen={settings.isOpen} onOpenChange={settings.setOpen}>
        <ModalBackdrop isDismissable={false} isKeyboardDismissDisabled={!cfg().configured}>
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
            value={mode == "packs" ? packSearch.query : search.query}
            onKeyDown={handleSearchKeyDown}
            onChange={handleSearchInput}
          />
          { /* With no query or filters, a search only fetches the filter options
               in the background (results aren't shown), so don't show a spinner */ }
          { (mode == "packs" ? packSearch.loading : search.loading && resultsVisible) &&
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
          onChange={v => mode == "packs" ? packSearch.setSortBy(v as SpliceSortBy) : search.refine({ sortBy: v as SpliceSortBy })}
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
            value={instruments}
            onChange={x => search.refine({ instruments: x as string[] })}
            className="flex-1 min-w-0"
            fullWidth
          >
            <SelectTrigger onPress={ensureOptionsGathered} className="max-w-full">
              <Guitar className="size-4 me-2 self-center shrink-0 text-muted" />
              <SelectValue className="truncate" />
              <SelectIndicator />
            </SelectTrigger>
            <SelectPopover>
              <ListBox items={search.options.instruments}>
                {(x: SpliceTag) => <ListBoxItem id={x.uuid} textValue={x.label}>{x.label}<ListBoxItemIndicator /></ListBoxItem>}
              </ListBox>
            </SelectPopover>
          </Select>

          <Select aria-label="Genres"
            selectionMode="multiple"
            placeholder="Genres"
            value={genres}
            onChange={x => search.refine({ genres: x as string[] })}
            className="flex-1 min-w-0"
            fullWidth
          >
            <SelectTrigger onPress={ensureOptionsGathered} className="max-w-full">
              <Disc3 className="size-4 me-2 self-center shrink-0 text-muted" />
              <SelectValue className="truncate" />
              <SelectIndicator />
            </SelectTrigger>
            <SelectPopover>
              <ListBox items={search.options.genres}>
                {(x: SpliceTag) => <ListBoxItem id={x.uuid} textValue={x.label}>{x.label}<ListBoxItemIndicator /></ListBoxItem>}
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
                  onChordSet={chordType => search.refine({ chordType })}
                  onKeySet={musicKey => search.refine({ musicKey })}
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
                    search.refine({ bpmType: type, bpm: newBpm });
                    setBpmOpen(false);
                  }}
                  onClear={() => {
                    search.refine({ bpm: undefined });
                    setBpmOpen(false);
                  }}
                />
              </PopoverDialog>
            </PopoverContent>
          </Popover>

          <Select aria-label="Type"
            value={sampleType}
            onChange={v => search.refine({ sampleType: v as SpliceSampleType | "any" })}
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

        { resultsVisible && (search.options.tags.length > 0 || tags.length > 0) &&
          <TagPills tags={search.options.tags} selected={tags} onToggle={toggleTag} expandLabel="Show all tags" collapseLabel="Show fewer tags" />
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
          search.error != null
          ? <>
              <StatusMessage icon="img/blob-think.png" details={search.error}>Something went wrong while searching.</StatusMessage>
              { search.params.page > 1 && pagination }
            </>
          : resultsVisible
          ? search.results == null
          ? <StatusMessage icon="img/blob-think.png">Looking for samples...</StatusMessage>
          : search.results.length == 0
          ? <>
              <StatusMessage icon="img/blob-think.png">Couldn't find anything. Try changing your query and filters.</StatusMessage>
              { search.params.page > 1 && pagination }
            </>
          : <div ref={resultContainer}
              className="flex-1 min-h-0 mt-2 overflow-y-auto scrollbar-thin shadow-md bg-surface p-6 rounded-3xl flex flex-col gap-6"
          >
                <div className={`flex-1 flex flex-col transition-opacity duration-150
                                ${search.loading ? "opacity-50 pointer-events-none" : ""}`}
                >
                { search.results.map(
                  x => <SampleListEntry key={x.uuid} sample={x} onTagClick={handleTagClick} onPackClick={handlePackClick} playback={playback}/>
                ) }
                </div>

                { pagination }
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
