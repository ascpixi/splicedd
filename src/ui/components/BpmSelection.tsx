import { useState } from "react";
import {
  Button, InputGroup, InputGroupInput, Link,
  Slider, SliderFill, SliderThumb, SliderTrack,
  Tab, TabIndicator, TabList, TabPanel, Tabs, TextField
} from "@heroui/react";

export type BpmFilterType = "exact" | "range";

export interface BpmFilter {
  minBpm?: number;
  maxBpm?: number;
  bpm?: string;
}

const MIN_BPM = 1;
const MAX_BPM = 300;

const clampBpm = (x: number) => Math.min(Math.max(x, MIN_BPM), MAX_BPM);

function parseBpmInput(value: string): number | null {
  const parsed = parseInt(value);
  return isNaN(parsed) ? null : clampBpm(parsed);
}

/**
 * Provides the contents of the BPM filter popover: a "Range"/"Exact" tab pair,
 * each with a slider and matching text inputs, applied via the "Save" button.
 */
export default function BpmSelection({
  bpmType, bpm, onSave, onClear
}: {
  bpmType: BpmFilterType,
  bpm: BpmFilter | undefined,
  onSave: (type: BpmFilterType, bpm: BpmFilter) => void,
  onClear: () => void
}) {
  const [tab, setTab] = useState<BpmFilterType>(bpmType);

  const [minBpm, setMinBpm] = useState<number | null>(bpm?.minBpm ?? null);
  const [maxBpm, setMaxBpm] = useState<number | null>(bpm?.maxBpm ?? null);
  const [exactBpm, setExactBpm] = useState<number | null>(
    bpm?.bpm ? parseBpmInput(bpm.bpm) : null
  );

  const canSave = tab == "exact"
    ? exactBpm != null
    : minBpm != null || maxBpm != null;

  function handleSave() {
    if (tab == "exact") {
      onSave("exact", { bpm: exactBpm!.toString() });
    } else {
      onSave("range", {
        minBpm: minBpm ?? MIN_BPM,
        maxBpm: maxBpm ?? MAX_BPM
      });
    }
  }

  const sliderScale = () => (
    <div className="flex justify-between w-full text-sm text-muted">
      <span>{MIN_BPM}</span>
      <span>{MAX_BPM}</span>
    </div>
  );

  const bottomRow = () => (
    <div className="flex justify-between items-center w-full pt-2">
      <Link href="#" onClick={onClear}>Clear</Link>
      <Button isDisabled={!canSave} onClick={handleSave}>Save</Button>
    </div>
  );

  const bpmInput = (
    value: number | null,
    onChange: (x: number | null) => void,
    placeholder: string
  ) => (
    <TextField
      aria-label={placeholder}
      value={value?.toString() ?? ""}
      onChange={v => onChange(parseBpmInput(v))}
      className="w-16"
    >
      <InputGroup className="border border-border">
        <InputGroupInput type="number" placeholder={placeholder} />
      </InputGroup>
    </TextField>
  );

  return (
    <Tabs
      className="w-64"
      selectedKey={tab}
      onSelectionChange={x => setTab(x as BpmFilterType)}
    >
      <TabList aria-label="BPM filter type" className="w-full">
        <Tab id="range" className="flex-1 justify-center">Range<TabIndicator /></Tab>
        <Tab id="exact" className="flex-1 justify-center">Exact<TabIndicator /></Tab>
      </TabList>

      <TabPanel id="range">
        <div className="flex flex-col gap-4 pt-4">
          <div className="flex justify-between items-center">
            <h4 className="text-base font-medium">Range</h4>
            <div className="flex items-center gap-2">
              {bpmInput(minBpm, setMinBpm, "Min")}
              <span className="text-muted">-</span>
              {bpmInput(maxBpm, setMaxBpm, "Max")}
            </div>
          </div>

          <Slider
            aria-label="BPM range"
            minValue={MIN_BPM} maxValue={MAX_BPM}
            value={[minBpm ?? MIN_BPM, maxBpm ?? MAX_BPM]}
            onChange={v => {
              const [min, max] = v as number[];
              setMinBpm(min);
              setMaxBpm(max);
            }}
          >
            <SliderTrack>
              <SliderFill />
              <SliderThumb index={0} aria-label="Minimum BPM" />
              <SliderThumb index={1} aria-label="Maximum BPM" />
            </SliderTrack>
          </Slider>

          {sliderScale()}
          {bottomRow()}
        </div>
      </TabPanel>

      <TabPanel id="exact">
        <div className="flex flex-col gap-4 pt-4">
          <div className="flex justify-between items-center">
            <h4 className="text-base font-medium">Exact</h4>
            {bpmInput(exactBpm, setExactBpm, "BPM")}
          </div>

          <Slider
            aria-label="Exact BPM"
            minValue={MIN_BPM} maxValue={MAX_BPM}
            value={exactBpm ?? MIN_BPM}
            onChange={v => setExactBpm(v as number)}
          >
            <SliderTrack>
              <SliderFill />
              <SliderThumb aria-label="BPM" />
            </SliderTrack>
          </Slider>

          {sliderScale()}
          {bottomRow()}
        </div>
      </TabPanel>
    </Tabs>
  );
}
