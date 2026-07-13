import { Chip, ProgressCircle, ProgressCircleFillCircle, ProgressCircleTrack, ProgressCircleTrackCircle, Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { ClockCircleLinearIcon, ClockSquareBoldIcon } from '@heroui/shared-icons'
import { MusicalNoteIcon } from "@heroicons/react/20/solid";
import { PlayIcon, StopIcon } from "@heroicons/react/20/solid";

import { fetch } from "@tauri-apps/plugin-http";
import { useEffect, useRef, useState } from "react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";

import * as wav from "node-wav";
import { checkFileExists, createPlaceholder, writeSampleFile } from "../../native";
import { join } from "@tauri-apps/api/path";

import { cfg } from "../../config";
import { SamplePlaybackContext } from "../playback";
import { SpliceTag } from "../../splice/entities";
import { SpliceSample } from "../../splice/api";
import { decodeSpliceAudio } from "../../splice/decoder";
import Waveform from "./Waveform";

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
  const [progress, setProgress] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current == null) {
    audioRef.current = document.createElement("audio");
  }

  const audio = audioRef.current;

  const pack = sample.parents.items[0];
  const packCover = pack
    ? pack.files.find(x => x.asset_file_type_slug == "cover_image")?.url
    : "img/missing-cover.png";

  const waveformUrl = sample.files.find(x => x.asset_file_type_slug == "waveform")?.url;

  const decodedSample = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const fetchAhead = useRef<Promise<Response> | null>(null);
  function startFetching() {
    if (fetchAhead.current != null)
      return;

    const file = sample.files.find(x => x.asset_file_type_slug == "preview_mp3")!;

    fetchAhead.current = fetch(file.url);
  }

  audio.onended = () => {
    setPlaying(false);
    setProgress(0);
  };

  // While a sample is playing, keep its waveform's progress marker in
  // sync with the audio element.
  useEffect(() => {
    if (!playing)
      return;

    let raf = requestAnimationFrame(function tick() {
      setProgress(audio.duration > 0 ? audio.currentTime / audio.duration : 0);
      raf = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(raf);
  }, [playing]);

  function stop() {
    audio.pause();
    audio.currentTime = 0;
    setPlaying(false);
    setProgress(0);
  }

  async function ensurePlayable() {
    if (audio.src != "")
      return;

    setFgLoading(true);
    await ensureAudioDecoded();
    setFgLoading(false);

    audio.src = URL.createObjectURL(
      new Blob([decodedSample.current!], { "type": "audio/mpeg" })
    );
  }

  async function handlePlayClick() {
    ctx.cancellation?.();

    if (playing)
      return;

    await ensurePlayable();

    audio.play();
    setPlaying(true);

    ctx.setCancellation(() => stop);
  }

  async function handleSeek(target: number) {
    if (!playing) {
      ctx.cancellation?.();
      await ensurePlayable();
      audio.play();
      setPlaying(true);
      ctx.setCancellation(() => stop);
    }

    // The audio metadata might not be loaded yet right after setting the
    // source, so we compute the seek time from the sample's known duration.
    audio.currentTime = target * (sample.duration / 1000);
    setProgress(target);
  }

  async function ensureAudioDecoded() {
    if (decodedSample.current != null)
      return;

    if (fetchAhead.current == null) {
      startFetching();
    }

    const resp = await fetchAhead.current!;
    const data = await resp.arrayBuffer();
    decodedSample.current = decodeSpliceAudio(new Uint8Array(data));
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

      // decodeAudioData detaches the buffer we give it, so pass a copy to
      // keep the decoded sample usable for playback afterwards.
      const samples = await actx.decodeAudioData(decodedSample.current!.buffer.slice(0));
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
      <div className="flex-1 min-w-0" onMouseDown={handleDrag}>
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

      { /* waveform preview */}
      {waveformUrl &&
        <Waveform
          src={waveformUrl}
          progress={progress}
          onSeek={handleSeek}
          className="w-40 h-10 shrink-0"
        />}

      { /* other metadata */}
      <div className="grid grid-cols-3 gap-2 w-72 shrink-0" onMouseDown={handleDrag}>
        <div className="flex items-center gap-2 font-semibold text-muted whitespace-nowrap">
          <MusicalNoteIcon className="w-4 shrink-0" />
          <span>
            {sample.key != null
              ? `${sample.key.toUpperCase()}${getChordTypeDisplay(sample.chord_type)}`
              : "--"}
          </span>
        </div>

        <div className="flex items-center gap-2 font-semibold text-muted whitespace-nowrap">
          <ClockCircleLinearIcon className="shrink-0" />
          <span>{`${(sample.duration / 1000).toFixed(2)}s`}</span>
        </div>

        <div className="flex items-center gap-2 font-semibold text-muted whitespace-nowrap">
          <ClockSquareBoldIcon className="shrink-0" />
          <span>{sample.bpm != null ? `${sample.bpm} BPM` : "--"}</span>
        </div>
      </div>
    </div>
  );
}
