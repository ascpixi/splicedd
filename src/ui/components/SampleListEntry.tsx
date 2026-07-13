import { Chip, ProgressCircle, ProgressCircleFillCircle, ProgressCircleTrack, ProgressCircleTrackCircle, Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { ClockCircleLinearIcon, ClockSquareBoldIcon } from '@heroui/shared-icons'
import { MusicalNoteIcon } from "@heroicons/react/20/solid";
import { PlayIcon, StopIcon } from "@heroicons/react/20/solid";

import { fetch } from "@tauri-apps/plugin-http";
import { useState } from "react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";

import * as wav from "node-wav";
import { checkFileExists, createPlaceholder, writeSampleFile } from "../../native";
import { join } from "@tauri-apps/api/path";

import { cfg } from "../../config";
import { SamplePlaybackContext } from "../playback";
import { SpliceTag } from "../../splice/entities";
import { SpliceSample } from "../../splice/api";
import { decodeSpliceAudio } from "../../splice/decoder";

const getChordTypeDisplay = (type: string | null) =>
  type == null ? "" : type == "major" ? " Major" : " Minor";

export type TagClickHandler = (tag: SpliceTag) => void;

/**
 * Provides a view describing a Splice sample.
 */
export default function SampleListEntry(
  { sample, ctx, onTagClick }: {
    sample: SpliceSample,
    ctx: SamplePlaybackContext,
    onTagClick: TagClickHandler
  }
) {
  const [fgLoading, setFgLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audio = document.createElement("audio");

  const pack = sample.parents.items[0];
  const packCover = pack
    ? pack.files.find(x => x.asset_file_type_slug == "cover_image")?.url
    : "img/missing-cover.png";

  let decodedSample: Uint8Array<ArrayBuffer> | null = null;

  let fetchAhead: Promise<Response> | null = null;
  function startFetching() {
    if (fetchAhead != null)
      return;

    const file = sample.files.find(x => x.asset_file_type_slug == "preview_mp3")!;

    fetchAhead = fetch(file.url);
  }

  audio.onended = () => setPlaying(false);

  function stop() {
    audio.pause();
    audio.currentTime = 0;
    setPlaying(false);
  }

  async function handlePlayClick() {
    ctx.cancellation?.();

    if (playing)
      return;

    if (audio.src == "") {
      setFgLoading(true);
      await ensureAudioDecoded();
      setFgLoading(false);

      audio.src = URL.createObjectURL(
        new Blob([decodedSample!], { "type": "audio/mpeg" })
      );
    }

    audio.play();
    setPlaying(true);

    ctx.setCancellation(() => stop);
  }

  async function ensureAudioDecoded() {
    if (decodedSample != null)
      return;

    if (fetchAhead == null) {
      startFetching();
    }

    const resp = await fetchAhead!;
    const data = await resp.arrayBuffer();
    decodedSample = decodeSpliceAudio(new Uint8Array(data));
  }

  const sanitizePath = (x: string) => x.replace(/[<>:"|?* ]/g, "_");

  async function handleDrag(ev: React.MouseEvent<HTMLDivElement, MouseEvent>) {
    // Verify that the parent of the element that we began the dragging from
    // is not explicitly marked as non-draggable (as it may be clicked etc.)
    const dragOrigin = document.elementFromPoint(ev.clientX, ev.clientY)?.parentElement;
    if (dragOrigin != null && dragOrigin.dataset.draggable === "false") {
      return;
    }

    const samplePath = sanitizePath(pack.name) + "/" + sanitizePath(sample.name);

    const dragParams = {
      item: [await join(cfg().sampleDir, samplePath)],
      icon: ""
    };

    setFgLoading(true);
    await ensureAudioDecoded();

    if (!await checkFileExists(cfg().sampleDir, samplePath)) {
      if (cfg().placeholders) {
        await createPlaceholder(cfg().sampleDir, samplePath);
        startDrag(dragParams);
      }

      const actx = new AudioContext();

      const samples = await actx.decodeAudioData(decodedSample!.buffer);
      const channels: Float32Array[] = [];

      if (samples.length < 60 * 44100) {
        for (let i = 0; i < samples.numberOfChannels; i++) {
          const chan = samples.getChannelData(i);

          const start = 1200;
          const end = ((sample.duration / 1000) * samples.sampleRate) + start;

          channels.push(chan.subarray(start, end));
        }
      } else {
        // processing big samples may result in memory allocation errors (it sure did for me!!)
        console.warn(`big boi detected of ${samples.length} samples - not pre-processing!`);
      }

      await writeSampleFile(cfg().sampleDir, samplePath, wav.encode(channels as unknown as ArrayBuffer[], {
        bitDepth: 16,
        sampleRate: samples.sampleRate
      }));

      if (!cfg().placeholders) {
        startDrag(dragParams);
      }

      setFgLoading(false);
    } else {
      setFgLoading(false);
      startDrag(dragParams);
    }
  }

  return (
    <div onMouseOver={startFetching}
      className={`flex w-full px-4 py-2 gap-8 rounded transition-colors
                    items-center hover:bg-surface-secondary cursor-grab select-none`}
    >
      { /* when loading, set the cursor for everything to a waiting icon */}
      {fgLoading && <style> {`* { cursor: wait }`} </style>}

      { /* sample pack */}
      <div className="flex gap-4 min-w-20">
        <Tooltip>
          <TooltipTrigger>
            <a href={`https://splice.com/sounds/labels/${pack.permalink_base_url}`} target="_blank">
              <img src={packCover} alt={pack.name} width={32} height={32} />
            </a>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-2 p-4">
              <img src={packCover} alt={pack.name} width={128} height={128}></img>
              <h1>{pack.name}</h1>
            </div>
          </TooltipContent>
        </Tooltip>

        <div onClick={handlePlayClick} className="cursor-pointer w-8">
          {fgLoading
            ? <ProgressCircle aria-label="Loading sample..." className="h-8" isIndeterminate>
                <ProgressCircleTrack>
                  <ProgressCircleTrackCircle />
                  <ProgressCircleFillCircle />
                </ProgressCircleTrack>
              </ProgressCircle>
            : playing ? <StopIcon /> : <PlayIcon />}
        </div>
      </div>

      { /* sample name + tags */}
      <div className="grow" onMouseDown={handleDrag}>
        <div className="flex gap-1 max-w-[50vw] overflow-clip">
          {sample.name.split("/").pop()}
          <div className="text-muted">({sample.asset_category_slug})</div>
        </div>

        <div className="flex gap-1">{sample.tags.map(x => (
          <Chip key={x.uuid}
            size="sm" style={{ cursor: "pointer" }}
            onClick={() => onTagClick(x)}
            data-draggable="false"
          >
            {x.label}
          </Chip>
        ))}</div>
      </div>

      { /* other metadata */}
      <div className="flex gap-8" onMouseDown={handleDrag}>
        {sample.key != null ?
          <div className="flex items-center gap-2 font-semibold text-muted">
            <MusicalNoteIcon className="w-4" />
            <span>{`${sample.key.toUpperCase()}${getChordTypeDisplay(sample.chord_type)}`}</span>
          </div>
          : <></>}

        <div className="flex items-center gap-2 font-semibold text-muted">
          <ClockCircleLinearIcon />
          <span>{`${(sample.duration / 1000).toFixed(2)}s`}</span>
        </div>

        {sample.bpm != null ?
          <div className="flex items-center gap-2 font-semibold text-muted">
            <ClockSquareBoldIcon />
            <span>{`${sample.bpm} BPM`}</span>
          </div>
          : <></>}
      </div>
    </div>
  );
}
