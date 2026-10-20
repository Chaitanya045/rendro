import { Hono, type Context } from "hono";
import { IMAGE_PROXY_SECRET } from "@/config";
import { verifyImageProxyPath } from "@/image-proxy";
import { isProxyableImageUrl } from "@/image-proxy-target";

/*
 * GET /img/<sig>/<encoded-url>: the same-origin image proxy for repository
 * content (see src/image-proxy.ts). Readers' browsers only ever talk to us;
 * the upstream sees a fixed user agent from Cloudflare's egress, never the
 * reader's IP, user agent, cookies or referrer.
 */

export const MAX_REDIRECTS = 3;
export const UPSTREAM_TIMEOUT_MS = 10_000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const FAILURE_TTL_SECONDS = 60;
export const DEFAULT_SUCCESS_TTL_SECONDS = 86_400;
export const MIN_SUCCESS_TTL_SECONDS = 300;
export const MAX_SUCCESS_TTL_SECONDS = 604_800;
export const PROXY_USER_AGENT = "Rendro-Image-Proxy/1.0 (+https://rendro.app)";

const IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon",
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Every proxied response, success or failure. The CSP neutralizes an SVG opened as a document. */
const FIXED_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "Content-Disposition": "inline",
  "X-Content-Type-Options": "nosniff",
  // The viewer frames are sandboxed, so their requests carry an opaque origin. `same-origin` and
  // `same-site` would block every proxied image there; the content is public third-party bytes.
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Referrer-Policy": "no-referrer",
};

/** Upstream freshness, clamped: badges that say no-cache refresh every few minutes, everything else within a week. */
export function successTtl(cacheControl: string | null): number {
  const directives = (cacheControl ?? "").toLowerCase();
  if (/(?:^|[,\s])(?:no-store|no-cache|private)(?:[,\s=]|$)/.test(directives)) return MIN_SUCCESS_TTL_SECONDS;
  const age = /(?:^|[,\s])s-maxage\s*=\s*"?(\d+)/.exec(directives)?.[1] ?? /(?:^|[,\s])max-age\s*=\s*"?(\d+)/.exec(directives)?.[1];
  if (age === undefined) return DEFAULT_SUCCESS_TTL_SECONDS;
  return Math.min(MAX_SUCCESS_TTL_SECONDS, Math.max(MIN_SUCCESS_TTL_SECONDS, Number(age)));
}

function failure(): Response {
  return new Response(null, { status: 502, headers: { ...FIXED_HEADERS, "Cache-Control": `public, max-age=${FAILURE_TTL_SECONDS}` } });
}

/** Release an unread body; one that already failed has nothing to release. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Follow at most MAX_REDIRECTS redirects by hand, re-checking every target,
 * and never one on the host this request arrived on (`ownHost`).
 * No cookies, credentials or reader headers are sent; only a fixed user agent.
 */
async function fetchUpstream(target: string, ownHost: string, signal: AbortSignal): Promise<Response | null> {
  let url = target;
  for (let hop = 0; ; hop++) {
    if (!isProxyableImageUrl(url, [ownHost])) return null;
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { "User-Agent": PROXY_USER_AGENT, Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8" },
    });
    if (!REDIRECTS.has(response.status)) return response;
    await discard(response);
    const location = response.headers.get("Location");
    if (hop >= MAX_REDIRECTS || !location || !URL.canParse(location, url)) return null;
    url = new URL(location, url).href;
  }
}

/**
 * The upstream body, failing once it passes MAX_IMAGE_BYTES or the deadline.
 * A failed stream is never complete in the cache or the browser.
 */
function cappedBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  let settled = false;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fail = (reason: string) => {
    if (settled) return;
    settled = true;
    stream.error(new Error(reason));
    reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
      // The runtime also aborts a real fetch body on this signal; failing here does not depend on it.
      signal.addEventListener("abort", () => fail("Image upstream timed out"), { once: true });
    },
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return fail("Image upstream failed");
      }
      if (settled) return;
      if (chunk.done) {
        settled = true;
        return controller.close();
      }
      received += chunk.value.byteLength;
      if (received > MAX_IMAGE_BYTES) return fail("Image exceeds the size limit");
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      settled = true;
      return reader.cancel(reason);
    },
  });
}

async function proxiedImage(target: string, ownHost: string): Promise<Response> {
  const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let upstream: Response | null;
  try {
    upstream = await fetchUpstream(target, ownHost, signal);
  } catch {
    return failure();
  }
  const type = upstream?.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() ?? "";
  const length = Number(upstream?.headers.get("Content-Length") ?? 0);
  if (!upstream?.body || upstream.status !== 200 || !IMAGE_TYPES.has(type) || !(length <= MAX_IMAGE_BYTES)) {
    if (upstream) await discard(upstream);
    return failure();
  }
  // Only these headers leave: no upstream cookies, validators, CORS or anything else.
  return new Response(cappedBody(upstream.body, signal), {
    status: 200,
    headers: { ...FIXED_HEADERS, "Content-Type": type, "Cache-Control": `public, max-age=${successTtl(upstream.headers.get("Cache-Control"))}` },
  });
}

async function cacheKey(c: Context, url: string): Promise<Request> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(new URL(`/img/cache/${hash}`, c.req.url));
}

/** The Workers default cache, absent on the Node server. */
function edgeCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/** Store without delaying the reader. An image whose stream fails is stored as a short-lived failure instead. */
function store(c: Context, cache: Cache, key: Request, response: Response): void {
  const work = cache.put(key, response).catch(() => cache.put(key, failure())).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context outside Workers; the promise settles on its own.
  }
}

/** Fresh headers: cached responses are immutable, and later middleware adds headers. */
function reply(response: Response): Response {
  return new Response(response.body, response);
}

const imageProxy = new Hono();

imageProxy.get("/img/*", async (c) => {
  const target = await verifyImageProxyPath(IMAGE_PROXY_SECRET, c.req.path);
  if (target === null) return c.body(null, 404);
  const cache = edgeCache();
  const key = await cacheKey(c, target);
  const cached = await cache?.match(key);
  if (cached) return reply(cached);
  const response = await proxiedImage(target, new URL(c.req.url).hostname);
  if (!cache) return response;
  if (response.body === null) {
    store(c, cache, key, response.clone());
    return response;
  }
  const [forReader, forCache] = response.body.tee();
  store(c, cache, key, new Response(forCache, response));
  return new Response(forReader, response);
});

export default imageProxy;
