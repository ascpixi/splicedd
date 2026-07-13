import { useEffect, useId, useRef, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { IN_TAURI } from "../../native";

// The Tauri HTTP client bypasses CORS, but only exists inside the Tauri shell.
const fetch = IN_TAURI ? tauriFetch : window.fetch.bind(window);

/** The flat line shown in place of a waveform that hasn't loaded yet. */
const EMPTY_WAVEFORM: number[] = new Array(64).fill(0);

function waveformPath(data: number[]) {
  const width = 1000;
  const height = 200;
  const midHeight = height / 2;
  const step = width / data.length;

  const path = [`M 0 ${midHeight}`];

  // Top half of the waveform...
  for (let i = 0; i < data.length; i++) {
    path.push(`L ${(i * step).toFixed(2)} ${(midHeight - (data[i] * midHeight)).toFixed(2)}`);
  }

  // ...and the bottom half, mirrored.
  for (let i = data.length - 1; i >= 0; i--) {
    path.push(`L ${(i * step).toFixed(2)} ${(midHeight + (data[i] * midHeight)).toFixed(2)}`);
  }

  path.push("Z");
  return path.join(" ");
}

/**
 * Displays the amplitude waveform of a sample, given the URL to its Splice
 * "waveform" asset file (a JSON array of normalized amplitudes). The waveform
 * is fetched lazily, when the component first becomes visible.
 */
export default function Waveform(
  { src, progress, onSeek, className }: {
    src: string,

    /** Playback progress, from 0 to 1. Determines how much of the waveform is highlighted. */
    progress: number,

    /** Called when the user clicks the waveform to seek. Receives the target progress, from 0 to 1. */
    onSeek: (progress: number) => void,

    className?: string
  }
) {
  const gradientId = useId().replace(/:/g, "");
  const container = useRef<HTMLDivElement | null>(null);
  const [waveform, setWaveform] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    const observer = new IntersectionObserver(async entries => {
      if (!entries.some(x => x.isIntersecting))
        return;

      observer.disconnect();

      const resp = await fetch(src).catch(err => {
        console.error("failed to fetch waveform:", err);
        return null;
      });

      if (resp == null)
        return;

      // Splice serves these gzipped, but the plugin-http client doesn't always
      // transparently decompress them like a browser fetch would.
      let data: number[];
      if (resp.headers.get("content-encoding") == "gzip") {
        const stream = (await resp.blob()).stream()
          .pipeThrough(new DecompressionStream("gzip"));

        data = await new Response(stream).json();
      } else {
        data = await resp.json();
      }

      if (!cancelled) {
        setWaveform(data);
      }
    });

    observer.observe(container.current!);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [src]);

  function handleClick(ev: React.MouseEvent<HTMLDivElement>) {
    if (waveform == null)
      return;

    const rect = ev.currentTarget.getBoundingClientRect();
    onSeek(Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1));
  }

  function handleKeyDown(ev: React.KeyboardEvent<HTMLDivElement>) {
    if (waveform == null)
      return;

    if (ev.key == "ArrowLeft" || ev.key == "ArrowRight") {
      ev.preventDefault();
      const delta = ev.key == "ArrowLeft" ? -0.05 : 0.05;
      onSeek(Math.min(Math.max(progress + delta, 0), 1));
    }
  }

  return (
    <div ref={container}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`cursor-pointer transition-opacity hover:opacity-80 ${className ?? ""}`}
      data-draggable="false"
      role="slider"
      tabIndex={0}
      aria-label="Seek within sample"
      aria-valuemin={0} aria-valuemax={1} aria-valuenow={progress}
    >
      <svg
        className={`size-full transition-transform duration-500 ${waveform == null ? "scale-y-0" : ""}`}
        viewBox="0 0 1000 200"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset={`${progress * 100}%`} stopColor="var(--accent)" />
            <stop offset={`${progress * 100}%`} stopColor="var(--muted)" />
          </linearGradient>
        </defs>
        <path d={waveformPath(waveform ?? EMPTY_WAVEFORM)} fill={`url(#${gradientId})`} />
      </svg>
    </div>
  );
}
