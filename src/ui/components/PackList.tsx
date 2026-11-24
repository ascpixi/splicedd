import { useRef } from "react";

import { SplicePackSearchResult, SpliceSamplePack } from "../../splice/api";
import { PackSearch } from "../packSearch";
import ResultPagination from "./ResultPagination";
import StatusMessage from "./StatusMessage";
import TagPills from "./TagPills";

/**
 * Provides a view of the packs found by the given search, alongside genres to filter them by.
 */
export default function PackList({ search, onPackOpen }: {
  search: PackSearch,
  onPackOpen: (pack: SpliceSamplePack) => void
}) {
  const container = useRef<HTMLDivElement | null>(null);

  const { results, loading, error } = search;
  const knownGenres = results?.genres ?? [];

  function changePage(page: number) {
    search.setPage(page);
    container.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  }

  return (<>
    { (knownGenres.length > 0 || search.genres.length > 0) &&
      <TagPills
        tags={knownGenres} selected={search.genres} onToggle={search.toggleGenre}
        expandLabel="Show all genres" collapseLabel="Show fewer genres"
      />
    }

    { error != null
      ? <StatusMessage icon="img/blob-think.png" details={error}>Something went wrong while searching.</StatusMessage>
      : results == null
      ? <StatusMessage icon="img/blob-think.png">Looking for packs...</StatusMessage>
      : results.packs.length == 0
      ? <StatusMessage icon="img/blob-think.png">Couldn't find any packs. Try changing your query and genres.</StatusMessage>
      : <div ref={container}
          className="flex-1 min-h-0 mt-2 overflow-y-auto scrollbar-thin shadow-md bg-surface p-6 rounded-3xl flex flex-col gap-6"
        >
          <div className={`flex-1 grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] content-start gap-x-2 gap-y-4
                          transition-opacity duration-150 ${loading ? "opacity-50 pointer-events-none" : ""}`}
          >
            { results.packs.map(x => <PackCard key={x.uuid} pack={x} onOpen={() => onPackOpen(x)} />) }
          </div>

          <ResultPagination currentPage={search.page} totalPages={results.totalPages} onChange={changePage} />
        </div>
    }
  </>);
}

function PackCard({ pack, onOpen }: {
  pack: SplicePackSearchResult,
  onOpen: () => void
}) {
  const cover = pack.files.find(x => x.asset_file_type_slug == "cover_image")?.url ?? "img/missing-cover.png";

  return (
    <button
      type="button"
      onClick={onOpen}
      title={pack.name}
      className="flex flex-col gap-2 p-2 min-w-0 rounded-2xl text-left select-none
                 cursor-pointer transition-colors hover:bg-surface-secondary"
    >
      <img
        src={cover} alt="" loading="lazy" draggable={false}
        className="w-full aspect-square rounded-lg object-cover bg-surface-tertiary"
      />

      <span className="flex flex-col w-full min-w-0">
        <span className="line-clamp-2 wrap-break-word font-medium leading-snug">{pack.name}</span>
        { pack.provider != null && <span className="truncate text-sm text-muted">{pack.provider.name}</span> }
        { pack.main_genre && <span className="truncate text-xs text-muted">{pack.main_genre}</span> }
      </span>
    </button>
  );
}
