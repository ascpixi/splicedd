import * as wav from "node-wav";
import { MP3_START_DELAY } from "./decoder.ts";

interface DecodedAudio {
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Encode every channel regardless of duration, retaining views instead of copying PCM. */
export function encodeSampleWav(samples: DecodedAudio, durationMs: number, trimDelay: boolean) {
  const start = trimDelay ? MP3_START_DELAY : 0;
  const end = trimDelay
    ? Math.min(samples.length, Math.round(durationMs / 1000 * samples.sampleRate) + start)
    : samples.length;
  if (samples.numberOfChannels < 1 || end <= start) {
    throw new Error("The decoded sample contains no audio to export.");
  }
  const channels = Array.from({ length: samples.numberOfChannels }, (_, channel) =>
    samples.getChannelData(channel).subarray(start, end));
  // node-wav's typings say ArrayBuffer, but its encoder consumes channel samples.
  return wav.encode(channels as unknown as ArrayBuffer[], {
    bitDepth: 16,
    sampleRate: samples.sampleRate
  });
}

/** HTTP headers need ASCII; JSON Unicode escapes preserve non-ASCII sample paths. */
export function sampleTargetHeader(baseDir: string, relativePath: string) {
  return JSON.stringify({ baseDir, relativePath }).replace(/[\u007f-\uffff]/g,
    char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Preserve optional early placeholder dragging; otherwise publish the WAV first. */
export async function prepareSampleDrag(operations: {
  placeholders?: boolean;
  createPlaceholder?(): Promise<void>;
  isReady(): Promise<boolean>;
  prepare(): Promise<void>;
  startDrag(): Promise<unknown>;
}) {
  if (await operations.isReady()) {
    await operations.startDrag();
  } else if (operations.placeholders) {
    if (!operations.createPlaceholder) throw new Error("Missing placeholder operation.");
    await operations.createPlaceholder();
    // Observe both promises immediately: native dragging may remain pending until
    // drop on some platforms, and neither failure should become unhandled.
    const drag = operations.startDrag();
    await Promise.all([drag, operations.prepare()]);
  } else {
    await operations.prepare();
    await operations.startDrag();
  }
}
