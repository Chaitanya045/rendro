import { MAX_FILE_BYTES, MAX_HTTP_BODY_BYTES } from "../shared/deployment-limits";

export async function readExactBody(
  body: ReadableStream<Uint8Array> | null,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_FILE_BYTES) return null;
  if (!body) return expectedSize === 0 ? new Uint8Array() : null;

  signal?.throwIfAborted();
  const reader = body.getReader();
  const cancel = (event: Event) => { void reader.cancel((event.target as AbortSignal).reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const bytes = new Uint8Array(expectedSize);
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      signal?.throwIfAborted();
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > expectedSize) {
        void reader.cancel("Request body exceeds manifest size").catch(() => {});
        return null;
      }
      bytes.set(result.value, total - result.value.byteLength);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (total !== expectedSize) return null;
  return bytes;
}

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) { super(`Request body exceeds the ${limit}-byte limit`); }
  response(): Response { return Response.json({ error: this.message }, { status: 413 }); }
}

/** Header admission happens before locking/reading. Actual bytes are always counted. */
export function requireBodyLength(request: Request, limit: number): void {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    void request.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(limit);
  }
}

export async function readBoundedBody(request: Request, limit = MAX_HTTP_BODY_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  requireBodyLength(request, limit);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > limit - total) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLargeError(limit);
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  return bytes.subarray(0, total);
}

export async function boundedRequest(request: Request, limit = MAX_HTTP_BODY_BYTES): Promise<Request> {
  if (request.method === "GET" || request.method === "HEAD") return request;
  const body = await readBoundedBody(request, limit);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { body, headers });
}
