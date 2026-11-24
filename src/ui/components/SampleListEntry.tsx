import { Chip, ProgressCircle, ProgressCircleFillCircle, ProgressCircleTrack, ProgressCircleTrackCircle, Tooltip, TooltipContent, TooltipTrigger, toast } from "@heroui/react";
import { Clock, Metronome, Music2, Play, Square } from "lucide-react";

import { fetch } from "@tauri-apps/plugin-http";
import { useEffect, useRef, useState } from "react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";

import * as wav from "node-wav";
import { checkDirExists, checkFileExists, createPlaceholder, IS_WINDOWS, removePlaceholder, WINDOWS_MAX_PATH, writeSampleFile } from "../../native";
import { join } from "@tauri-apps/api/path";

import { cfg } from "../../config";
import { readBody } from "../../download";
import { DRAG_PREVIEW_ICON } from "../../dragIcon";
import { PlaybackClaim, PlaybackController } from "../playback";
import { SpliceTag } from "../../splice/entities";
import { SpliceSample, SpliceSamplePack } from "../../splice/api";
import { decodeSpliceAudio, describeMp3, getMp3SampleRate, MP3_START_DELAY } from "../../splice/decoder";
import { createLogger, isVerbose, LogSpan, shortUrl } from "../../log";
import Waveform from "./Waveform";

const log = createLogger("sample");

/**
 * Finds the index of the sample at which the first loud-enough sound of a channel begins,
 * relative to the peak of its first second. MP3 pre-ringing is quieter than that.
 */
function findOnset(channel: Float32Array, sampleRate: number) {
  const head = channel.subarray(0, sampleRate);
  const peak = head.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
  return { peak, onset: head.findIndex(x => Math.abs(x) >= peak * 0.1) };
}

/** How far the mouse has to be moved for a click to be considered an attempt to drag, in pixels. */
const DRAG_THRESHOLD = 4;

type MouseTracker = ReturnType<typeof trackMouse>;

/** Tracks what has been done with the mouse since the button was pressed at the given position. */
function trackMouse(startX: number, startY: number) {
  const startedAt = performance.now();
  let releasedAt: number | null = null;
  let moved = false;

  const handleUp = () => {
    releasedAt ??= performance.now();
  };

  const handleMove = (ev: MouseEvent) => {
    if (releasedAt == null && Math.hypot(ev.clientX - startX, ev.clientY - startY) >= DRAG_THRESHOLD) {
      moved = true;
    }
  };

  window.addEventListener("mouseup", handleUp, { capture: true });
  window.addEventListener("mousemove", handleMove, { capture: true });

  return {
    stop: () => {
      window.removeEventListener("mouseup", handleUp, { capture: true });
      window.removeEventListener("mousemove", handleMove, { capture: true });
    },

    /** How long the button was held for, in milliseconds, or `null` if it's still held down. */
    heldFor: () => releasedAt == null ? null : Math.round(releasedAt - startedAt),

    /** Whether the mouse was moved while the button was held down. */
    moved: () => moved
  };
}

const getChordTypeDisplay = (type: string | null) =>
  type == null ? "" : type == "major" ? " Major" : " Minor";

export type TagClickHandler = (tag: SpliceTag) => void;
export type PackClickHandler = (pack: SpliceSamplePack) => void;

/**
 * Provides a view describing a Splice sample.
 */
export default function SampleListEntry(
  { sample, playback, onTagClick, onPackClick }: {
    sample: SpliceSample,
    playback: PlaybackController,
    onTagClick: TagClickHandler,
    onPackClick: PackClickHandler
  }
) {
  // Whether we're preparing the sample to be played or dragged, respectively.
  const [playPending, setPlayPending] = useState(false);
  const [dragPending, setDragPending] = useState(false);
  const fgLoading = playPending || dragPending;

  // How much of the sample has been downloaded (0 to 100), or `null` if that's unknown.
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current == null) {
    const element = audioRef.current = document.createElement("audio");

    for (const name of ["loadstart", "loadedmetadata", "canplay", "playing", "waiting", "stalled", "seeking", "seeked", "pause", "ended"]) {
      element.addEventListener(name, () => log.trace(`audio event: ${name}`, {
        sample: sample.name,
        currentTime: element.currentTime,
        duration: element.duration,
        readyState: element.readyState
      }));
    }

    element.addEventListener("loadedmetadata", () => log.debug("preview metadata loaded", {
      sample: sample.name,
      actualMs: element.duration * 1000,
      expectedMs: sample.duration
    }));

    element.addEventListener("error", () => log.error("audio element failed", {
      sample: sample.name,
      code: element.error?.code,
      message: element.error?.message
    }));
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

    const span = log.span("fetch", { sample: sample.name, url: shortUrl(file.url) });

    fetchAhead.current = fetch(file.url);

    // This only observes the request - errors still reach whoever awaits `fetchAhead`.
    fetchAhead.current.then(
      resp => span.end("got headers", {
        status: resp.status,
        contentLength: resp.headers.get("content-length"),
        contentType: resp.headers.get("content-type"),
        contentEncoding: resp.headers.get("content-encoding")
      }, resp.ok ? "debug" : "error"),
      err => {
        span.fail(err);
        fetchAhead.current = null; // try again the next time
      }
    );
  }

  const playbackClaim = useRef<PlaybackClaim | null>(null);

  audio.onended = () => {
    playbackClaim.current?.release();
    setPlaying(false);
    setProgress(0);
  };

  // The audio element isn't a part of the DOM, so it would outlive us otherwise.
  useEffect(() => () => playbackClaim.current?.stop(), []);

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
    setPlayPending(false);
    setProgress(0);
  }

  async function handlePlayClick() {
    if (playbackClaim.current?.active) {
      playbackClaim.current.stop();
      return;
    }

    await play();
  }

  /** Plays the sample, after downloading it if needed. Stops any other sample. */
  async function play(seekTo?: number) {
    const span = log.span("play", { sample: sample.name, durationMs: sample.duration, seekTo });

    // Downloading can take a while. The user might stop us or play some other sample by
    // the time it's done, in which case our claim isn't going to be active anymore.
    const claim = playbackClaim.current = playback.claim(stop);

    try {
      if (audio.src == "") {
        setPlayPending(true);
        await ensureAudioDecoded(span);

        if (!claim.active) {
          span.end("stopped before it could start");
          return;
        }

        audio.src = URL.createObjectURL(
          new Blob([decodedSample.current!], { "type": "audio/mpeg" })
        );
      }

      setPlayPending(false);
      setPlaying(true);

      const started = audio.play();
      if (seekTo != null) {
        seek(seekTo);
      }

      await started;
      span.step("started playing");
      span.end();
    }
    catch (err) {
      if (!claim.active) {
        span.end("stopped before it could start", { err });
        return;
      }

      span.fail(err);
      claim.stop();
      toast.danger("Couldn't play this sample", { description: "Please try again." });
    }
  }

  function seek(target: number) {
    // The audio metadata might not be loaded yet right after setting the
    // source, so we compute the seek time from the sample's known duration.
    audio.currentTime = target * (sample.duration / 1000);
    setProgress(target);
  }

  async function handleSeek(target: number) {
    if (playing) {
      seek(target);
    }
    else {
      await play(target);
    }
  }

  const download = useRef<Promise<void> | null>(null);

  async function ensureAudioDecoded(span: LogSpan) {
    if (decodedSample.current != null) {
      span.log("debug", "already downloaded");
      return;
    }

    // The body of a response can be read only once, so if we're already being downloaded
    // (e.g. because of the user both playing and dragging us), wait for that to finish.
    if (download.current != null) {
      span.log("debug", "already downloading");
      await download.current;
      span.step("waited for an ongoing download");
      return;
    }

    download.current = downloadAudio(span);
    try {
      await download.current;
    }
    finally {
      download.current = null;
    }
  }

  async function downloadAudio(span: LogSpan) {
    startFetching();

    try {
      const resp = await fetchAhead.current!;
      span.step("waited for headers", { status: resp.status });

      if (!resp.ok)
        throw new Error(`Splice returned HTTP ${resp.status}`);

      // Rounding the progress makes most of the updates not cause a re-render.
      const data = await readBody(resp, x => setDownloadProgress(Math.round(x * 100)));
      span.step("read body", { bytes: data.byteLength, contentLength: resp.headers.get("content-length") });

      decodedSample.current = decodeSpliceAudio(data);
      span.step("unscrambled", { mp3: describeMp3(decodedSample.current) });
    }
    catch (err) {
      fetchAhead.current = null; // the response can't be reused
      throw err;
    }
    finally {
      setDownloadProgress(null);
    }
  }

  const sanitizePath = (x: string) => x.replace(/[<>:"|?* ]/g, "_");

  /** Incremented each time the user attempts to drag the sample. */
  const dragAttempt = useRef(0);

  /** The ongoing export of the sample, if any. */
  const pendingExport = useRef<Promise<void> | null>(null);

  async function handleDrag(ev: React.MouseEvent<HTMLDivElement, MouseEvent>) {
    // Verify that the parent of the element that we began the dragging from
    // is not explicitly marked as non-draggable (as it may be clicked etc.)
    const dragOrigin = document.elementFromPoint(ev.clientX, ev.clientY)?.parentElement;
    if (dragOrigin != null && dragOrigin.dataset.draggable === "false") {
      log.trace("ignoring drag from a non-draggable element", { sample: sample.name });
      return;
    }

    const span = log.span("drag", {
      sample: sample.name,
      uuid: sample.uuid,
      durationMs: sample.duration,
      button: ev.button,
      alreadyBusy: fgLoading,
      placeholders: cfg().placeholders,
      trimDelay: cfg().trimDelay
    });

    // Preparing a sample takes a while, and the OS only lets us start a drag if
    // the mouse button is still held down by the time we're done.
    const mouse = trackMouse(ev.clientX, ev.clientY);
    const attempt = ++dragAttempt.current;

    try {
      const started = await prepareAndDrag(span, mouse);

      // Don't bother the user if they've merely clicked, or if they're already trying again.
      if (started === false && mouse.moved() && attempt == dragAttempt.current) {
        toast.success("Sample ready", { description: "It has finished downloading. Drag it again to use it." });
      }
    }
    catch (err) {
      span.fail(err, { mouseHeldForMs: mouse.heldFor() });

      if (attempt == dragAttempt.current) {
        toast.danger("Couldn't prepare this sample", { description: "Please try dragging it again." });
      }
    }
    finally {
      if (attempt == dragAttempt.current) {
        setDragPending(false);
      }

      span.end("done", { mouseHeldForMs: mouse.heldFor() });
      mouse.stop();
    }
  }

  /**
   * Hands the drag of the given file over to the OS, unless the mouse has already been released -
   * the file would be immediately dropped onto whatever happens to be under the cursor.
   * @returns Whether the drag was started.
   */
  function beginDrag(path: string, span: LogSpan, mouse: MouseTracker) {
    const startedAt = performance.now();
    const elapsedMs = () => performance.now() - startedAt;

    const heldFor = mouse.heldFor();
    if (heldFor != null) {
      span.log("warn", "the mouse was released before the drag could start", { mouseHeldForMs: heldFor });
      return false;
    }

    span.step("requested OS drag", { path });

    startDrag({ item: [path], icon: DRAG_PREVIEW_ICON }, ev => span.log("info", "OS drag finished", {
      result: ev.result, cursorPos: ev.cursorPos, elapsedMs: elapsedMs()
    })).then(
      () => span.log("debug", "startDrag returned", { elapsedMs: elapsedMs() }),
      err => span.log("error", "OS drag failed", { err, elapsedMs: elapsedMs() })
    );

    return true;
  }

  /**
   * Makes sure that the sample is present in the sample folder, and drags it.
   * @returns Whether the drag was started, or `null` if the sample can't be dragged at all.
   */
  async function prepareAndDrag(span: LogSpan, mouse: MouseTracker) {
    if (!await checkDirExists(cfg().sampleDir)) {
      span.end("sample folder not found", { sampleDir: cfg().sampleDir }, "warn");
      toast.danger("Sample folder not found", {
        description: "Choose an existing sample folder in the settings to drag samples into your DAW."
      });
      return null;
    }

    // Windows' shell can't drag files whose path is longer than MAX_PATH - the
    // drag plugin crashes the whole app if we try. Fall back to shorter layouts
    // (dropping the sample's own subfolders, then the pack folder) when needed.
    const fileName = sample.name.split("/").pop()!;
    const candidates = [
      sanitizePath(pack.name) + "/" + sanitizePath(sample.name),
      sanitizePath(pack.name) + "/" + sanitizePath(fileName),
      sanitizePath(fileName)
    ];

    let samplePath: string | null = null;
    let fullPath = "";
    for (const candidate of candidates) {
      fullPath = await join(cfg().sampleDir, candidate);
      if (!IS_WINDOWS || fullPath.length <= WINDOWS_MAX_PATH) {
        samplePath = candidate;
        break;
      }
    }

    if (samplePath == null) {
      span.end("path too long", { fullPath, length: fullPath.length }, "warn");
      toast.danger("Can't drag this sample", {
        description: "The path to your sample folder is too long for Windows. Choose a shorter one in the settings."
      });
      return null;
    }

    span.step("resolved path", { fullPath });

    // A file that's still being written to exists, but isn't complete.
    if (pendingExport.current == null && await checkFileExists(cfg().sampleDir, samplePath)) {
      span.step("found existing file");
      return beginDrag(fullPath, span, mouse);
    }

    setDragPending(true);
    await ensureAudioDecoded(span);

    let started = false;
    if (cfg().placeholders && mouse.heldFor() == null) {
      await createPlaceholder(cfg().sampleDir, samplePath);
      span.step("created placeholder");
      started = beginDrag(fullPath, span, mouse);
    }

    pendingExport.current ??= exportSample(cfg().sampleDir, samplePath, span)
      .finally(() => pendingExport.current = null);

    await pendingExport.current;

    return started || beginDrag(fullPath, span, mouse);
  }

  /** Converts the (already downloaded) sample to a WAV file. */
  async function exportSample(baseDir: string, samplePath: string, span: LogSpan) {
    try {
      // decodeAudioData resamples to the context's rate, so decode at the MP3's
      // own rate - this keeps the output unaltered and MP3_START_DELAY exact.
      const sampleRate = getMp3SampleRate(decodedSample.current!) ?? 44100;
      const actx = new OfflineAudioContext(1, 1, sampleRate);

      // decodeAudioData detaches the buffer we give it, so pass a copy to
      // keep the decoded sample usable for playback afterwards.
      span.log("debug", "decoding", { sampleRate, mp3Bytes: decodedSample.current!.byteLength });
      const samples = await actx.decodeAudioData(decodedSample.current!.buffer.slice(0));

      const expectedLength = Math.round((sample.duration / 1000) * samples.sampleRate);
      span.step("decoded MP3", {
        length: samples.length,
        expectedLength,
        excess: samples.length - expectedLength,
        channels: samples.numberOfChannels,
        sampleRate: samples.sampleRate,
        pcmBytes: samples.length * samples.numberOfChannels * 4
      });

      if (isVerbose()) {
        span.log("debug", "onset before trimming", {
          channels: Array.from(
            { length: samples.numberOfChannels },
            (_, i) => findOnset(samples.getChannelData(i), samples.sampleRate)
          ),
          mp3StartDelay: MP3_START_DELAY
        });
      }

      const channels: Float32Array[] = [];

      for (let i = 0; i < samples.numberOfChannels; i++) {
        const chan = samples.getChannelData(i);

        const start = cfg().trimDelay ? MP3_START_DELAY : 0;
        const end = cfg().trimDelay
          ? Math.round((sample.duration / 1000) * samples.sampleRate) + start
          : chan.length;

        // This is merely a view, so it's cheap even for really long samples.
        channels.push(chan.subarray(start, end));

        span.log("debug", "trimmed channel", {
          channel: i, start, end, available: chan.length, resultLength: channels[i].length
        });

        if (end > chan.length) {
          span.log("warn", "the decoded audio is shorter than expected", {
            channel: i, missingSamples: end - chan.length
          });
        }
      }

      const encoded = wav.encode(channels as unknown as ArrayBuffer[], {
        bitDepth: 16,
        sampleRate: samples.sampleRate
      });
      span.step("encoded WAV", { bytes: encoded.byteLength, channels: channels.length });

      await writeSampleFile(baseDir, samplePath, encoded);
      span.step("wrote file");
    }
    catch (err) {
      // Don't leave an empty file behind. If this fails, the error has already been logged.
      await removePlaceholder(baseDir, samplePath).catch(() => {});
      throw err;
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
          aria-label={playing ? "Stop playback" : playPending ? "Cancel playback" : "Play sample"}
          data-draggable="false"
          className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0
                      cursor-pointer transition-colors hover:bg-surface-tertiary
                      ${playing ? "text-accent" : "text-current"}`}
        >
          {fgLoading
            ? <ProgressCircle
                aria-label="Loading sample..."
                className="h-6"
                isIndeterminate={downloadProgress == null}
                value={downloadProgress ?? 0}
              >
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
