import { IS_MACOS } from "../native";

/** The length of the header of a scrambled sample - it precedes the actual audio data. */
const HEADER_LENGTH = 28;

/**
 * Decodes a "scrambled" Splice MP3 sample, part by part.
 *
 * The header consists of a 2-byte magic, the block size (64-bit little endian), and an 18-byte key.
 * Out of the blocks that come after it, the first and the third are XOR-ed with the key.
 */
export class SpliceAudioDecoder {
  private readonly header = new Uint8Array(HEADER_LENGTH);
  private headerReceived = 0;
  private blockSize = 0;

  /** The amount of audio bytes that have been decoded so far. */
  private position = 0;

  /**
   * Decodes the next part of the sample.
   * @returns The part, unscrambled. All of the parts make up an MP3 file. Might be empty.
   */
  push(data: Uint8Array) {
    const header = data.subarray(0, HEADER_LENGTH - this.headerReceived);
    if (header.length > 0) {
      this.header.set(header, this.headerReceived);
      this.headerReceived += header.length;

      if (this.headerReceived == HEADER_LENGTH) {
        this.blockSize = this.header.subarray(2, 10).reduceRight((size, x) => 256 * size + x, 0);
      }
    }

    const audio = data.slice(header.length);
    const key = this.header.subarray(10);
    const size = this.blockSize;

    for (let i = 0; i < audio.length; i++) {
      const pos = this.position + i;
      if (pos >= 3 * size)
        break;

      if (pos < size || pos >= 2 * size) {
        audio[i] ^= key[(pos % size) % key.length];
      }
    }

    this.position += audio.length;
    return audio;
  }
}

/**
 * The number of samples of silence/pre-ringing at the start of a Splice MP3 preview
 * decoded by the webview, at the MP3's own sample rate. This is LAME's encoder delay
 * (576) plus the standard MP3 decoder delay (529) - except for macOS, where the
 * system's decoder strips the latter on its own. Splice's previews don't carry a
 * LAME/Xing gapless header, so the encoder delay is never stripped.
 */
export const MP3_START_DELAY = IS_MACOS ? 576 : 576 + 529;

/**
 * Finds the sample rate of an MP3 file by reading the header of its first frame.
 * @returns The sample rate in Hz, or `null` if no valid frame header was found.
 */
export function getMp3SampleRate(data: Uint8Array) {
  return findMp3Frame(data)?.sampleRate ?? null;
}

/**
 * Finds the first frame of an MP3 file.
 * @returns Its offset and sample rate, or `null` if no valid frame header was found.
 */
function findMp3Frame(data: Uint8Array) {
  let i = 0;

  // Skip an ID3v2 tag, if present - its size is a 28-bit "syncsafe" integer.
  if (data[0] == 0x49 && data[1] == 0x44 && data[2] == 0x33) {
    i = 10 + (
      ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) |
      ((data[8] & 0x7f) << 7) | (data[9] & 0x7f)
    );
  }

  for (; i < data.length - 3; i++) {
    if (data[i] != 0xff || (data[i + 1] & 0xe0) != 0xe0)
      continue;

    const version = (data[i + 1] >> 3) & 0b11; // 0 = MPEG 2.5, 2 = MPEG 2, 3 = MPEG 1
    const rateIdx = (data[i + 2] >> 2) & 0b11;
    if (version == 1 || rateIdx == 3)
      continue; // reserved values - not a frame header

    const rate = [44100, 48000, 32000][rateIdx];
    return {
      offset: i,
      sampleRate: version == 3 ? rate : version == 2 ? rate / 2 : rate / 4
    };
  }

  return null;
}

/**
 * Describes the parts of an MP3 file that influence the timing of the decoded audio.
 */
export function describeMp3(data: Uint8Array) {
  const frame = findMp3Frame(data);
  if (frame == null)
    return { valid: false, firstBytes: Array.from(data.subarray(0, 16)) };

  // These headers live in the first frame. When one of them is present, decoders
  // may strip the encoder delay by themselves - see `MP3_START_DELAY`.
  const firstFrame = String.fromCharCode(...data.subarray(frame.offset, frame.offset + 256));

  return {
    valid: true,
    ...frame,
    header: Array.from(data.subarray(frame.offset, frame.offset + 4), x => x.toString(16).padStart(2, "0")).join(""),
    gaplessHeaders: ["Xing", "Info", "VBRI", "LAME", "Lavc"].filter(x => firstFrame.includes(x))
  };
}
