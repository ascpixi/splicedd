import { ReactNode } from "react";

/**
 * Takes up the place of search results when there are none to display.
 */
export default function StatusMessage({ icon, details, children }: {
  icon: string,
  details?: string,
  children: ReactNode
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
      <img className="w-12 select-none" src={icon} alt="" draggable={false} />
      <div className="space-y-1">
        <p className="text-muted">{children}</p>
        { details != null && <p className="text-sm text-muted/75 max-w-xl">{details}</p> }
      </div>
    </div>
  );
}
