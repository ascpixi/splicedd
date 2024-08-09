import { useEffect, useRef, useState } from "react";

import { Button } from "@nextui-org/button";
import { SearchIcon, ChevronDownIcon } from '@nextui-org/shared-icons'
import { WrenchIcon } from "@heroicons/react/20/solid";
import { CircularProgress, Input, Modal, Pagination, Popover, PopoverContent, PopoverTrigger, Radio, RadioGroup, Select, SelectItem, useDisclosure } from "@nextui-org/react";
import { fetch } from '@tauri-apps/api/http';

import { cfg } from "../config";
import { GRAPHQL_URL, SpliceSample, SpliceSearchResponse, createSearchRequest } from "../splice/api";
import { ChordType, MusicKey, SpliceSampleType, SpliceSortBy, SpliceTag } from "../splice/entities";

import SampleListEntry from "./components/SampleListEntry";
import SettingsModalContent from "./components/SettingsModalContent";
import KeyScaleSelection from "./components/KeyScaleSelection";
import { SamplePlaybackCancellation, SamplePlaybackContext } from "./playback";

function App() {
  const settings = useDisclosure({
    defaultOpen: !cfg().configured
  });

  const [bpmType, setBpmType] = useState<"exact" | "range">("exact");
  const [bpm, setBpm] = useState<{
    minBpm?: number,
    maxBpm?: number,
    bpm?: string
  }>();

  const [query, setQuery] = useState("");

  const [results, setResults] = useState<SpliceSample[]>([]);
  const [resultCount, setResultCount] = useState(0);
  const resultContainer = useRef<HTMLDivElement | null>(null);

  const [queryTimer, setQueryTimer] = useState<NodeJS.Timeout | null>(null);

  const [sortBy, setSortBy] = useState<SpliceSortBy>("relevance");
  const [sampleType, setSampleType] = useState<SpliceSampleType | "any">("any")

  const [knownInstruments, setKnownInstruments] = useState<{name: string, uuid: string}[]>([]);
  const [knownGenres, setKnownGenres] = useState<{name: string, uuid: string}[]>([]);

  const [instruments, setInstruments] = useState(new Set<string>([]));
  const [genres, setGenres] = useState(new Set<string>([]));
  let [tags, setTags] = useState<SpliceTag[]>([]);

  const [musicKey, setMusicKey] = useState<MusicKey | null>(null);
  const [chordType, setChordType] = useState<ChordType | null>(null);

  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  const [searchLoading, setSearchLoading] = useState(false);

  useEffect(() => {
    updateSearch(query);
  }, [
    sortBy, bpm, bpmType, sampleType,
    instruments, genres, currentPage,
    musicKey, chordType
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
    let selfTimer = setTimeout(() => updateSearch(ev.target.value, true), 100);
    setQueryTimer(selfTimer);
  }

  function handleSearchKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key == "Enter") {
      updateSearch(query, true);
    }
  }

  function updateTagState(selectedKeys: Set<string>) {
    tags = tags.filter(x => Array.from(selectedKeys).some(y => x.uuid == y));
    setTags(tags);
    updateSearch(query, true);
  }

  function handleTagClick(tag: SpliceTag) {
    if (tags.some(x => x.uuid == tag.uuid)) {
      return;
    }

    tags = [...tags, tag];
    setTags(tags);
    updateSearch(query, true);
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
      
      payload.variables.page = resetPage ? 1 : currentPage;

      setSearchLoading(true);

      const resp = await fetch<SpliceSearchResponse>(GRAPHQL_URL, {
        method: "POST",
        body: {
          type: "Json",
          payload
        }
      });

      setSearchLoading(false);

      pbCtx.cancellation?.(); // stop any sample that's currently playing

      const data = resp.data.data.assetsSearch;

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
  }

  return (
    <main className="flex flex-col gap-2 m-8 h-screen">
      <Modal size="3xl" isDismissable={false} hideCloseButton={!cfg().configured}
            isOpen={settings.isOpen} onOpenChange={settings.onOpenChange}
      >
        <SettingsModalContent/>
      </Modal>

      <div className="flex gap-2">
        <Input
            type="text"
            aria-label="Search for samples"
            placeholder="Search for samples..."
            labelPlacement="outside"
            variant="bordered"
            value={query}
            onKeyDown={handleSearchKeyDown}
            onChange={handleSearchInput}
            startContent={
              <SearchIcon className="w-6" />
            }
          />

        <Select variant="bordered"
          aria-label="Sort by"
          selectedKeys={[sortBy]} onChange={e => setSortBy(e.target.value as SpliceSortBy)}
          startContent={<span className="w-20 text-sm text-foreground-400">Sort by: </span>}
        >
            <SelectItem key="relevance">Most relevant</SelectItem>
            <SelectItem key="popularity">Most popular</SelectItem>
            <SelectItem key="recency">Most recent</SelectItem>
            <SelectItem key="random">Random</SelectItem>
        </Select>

        <Button isIconOnly variant="bordered" aria-label="Settings" onClick={settings.onOpen}>
          <WrenchIcon className="w-4" />
        </Button>
      </div>

      <div className="flex gap-2">
        <Select placeholder="Instruments" aria-label="Instruments" variant="bordered"
          selectionMode="multiple" onOpenChange={ensureContraintsGathered}
          selectedKeys={instruments}
          onSelectionChange={x => setInstruments(x as Set<string>)}
        >
          { knownInstruments.map(x => <SelectItem key={x.uuid}>{x.name}</SelectItem>) }
        </Select>

        <Select placeholder="Genres" aria-label="Genres" variant="bordered"
          selectionMode="multiple" onOpenChange={ensureContraintsGathered}
          selectedKeys={genres}
          onSelectionChange={x => setGenres(x as Set<string>)}
        >
          { knownGenres.map(x => <SelectItem key={x.uuid}>{x.name}</SelectItem>) }
        </Select>

        <Select placeholder="Tags" aria-label="Tags" variant="bordered"
          selectionMode="multiple"
          selectedKeys={Array.from(tags).map(x => x.uuid)}
          onSelectionChange={x => updateTagState(x as Set<string>)}
          className="w-1/2"
        >
          { Array.from(tags).map(x => <SelectItem key={x.uuid}>{x.label}</SelectItem>) }
        </Select>

        <Popover placement="bottom" showArrow={true}>
          <PopoverTrigger>
            <Button variant="bordered" className="w-96" endContent={<ChevronDownIcon/>}>
              { 
                (musicKey == null && chordType == null) ? "Key"
                  : `${musicKey ?? ""}${chordType == null ? "" : chordType == "major" ? " Major" : " Minor"}`
              }
            </Button>
          </PopoverTrigger>

          <PopoverContent className="flex p-8 ">
            <KeyScaleSelection
              onChordSet={setChordType} onKeySet={setMusicKey}
              selectedChord={chordType} selectedKey={musicKey}
            />
          </PopoverContent>
        </Popover>

        <Popover placement="bottom" showArrow={true}>
          <PopoverTrigger>
            <Button variant="bordered" className="w-96" endContent={<ChevronDownIcon/>}>
              { (bpmType == "exact" && bpm?.bpm
                  ? `${bpm?.bpm} BPM`
                  : bpmType == "range" && bpm?.maxBpm && bpm.minBpm
                    ? `${bpm.minBpm} - ${bpm.maxBpm} BPM`
                    : "BPM"
                )
              } 
            </Button>
          </PopoverTrigger>

          <PopoverContent className="p-8 flex items-start justify-start">
            <RadioGroup defaultValue="exact" value={bpmType}>
              <Radio value="exact" onChange={() => setBpmType("exact")}>Exact</Radio>
              <Radio value="range" onChange={() => setBpmType("range")}>Range</Radio>
            </RadioGroup>

            <br/>

            {
              bpmType == "exact" ? (
                <div>
                  <Input
                    type="number" variant="bordered"
                    label="BPM" labelPlacement="outside"
                    placeholder="(tempo)"
                    onChange={e => setBpm({ ...bpm, bpm: e.target.value })}
                    value={bpm?.bpm?.toString() ?? ""}
                  />
                </div>
              ) : (
                <div className="flex flex-col align-middle justify-center items-center gap-2">
                  <Input
                    type="number" variant="bordered"
                    label="Minimum" labelPlacement="outside" endContent="BPM" placeholder="(tempo)"
                    onChange={e => setBpm({...bpm, minBpm: parseInt(e.target.value) })}
                    value={bpm?.minBpm?.toString() ?? ""}
                  />

                  <div className="align-middle">to</div>

                  <Input
                    type="number" variant="bordered"
                    label="Maximum" labelPlacement="outside" endContent="BPM" placeholder="(tempo)"
                    onChange={e => setBpm({...bpm, maxBpm: parseInt(e.target.value) })}
                    value={bpm?.maxBpm?.toString() ?? ""}
                  />
                </div>
              )
            }
          </PopoverContent>
        </Popover>

        <Select aria-label="Type"
          selectedKeys={[sampleType]} onChange={e => setSampleType(e.target.value as SpliceSampleType)}
          variant="bordered" className="max-w-32"
        >
          <SelectItem key="any">Any</SelectItem>
          <SelectItem key="oneshot">One-Shots</SelectItem>
          <SelectItem key="loop">Loops</SelectItem>
        </Select>
      </div>

      {
        query.length > 0 && results
        ? results.length == 0
        ? <div className="flex flex-col items-center h-full justify-center space-y-6">
            <img className="w-12" src="img/blob-think.png"/>
            <p className="text-foreground-400">Couldn't find anything. Try changing your query and filters.</p>
          </div>
        : <div ref={resultContainer}
            className="my-4 mb-16 overflow-y-scroll shadow-small bg-content1 p-8 rounded flex flex-col gap-8"
        >
              <div className="flex justify-between">
                <div className="space-y-1">
                  <h4 className="text-medium font-medium">Samples</h4>
                  <p className="text-small text-default-400">Found {resultCount} sample{results.length != 1 ? "s" : ""} in total.</p>
                </div>

                <div> { searchLoading && <CircularProgress aria-label="Loading results..."/> } </div>
              </div>

              <div className="flex-1 flex flex-col">
              { results.map(
                x => <SampleListEntry key={x.uuid} sample={x} onTagClick={handleTagClick} ctx={pbCtx}/>
              ) }
              </div>

              <div className="w-full flex justify-center">
                <Pagination variant="bordered" total={totalPages}
                  page={currentPage} onChange={changePage}
                />
              </div>
            </div>
          : <div className="flex flex-col items-center h-full justify-center space-y-6">
              <img className="w-12" src="img/blob-salute.png"/>
              <p className="text-foreground-400">Waiting for your command!</p>
            </div>
      }
    </main>
  );
}

export default App;
