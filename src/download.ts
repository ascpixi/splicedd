/** Joins multiple byte arrays into a single one. */
export function concatBytes(parts: Uint8Array[]) {
  const data = new Uint8Array(parts.reduce((total, x) => total + x.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }

  return data;
}

/**
 * Reads the entire body of a response.
 * @param onChunk Called each time a part of the body arrives.
 * @param onProgress Called with the completed fraction (0 to 1) each time a part of the body
 * arrives. Not called at all if the size of the body isn't known upfront.
 * @returns The size of the body, in bytes.
 */
export async function readBody(
  resp: Response,
  onChunk: (chunk: Uint8Array) => void,
  onProgress: (progress: number) => void
) {
  // The content length is that of the compressed data, which isn't what we might be reading.
  const total = resp.headers.get("content-encoding") == null
    ? Number(resp.headers.get("content-length") ?? 0)
    : 0;

  let received = 0;

  const reader = resp.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;

    onChunk(value);
    received += value.byteLength;

    if (total > 0) {
      onProgress(Math.min(received / total, 1));
    }
  }

  if (total > 0 && received != total)
    throw new Error(`The download is incomplete (got ${received} out of ${total} bytes)`);

  return received;
}
