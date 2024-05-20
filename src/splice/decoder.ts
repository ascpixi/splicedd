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