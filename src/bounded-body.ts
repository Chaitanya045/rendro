/** Every JSON or form body the Worker and Convex accept is at most 64 KiB. */
export const MAX_HTTP_BODY_BYTES = 64 * 1024;

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
