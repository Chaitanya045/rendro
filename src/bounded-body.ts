export async function readExactBody(
  body: ReadableStream<Uint8Array> | null,
  expectedSize: number,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) return null;
  if (!body) return expectedSize === 0 ? new Uint8Array() : null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > expectedSize) {
        await reader.cancel("Request body exceeds manifest size");
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedSize) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
