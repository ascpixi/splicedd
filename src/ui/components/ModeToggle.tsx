import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { AudioLines, Package } from "lucide-react";

/** What the user is currently looking for. */
export type BrowsingMode = "samples" | "packs";

/** Makes the buttons match the other fields. The group clips them to the shape of one. */
const MODE_BUTTON_CLASSES = [
  "rounded-none!",
  "[--toggle-button-bg:var(--field-background)]",
  "[--toggle-button-bg-hover:var(--field-hover)]",
  "[--toggle-button-bg-pressed:var(--field-hover)]"
].join(" ");

/**
 * Switches between looking for individual samples and entire sample packs.
 */
export default function ModeToggle({ mode, onChange }: {
  mode: BrowsingMode,
  onChange: (mode: BrowsingMode) => void
}) {
  return (
    <ToggleButtonGroup
      aria-label="Search for"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[mode]}
      onSelectionChange={keys => onChange([...keys][0] as BrowsingMode)}
      className="shrink-0 rounded-field border border-border overflow-hidden"
    >
      <ToggleButton id="samples" className={MODE_BUTTON_CLASSES}>
        <AudioLines className="size-4" />
        Samples
      </ToggleButton>
      <ToggleButton id="packs" className={MODE_BUTTON_CLASSES}>
        <Package className="size-4" />
        Packs
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
