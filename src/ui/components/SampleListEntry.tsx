import { Chip, ProgressCircle, ProgressCircleFillCircle, ProgressCircleTrack, ProgressCircleTrackCircle, Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { Clock, Metronome, Music2, Play, Square } from "lucide-react";

import { fetch } from "@tauri-apps/plugin-http";
import { useEffect, useRef, useState } from "react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";

import * as wav from "node-wav";
import { checkFileExists, createPlaceholder, writeSampleFile } from "../../native";
import { join } from "@tauri-apps/api/path";

import { cfg } from "../../config";
import { SamplePlaybackContext } from "../playback";
import { SpliceTag } from "../../splice/entities";
import { SpliceSample, SpliceSamplePack } from "../../splice/api";
import { decodeSpliceAudio } from "../../splice/decoder";
import Waveform from "./Waveform";

const getChordTypeDisplay = (type: string | null) =>
  type == null ? "" : type == "major" ? " Major" : " Minor";

export type TagClickHandler = (tag: SpliceTag) => void;
export type PackClickHandler = (pack: SpliceSamplePack) => void;

/**
 * Provides a view describing a Splice sample.
 */
export default function SampleListEntry(
  { sample, ctx, onTagClick, onPackClick }: {
    sample: SpliceSample,
    ctx: SamplePlaybackContext,
    onTagClick: TagClickHandler,
    onPackClick: PackClickHandler
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
    try {
      await ensureAudioDecoded();
    } finally {
      setFgLoading(false);
    }

    audio.src = URL.createObjectURL(
      new Blob([decodedSample.current!], { "type": "audio/mpeg" })
    );
  }

  async function handlePlayClick() {
    ctx.cancellation?.();

    if (playing)
      return;

    try {
      await ensurePlayable();
    } catch (err) {
      console.error("failed to load sample preview:", err);
      return;
    }

    audio.play();
    setPlaying(true);

    ctx.setCancellation(() => stop);
  }

  async function handleSeek(target: number) {
    if (!playing) {
      ctx.cancellation?.();

      try {
        await ensurePlayable();
      } catch (err) {
        console.error("failed to load sample preview:", err);
        return;
      }

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
    try {
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
      } else {
        startDrag(dragParams);
      }
    } catch (err) {
      console.error("failed to prepare sample for dragging:", err);
    } finally {
      setFgLoading(false);
    }
  }

  return (
    <div onMouseOver={startFetching}
      className={`group flex w-full px-3 py-2 gap-6 rounded-2xl transition-colors
                    items-center hover:bg-surface-secondary cursor-grab select-none`}
    >
      { /* when loading, set the cursor for everything to a waiting icon */}
      {fgLoading && <style> {`* { cursor: wait }`} </style>}

      { /* pack cover + play/stop control */}
      <div className="flex items-center gap-3 shrink-0">
        <Tooltip>
          <TooltipTrigger>
            <button
              type="button"
              onClick={() => onPackClick(pack)}
              aria-label={`Show samples from ${pack.name}`}
              data-draggable="false"
              className="cursor-pointer"
            >
              <img
                src={packCover} alt={pack.name}
                width={36} height={36}
                className="rounded-sm object-cover"
                draggable={false}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-2 p-3 max-w-40">
              <img src={packCover} alt={pack.name} width={128} height={128} className="rounded-lg" />
              <span className="text-sm font-medium">{pack.name}</span>
              <span className="text-xs text-muted text-balance">Click to show samples from this pack</span>
            </div>
          </TooltipContent>
        </Tooltip>

        <button
          type="button"
          onClick={handlePlayClick}
          aria-label={playing ? "Stop playback" : "Play sample"}
          data-draggable="false"
          className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0
                      cursor-pointer transition-colors hover:bg-surface-tertiary
                      ${playing ? "text-accent" : "text-current"}`}
        >
          {fgLoading
            ? <ProgressCircle aria-label="Loading sample..." className="h-6" isIndeterminate>
                <ProgressCircleTrack>
                  <ProgressCircleTrackCircle />
                  <ProgressCircleFillCircle />
                </ProgressCircleTrack>
              </ProgressCircle>
            : playing
              ? <Square className="size-4" fill="currentColor" />
              : <Play className="size-4" fill="currentColor" />}
        </button>
      </div>

      { /* sample name + tags */}
      <div className="flex-1 min-w-0 space-y-1" onMouseDown={handleDrag}>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="truncate">{sample.name.split("/").pop()}</span>
          <span className="text-sm text-muted shrink-0">
            {sample.asset_category_slug == "oneshot" ? "one-shot" : "loop"}
          </span>
        </div>

        <div className="flex gap-1 overflow-hidden">{sample.tags.map(x => (
          <Chip key={x.uuid}
            size="sm" className="cursor-pointer shrink-0"
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
      <div className="grid grid-cols-3 gap-2 w-64 shrink-0 text-sm text-muted tabular-nums"
        onMouseDown={handleDrag}
      >
        <div className="flex items-center gap-1.5 whitespace-nowrap" title="Key">
          <Music2 className="size-4 shrink-0" />
          <span>
            {sample.key != null
              ? `${sample.key.toUpperCase()}${getChordTypeDisplay(sample.chord_type)}`
              : "—"}
          </span>
        </div>

        <div className="flex items-center gap-1.5 whitespace-nowrap" title="Duration">
          <Clock className="size-4 shrink-0" />
          <span>{`${(sample.duration / 1000).toFixed(2)}s`}</span>
        </div>

        <div className="flex items-center gap-1.5 whitespace-nowrap" title="Tempo">
          <Metronome className="size-4 shrink-0" />
          <span>{sample.bpm != null ? `${sample.bpm} BPM` : "—"}</span>
        </div>
      </div>
    </div>
  );
}
