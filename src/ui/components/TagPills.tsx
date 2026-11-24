import { useState } from "react";
import { ToggleButton } from "@heroui/react";
import { EllipsisVertical } from "lucide-react";

import { SpliceTag } from "../../splice/entities";
import { TAG_PILL_CLASSES } from "../fieldStyles";

/**
 * Provides a row of tags that can be toggled. Only a single line of them is visible until expanded.
 */
export default function TagPills({ tags, selected, onToggle, expandLabel, collapseLabel }: {
  tags: SpliceTag[],
  selected: SpliceTag[],
  onToggle: (tag: SpliceTag) => void,
  expandLabel: string,
  collapseLabel: string
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex items-start gap-2">
      { /* Selected tags are pinned to the front; the rest follow, most popular first. */ }
      <div className={`flex-1 min-w-0 flex flex-wrap gap-1.5 ${expanded ? "" : "h-9 md:h-8 overflow-hidden"}`}>
        { [...selected, ...tags.filter(x => !selected.some(y => y.uuid == x.uuid))].map(x =>
          <ToggleButton key={x.uuid} size="sm" className={TAG_PILL_CLASSES}
            isSelected={selected.some(y => y.uuid == x.uuid)}
            onChange={() => onToggle(x)}
          >{x.label}</ToggleButton>
        )}
      </div>

      <ToggleButton size="sm" isIconOnly className={TAG_PILL_CLASSES}
        aria-label={expanded ? collapseLabel : expandLabel}
        isSelected={expanded}
        onChange={setExpanded}
      >
        <EllipsisVertical className="size-4" />
      </ToggleButton>
    </div>
  );
}
