import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationNextIcon, PaginationPrevious, PaginationPreviousIcon } from "@heroui/react";

function buildPageList(current: number, total: number): (number | "ellipsis")[] {
  const pages: (number | "ellipsis")[] = [];
  for (let p = 1; p <= total; p++) {
    if (p === 1 || p === total || Math.abs(p - current) <= 2) {
      pages.push(p);
    }
    else if (pages[pages.length - 1] !== "ellipsis") {
      pages.push("ellipsis");
    }
  }
  return pages;
}

/**
 * Allows the user to switch between pages of search results. Not displayed if there's only a single page.
 */
export default function ResultPagination({ currentPage, totalPages, onChange }: {
  currentPage: number,
  totalPages: number,
  onChange: (page: number) => void
}) {
  if (totalPages <= 1)
    return null;

  return (
    <div className="w-full flex justify-center">
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={() => onChange(Math.max(1, currentPage - 1))}
              isDisabled={currentPage <= 1}
            >
              <PaginationPreviousIcon />
            </PaginationPrevious>
          </PaginationItem>
          {buildPageList(currentPage, totalPages).map((p, i) =>
            p === "ellipsis"
              ? <PaginationItem key={`ellipsis-${i}`}><PaginationEllipsis /></PaginationItem>
              : <PaginationItem key={p}>
                  <PaginationLink isActive={p === currentPage} onClick={() => onChange(p)}>{p}</PaginationLink>
                </PaginationItem>
          )}
          <PaginationItem>
            <PaginationNext
              onClick={() => onChange(Math.min(totalPages, currentPage + 1))}
              isDisabled={currentPage >= totalPages}
            >
              <PaginationNextIcon />
            </PaginationNext>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
