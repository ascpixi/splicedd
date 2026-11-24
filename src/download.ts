/**
 * Reads the entire body of a response.
 * @param onProgress Called with the completed fraction (0 to 1) each time a part of the body
 * arrives. Not called at all if the size of the body isn't known upfront.
 */
export async function readBody(resp: Response, onProgress: (progress: number) => void) {
  // The content length is that of the compressed data, which isn't what we might be reading.
  const total = resp.headers.get("content-encoding") == null
    ? Number(resp.headers.get("content-length") ?? 0)
    : 0;

  const chunks: Uint8Array[] = [];
  let received = 0;

  const reader = resp.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;

    chunks.push(value);
    received += value.byteLength;

    if (total > 0) {
      onProgress(Math.min(received / total, 1));
    }
  }

  if (total > 0 && received != total)
    throw new Error(`The download is incomplete (got ${received} out of ${total} bytes)`);

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return data;
}
