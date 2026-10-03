/**
 * Decodes a "scrambled" Splice MP3 sample.
 * @returns The unscrambled sample, also in the MP3 format.
 */
export function decodeSpliceAudio(data: Uint8Array) {
  let sizeData = Array.from(data.subarray(2, 10));
  let size = 0;

  for (let en = sizeData.length - 1; en >= 0; en--) {
    size = (256 * size) + sizeData[en];
  }

  let encodingData = data.subarray(10, 28);

  const encodeBlkArr = [];
  for (let i = 0; i < encodingData.length; i += 32768) {
    encodeBlkArr.push(String.fromCharCode(...Array.from(encodingData.subarray(i, i + 32768))));
  }

  const encodeBlk = encodeBlkArr.join("");
  const audioData = data.slice(28);

  let passIdx = decodePass(0, audioData, encodeBlk, size) + size;
  decodePass(passIdx, audioData, encodeBlk, passIdx + size);
  return audioData;
}

/**
 * The number of samples of silence/pre-ringing at the start of a decoded Splice
 * MP3 preview, at the MP3's own sample rate. This is LAME's encoder delay (576)
 * plus the standard MP3 decoder delay (529). Splice's previews don't carry a
 * LAME/Xing gapless header, so decoders don't strip this on their own.
 */
export const MP3_START_DELAY = 576 + 529;

/**
 * Finds the sample rate of an MP3 file by reading the header of its first frame.
 * @returns The sample rate in Hz, or `null` if no valid frame header was found.
 */
export function getMp3SampleRate(data: Uint8Array) {
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
    return version == 3 ? rate : version == 2 ? rate / 2 : rate / 4;
  }

  return null;
}

function decodePass(i: number, arr: Uint8Array, encodeBlk: string, size: number) {
  let encblkIdx = 0;

  for (; i < size; i++) {
    if (encblkIdx > encodeBlk.length - 1) {
      encblkIdx = 0; // wraparound
    }

    if (i < size) {
      arr[i] = arr[i] ^ encodeBlk.charCodeAt(encblkIdx);
    }

    encblkIdx++;
  }

  return i;
}