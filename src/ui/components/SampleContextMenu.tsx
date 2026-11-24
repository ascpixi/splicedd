import { Dropdown, DropdownItem, DropdownMenu, DropdownPopover, DropdownTrigger } from "@heroui/react";
import { Download } from "lucide-react";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { IS_MACOS } from "../../native";

/** The point that a context menu was requested at, in viewport coordinates. */
export interface ContextMenuPosition {
  x: number;
  y: number;
}

/** Whether a press of a mouse button is one that opens a context menu. */
export function isContextMenuPress(ev: { button: number, ctrlKey: boolean }) {
  return ev.button == 2 || (IS_MACOS && ev.button == 0 && ev.ctrlKey);
}

/**
 * The menu displayed when a sample is right-clicked.
 */
export default function SampleContextMenu(
  { position, isOpen, onOpenChange, onDownload }: {
    position: ContextMenuPosition,
    isOpen: boolean,
    onOpenChange: (open: boolean) => void,
    onDownload: () => void
  }
) {
  const menu = useRef<HTMLDivElement | null>(null);

  // React Aria only dismisses the menu on left clicks, and makes everything else inert in the
  // meantime. The menu has to be gone by the time the "contextmenu" event gets fired for that
  // event to reach whatever has been right-clicked, e.g. another sample.
  useEffect(() => {
    if (!isOpen)
      return;

    const dismiss = (ev: PointerEvent) => {
      if (isContextMenuPress(ev) && !menu.current?.contains(ev.target as Node)) {
        flushSync(() => onOpenChange(false));
      }
    };

    window.addEventListener("pointerdown", dismiss, { capture: true });
    return () => window.removeEventListener("pointerdown", dismiss, { capture: true });
  }, [isOpen, onOpenChange]);

  return (
    // Events from the menu itself bubble up to here. It shouldn't have a context menu of its own.
    <div className="contents" onContextMenu={ev => ev.preventDefault()}>
      <Dropdown isOpen={isOpen} onOpenChange={onOpenChange}>
        { /* The menu is anchored to its trigger, so place an invisible one under the cursor. */ }
        <DropdownTrigger
          aria-label="Sample actions"
          excludeFromTabOrder
          className="fixed size-0 pointer-events-none"
          style={{ left: position.x, top: position.y }}
        />

        <DropdownPopover placement="bottom start" offset={0}>
          <DropdownMenu ref={menu} aria-label="Sample actions">
            <DropdownItem id="download" textValue="Download" onAction={onDownload}>
              <Download className="size-4 shrink-0 text-muted" />
              Download
            </DropdownItem>
          </DropdownMenu>
        </DropdownPopover>
      </Dropdown>
    </div>
  );
}
