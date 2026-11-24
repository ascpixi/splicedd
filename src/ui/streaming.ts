import { concatBytes } from "../download";

const MIME_TYPE = "audio/mpeg";

/** Samples shorter than this (in milliseconds) download so quickly that there's no point in streaming them. */
const MIN_DURATION = 5000;

/** Determines whether a sample of the given duration (in milliseconds) should be streamed. */
export function shouldStream(duration: number) {
  return duration >= MIN_DURATION
    && typeof MediaSource != "undefined"
    && MediaSource.isTypeSupported(MIME_TYPE);
}

/**
 * Lets an MP3 file be played while it's still being downloaded.
 */
export class Mp3Stream {
  /** What to use as the source of an audio element. Can be used only once. */
  readonly url: string;

  private readonly source = new MediaSource();
  private buffer: SourceBuffer | null = null;

  /** The parts that are yet to be given to the browser. */
  private pending: Uint8Array[] = [];

  private started = false;
  private ended = false;
  private closed = false;

  /**
   * @param duration The (approximate) duration of the audio, in milliseconds.
   * @param onError Called at most once, if the browser can't handle the stream. It can't be played any further.
   */
  constructor(duration: number, private readonly onError: (err: unknown) => void) {
    this.url = URL.createObjectURL(this.source);

    this.source.addEventListener("sourceopen", () => {
      URL.revokeObjectURL(this.url);

      this.guard(() => {
        this.buffer = this.source.addSourceBuffer(MIME_TYPE);
        this.buffer.addEventListener("updateend", () => this.pump());
        this.buffer.addEventListener("error", () => this.fail(new Error("The browser couldn't process the stream")));
        this.source.duration = duration / 1000;
      });

      this.pump();
    }, { once: true });
  }

  /** Receives the next part of the file. */
  push(data: Uint8Array) {
    if (this.closed || data.length == 0)
      return;

    this.pending.push(data);
    this.pump();
  }

  /** Marks the file as complete. */
  end() {
    this.ended = true;
    this.pump();
  }

  /** Stops processing the stream. */
  close() {
    this.closed = true;
    this.pending = [];
  }

  private pump() {
    if (this.closed || this.buffer == null || this.buffer.updating || this.source.readyState != "open")
      return;

    const buffer = this.buffer;
    this.guard(() => {
      if (this.pending.length > 0) {
        buffer.appendBuffer(concatBytes(this.pending));
        this.pending = [];
        this.started = true;
      }
      else if (this.ended) {
        if (!this.started)
          throw new Error("The stream is empty");

        this.source.endOfStream();
      }
    });
  }

  private guard(action: () => void) {
    try {
      action();
    }
    catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown) {
    if (!this.closed) {
      this.close();
      this.onError(err);
    }
  }
}
