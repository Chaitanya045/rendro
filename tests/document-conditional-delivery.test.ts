import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import * as blobs from "@/storage";
import { deploymentMetadataCache } from "@/immutable-cache";
import { createLegacyViewerTicket, createViewerTicket } from "@/viewer-ticket";
import { cookie, manifestKey } from "./fixtures/publisher-isolation";
import { docsBase, mockSecurityBackend } from "./fixtures/security-headers";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const image = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const imageEtag = `"sha256-${sha(image)}"`;
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><p>Publisher document</p></body></html>';
const htmlEtag = `"sha256-${sha(html)}"`;
const encoder = new TextEncoder();

type Route = {
  name: string;
  /** Strong validator of the image on this route class. */
  etag: string;
  cache: string;
  cors: string | null;
  signedIn: boolean;
  csp: string;
  url: (path: string) => string;
};

async function fixture() {
  mockSecurityBackend();
  deploymentMetadataCache.clear();
  const manifest = [
    { path: "image.png", sha256: sha(image), size: image.length, contentType: "image/png" },
    { path: "index.html", sha256: sha(html), size: html.length, contentType: "text/html; charset=utf-8" },
    { path: "assets/site.css", sha256: sha("b"), size: 1, contentType: "text/css" },
  ];
  vi.mocked(blobs.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: manifest }));
  const bytes = (key: string) => key.endsWith("image.png") ? image : key.endsWith("index.html") ? encoder.encode(html) : encoder.encode("b");
  const stored = (key: string) => /\/(?:image\.png|index\.html|assets\/site\.css)$/.test(key);
  vi.mocked(blobs.headObject).mockImplementation(key => Promise.resolve(stored(key) ? {
    contentType: key.endsWith("image.png") ? "image/png" : "text/html", etag: "abc123", size: bytes(key).length,
  } : null));
  const reads: Array<{ key: string; range?: blobs.ObjectRange }> = [];
  vi.mocked(blobs.getObjectStream).mockImplementation((key, range) => {
    reads.push({ key, range });
    const all = bytes(key);
    return Promise.resolve(new Response(range ? all.slice(range.start, range.end + 1) : all).body);
  });
  const state = { memberDenied: false, publicationGone: false, shareGone: false };
  const backend = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/deployments/active") && state.memberDenied) return Promise.resolve(Response.json({ error: "Forbidden" }, { status: 403 }));
    if (url.pathname.endsWith("/publications/public")) {
      return Promise.resolve(state.publicationGone ? new Response(null, { status: 404 }) : Response.json({
        publication: { slug: "product", pathPrefix: "", entryFile: "index.html" }, project: { name: "Product" }, deployment: { manifestKey },
      }));
    }
    if (url.pathname.endsWith("/shares/public")) {
      return Promise.resolve(state.shareGone ? new Response(null, { status: 404 }) : Response.json({
        grant: { documentPath: "index.html", assetPaths: ["image.png"], expiresAt: Date.now() + 60_000 },
        deployment: { manifestKey }, project: { name: "Fixture" },
      }));
    }
    return backend(input, init);
  });
  const ticket = await createViewerTicket({ organizationId: "org-a", projectId: "project-a", manifestKey, cookie });
  const legacyTicket = await createLegacyViewerTicket("example", cookie);
  const htmlPolicy = "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'";
  const routes: Route[] = [
    { name: "public", etag: imageEtag, cache: "public, max-age=0, must-revalidate", cors: "null", signedIn: false, csp: "sandbox; frame-ancestors 'self'", url: p => `/p/product/files/${p}` },
    { name: "share", etag: imageEtag, cache: "private, no-store", cors: "null", signedIn: false, csp: "default-src 'none'; sandbox; frame-ancestors 'self'", url: p => `/s/token/files/${p}` },
    { name: "private", etag: imageEtag, cache: "private, no-store", cors: null, signedIn: true, csp: "default-src 'none'; sandbox; frame-ancestors 'self'", url: p => `${docsBase}/files/${p}` },
    { name: "private ticket", etag: imageEtag, cache: "private, no-store", cors: "null", signedIn: false, csp: "default-src 'none'; sandbox; frame-ancestors 'self'", url: p => `${docsBase}/view/${ticket}/files/${p}` },
    { name: "legacy private", etag: '"s3-abc123"', cache: "private, no-store", cors: null, signedIn: true, csp: "sandbox; frame-ancestors 'self'", url: p => `/legacy-view/example/files/${p}` },
    { name: "legacy ticket", etag: '"s3-abc123"', cache: "private, no-store", cors: "null", signedIn: false, csp: "sandbox; frame-ancestors 'self'", url: p => `/legacy-view/example/view/${legacyTicket}/files/${p}` },
  ];
  const get = (route: Route, headers: Record<string, string> = {}, path = "image.png", method = "GET") =>
    worker.request(`https://rendro.test${route.url(path)}`, { method, headers: { Origin: "null", ...(route.signedIn ? { Cookie: cookie } : {}), ...headers } });
  return { routes, reads, state, get, htmlPolicy };
}

const names = ["public", "share", "private", "private ticket", "legacy private", "legacy ticket"];

describe.each(names)("conditional and ranged delivery: %s", name => {
  const setup = async () => { const f = await fixture(); return { ...f, route: f.routes.find(route => route.name === name)! }; };

  it("sends the same validator, caching, isolation and MIME headers on 200, 206, 304, 416 and HEAD", async () => {
    const { route, get, reads } = await setup();
    const expected = {
      "cache-control": route.cache, etag: route.etag, "accept-ranges": "bytes", "content-type": "image/png",
      "x-content-type-options": "nosniff", "content-security-policy": route.csp, "access-control-allow-origin": route.cors,
    };
    const pick = (response: Response) => Object.fromEntries(Object.keys(expected).map(header => [header, response.headers.get(header)]));
    const full = await get(route);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("1000");
    expect(pick(full)).toEqual(expected);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(image);

    const partial = await get(route, { Range: "bytes=10-19" });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(partial.headers.get("content-length")).toBe("10");
    expect(pick(partial)).toEqual(expected);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(image.slice(10, 20));

    reads.length = 0;
    const notModified = await get(route, { "If-None-Match": route.etag });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("content-length")).toBeNull();
    expect(pick(notModified)).toEqual(expected);
    expect(await notModified.text()).toBe("");

    const unsatisfiable = await get(route, { Range: "bytes=1000-" });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */1000");
    // Client errors are never cacheable: the viewer error policy applies to the 416 too.
    expect(pick(unsatisfiable)).toEqual({ ...expected, "cache-control": "private, no-store" });

    const head = await get(route, {}, "image.png", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect(pick(head)).toEqual(expected);
    expect(await head.text()).toBe("");
    // Neither revalidation, an unsatisfiable range nor HEAD touch storage bytes.
    expect(reads.filter(read => read.key.endsWith("image.png"))).toEqual([]);
  });

  it("reads exactly the requested bytes from storage and ignores unusable Range headers", async () => {
    const { route, get, reads } = await setup();
    const key = (read: { key: string }) => read.key.endsWith("image.png");
    const cases: Array<[string, number, string | null, [number, number] | null]> = [
      ["bytes=0-99", 206, "bytes 0-99/1000", [0, 99]],
      ["bytes=990-", 206, "bytes 990-999/1000", [990, 999]],
      ["bytes=-10", 206, "bytes 990-999/1000", [990, 999]],
      ["bytes=900-5000", 206, "bytes 900-999/1000", [900, 999]],
      ["bytes=-5000", 206, "bytes 0-999/1000", [0, 999]],
      ["BYTES = 5 - 6", 206, "bytes 5-6/1000", [5, 6]],
      ["bytes=0-99999999999999999999999999", 206, "bytes 0-999/1000", [0, 999]],
      ["bytes=-99999999999999999999999999", 206, "bytes 0-999/1000", [0, 999]],
      ["bytes=1000-1001", 416, "bytes */1000", null],
      ["bytes=5000-", 416, "bytes */1000", null],
      ["bytes=-0", 416, "bytes */1000", null],
      ["bytes=99999999999999999999999999-", 416, "bytes */1000", null],
      // Ignored: invalid syntax, other units, several ranges (200 with everything).
      ["bytes=5-2", 200, null, null], ["bytes=-", 200, null, null], ["bytes=abc", 200, null, null],
      ["bytes=0-1x", 200, null, null], ["items=0-1", 200, null, null], ["", 200, null, null],
      ["bytes=0-1,5-6", 200, null, null], ["bytes=0-1, 5-6, 9-", 200, null, null],
      [`bytes=${Array.from({ length: 2000 }, (_, i) => `${i * 2}-${i * 2}`).join(",")}`, 200, null, null],
      [`bytes=0-${"9".repeat(500)}`, 200, null, null],
    ];
    for (const [header, status, contentRange, slice] of cases) {
      reads.length = 0;
      const response = await get(route, { Range: header });
      expect(response.status, header).toBe(status);
      expect(response.headers.get("content-range"), header).toBe(contentRange);
      const body = new Uint8Array(await response.arrayBuffer());
      if (status === 206) {
        expect(body, header).toEqual(image.slice(slice![0], slice![1] + 1));
        expect(reads.filter(key).map(read => read.range), header).toEqual([{ start: slice![0], end: slice![1], size: 1000 }]);
      } else if (status === 200) {
        expect(body, header).toEqual(image);
        expect(reads.filter(key).map(read => read.range), header).toEqual([undefined]);
      } else expect(reads.filter(key), header).toEqual([]);
    }
  });

  it("evaluates If-None-Match lists, wildcards and weak validators without trusting malformed input", async () => {
    const { route, get } = await setup();
    const other = '"sha256-0000"';
    const matches = [
      route.etag, `W/${route.etag}`, `${other}, ${route.etag}`, `${other},${route.etag}`, ` ${route.etag} `, "*",
      `${other}, malformed, ${route.etag}`, `"unterminated, ${route.etag}`,
    ];
    for (const header of matches) expect((await get(route, { "If-None-Match": header })).status, header).toBe(304);
    const misses = [
      other, "", route.etag.slice(1, -1), `${route.etag}x`, `${route.etag.slice(0, -1)}`, `${other} ${route.etag}`,
      `W/ ${route.etag}`, `${"a".repeat(5000)}, ${route.etag}`, `"${"a".repeat(5000)}"`,
    ];
    for (const header of misses) expect((await get(route, { "If-None-Match": header })).status, header).toBe(200);
    // A satisfied validator wins over Range (RFC 9110 §13.2.2); a failed one does not.
    expect((await get(route, { "If-None-Match": route.etag, Range: "bytes=0-9" })).status).toBe(304);
    expect((await get(route, { "If-None-Match": other, Range: "bytes=0-9" })).status).toBe(206);
    expect((await get(route, { "If-None-Match": route.etag, Range: "bytes=5000-" })).status).toBe(304);
  });

  it("honours If-Range only for the current strong validator", async () => {
    const { route, get } = await setup();
    const range = { Range: "bytes=0-9" };
    expect((await get(route, { ...range, "If-Range": route.etag })).status).toBe(206);
    for (const stale of ['"sha256-0000"', `W/${route.etag}`, "Wed, 21 Oct 2015 07:28:00 GMT", "garbage", ""]) {
      const response = await get(route, { ...range, "If-Range": stale });
      expect(response.status, stale).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer()), stale).toEqual(image);
    }
    // A failed If-Range ignores even an unsatisfiable range instead of 416.
    expect((await get(route, { Range: "bytes=5000-", "If-Range": '"sha256-0000"' })).status).toBe(200);
    expect((await get(route, { Range: "bytes=5000-", "If-Range": route.etag })).status).toBe(416);
  });

  it("ignores Range on HEAD but still answers conditional HEAD", async () => {
    const { route, get } = await setup();
    const head = await get(route, { Range: "bytes=0-9" }, "image.png", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect(head.headers.has("content-range")).toBe(false);
    expect((await get(route, { "If-None-Match": route.etag }, "image.png", "HEAD")).status).toBe(304);
  });

  it("answers 404 before any validator when access is gone, never 304 or 206", async () => {
    const { route, get, state, reads } = await setup();
    const conditional = { "If-None-Match": route.etag };
    expect((await get(route, conditional)).status).toBe(304);
    state.memberDenied = name.startsWith("private");
    state.publicationGone = name === "public";
    state.shareGone = name === "share";
    if (name.startsWith("legacy")) {
      // Legacy membership is checked per request; a forged ticket names no member.
      const gone = await get({ ...route, signedIn: false, url: path => `/legacy-view/example/view/forged/files/${path}` }, conditional);
      expect(gone.status).toBe(404);
      expect(gone.headers.get("etag")).toBeNull();
      return;
    }
    reads.length = 0;
    for (const headers of [conditional, { ...conditional, Range: "bytes=0-9" }, { "If-None-Match": "*" }, { Range: "bytes=5000-" }]) {
      for (const method of ["GET", "HEAD"]) {
        const denied = await get(route, headers, "image.png", method);
        expect(denied.status, `${method} ${JSON.stringify(headers)}`).toBe(404);
        expect(denied.headers.get("etag")).toBeNull();
        expect(denied.headers.get("content-range")).toBeNull();
        expect(denied.headers.get("cache-control")).toBe("private, no-store");
      }
    }
    expect(reads).toEqual([]);
  });

  it("does not confirm unknown paths to a caller that holds a matching validator", async () => {
    const { route, get } = await setup();
    for (const path of ["missing.png", "%2e%2e/image.png", "assets%2f..%2fimage.png", "image.png%00"]) {
      const response = await get(route, { "If-None-Match": route.etag }, path);
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get("etag")).toBeNull();
    }
  });
});

describe("conditional and ranged delivery: unauthenticated and forged capabilities", () => {
  it("denies a private route to an anonymous or forged-ticket caller before comparing validators", async () => {
    const { routes, get, reads } = await fixture();
    const priv = routes.find(route => route.name === "private")!;
    const anonymous = await worker.request(`https://rendro.test${priv.url("image.png")}`, { headers: { "If-None-Match": imageEtag, Range: "bytes=0-9" } });
    expect(anonymous.status).toBe(404);
    expect(anonymous.headers.get("etag")).toBeNull();
    const forged = await get({ ...priv, signedIn: false, url: path => `${docsBase}/view/forged/files/${path}` }, { "If-None-Match": "*" });
    expect(forged.status).toBe(404);
    const share = await worker.request("https://rendro.test/s/token/files/assets/site.css", { headers: { "If-None-Match": imageEtag } });
    // A share names its asset allowlist: an unlisted path is denied even with a valid validator.
    expect(share.status).toBe(404);
    expect(share.headers.get("etag")).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe("conditional and ranged delivery: head-injected HTML", () => {
  it("gives public HTML a validator of its own, streams it whole and never byte-ranges it", async () => {
    const { routes, get, reads } = await fixture();
    const route = routes.find(route => route.name === "public")!;
    const full = await get(route, {}, "index.html");
    expect(full.status).toBe(200);
    const etag = full.headers.get("etag")!;
    expect(etag).toMatch(/^"sha256-[0-9a-f]{64}-i1-[0-9a-f]{24}"$/);
    expect(etag).not.toBe(htmlEtag);
    expect(full.headers.get("accept-ranges")).toBe("none");
    expect(full.headers.get("content-length")).toBeNull();
    expect(full.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(full.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const body = await full.text();
    expect(body).toContain("data-viewer=\"navigation\"");
    expect(body).toContain("Publisher document");

    reads.length = 0;
    const ranged = await get(route, { Range: "bytes=0-9", "If-Range": etag }, "index.html");
    expect(ranged.status).toBe(200);
    expect(ranged.headers.has("content-range")).toBe(false);
    expect(await ranged.text()).toBe(body);
    expect(reads.map(read => read.range)).toEqual([undefined]);
    expect((await get(route, { Range: "bytes=9999-" }, "index.html")).status).toBe(200);

    reads.length = 0;
    const notModified = await get(route, { "If-None-Match": etag }, "index.html");
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    expect(notModified.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(notModified.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(notModified.headers.get("x-content-type-options")).toBe("nosniff");
    // The stored bytes' validator does not name the transformed body.
    expect((await get(route, { "If-None-Match": htmlEtag }, "index.html")).status).toBe(200);
    reads.length = 0;
    const head = await get(route, {}, "index.html", "HEAD");
    expect(head.headers.get("etag")).toBe(etag);
    expect(reads).toEqual([]);
  });

  it("changes the validator when the injected markup changes", async () => {
    const { routes, get } = await fixture();
    const route = routes.find(route => route.name === "public")!;
    const first = (await get(route, {}, "index.html")).headers.get("etag");
    const other = await worker.request("https://other.test/p/product/files/index.html");
    expect(other.headers.get("etag")).not.toBe(first);
  });

  it.each(["share", "private", "private ticket", "legacy private", "legacy ticket"])("never ranges or validates the per-reader HTML on %s", async name => {
    const { routes, get, reads } = await fixture();
    const route = routes.find(route => route.name === name)!;
    const path = "index.html";
    const response = await get(route, { Range: "bytes=0-9", "If-Range": "*" }, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBe("none");
    expect(response.headers.has("content-range")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toContain("data-viewer=");
    expect(reads.map(read => read.range)).toEqual([undefined]);
    // Only the wildcard can be satisfied without a validator.
    expect((await get(route, { "If-None-Match": htmlEtag }, path)).status).toBe(200);
    expect((await get(route, { "If-None-Match": "*" }, path)).status).toBe(304);
  });
});

describe("conditional and ranged delivery: objects without hashes", () => {
  it("serves entries of older manifests whole, without validators or ranges", async () => {
    const f = await fixture();
    vi.mocked(blobs.getObjectText).mockResolvedValue(JSON.stringify({ files: [{ path: "image.png", contentType: "image/png" }] }));
    const route = f.routes.find(route => route.name === "private")!;
    const response = await f.get(route, { Range: "bytes=0-9", "If-None-Match": imageEtag });
    expect(response.status).toBe(200);
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("accept-ranges")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
  });
});

describe("public publication HTML streaming", () => {
  it("sends the injected head before the tail of a multi-megabyte document arrives, with bounded buffering", async () => {
    const { routes, get } = await fixture();
    const route = routes.find(route => route.name === "public")!;
    const chunk = encoder.encode(`<p>${"x".repeat(256 * 1024)}</p>`);
    const head = encoder.encode('<!doctype html><html><head><meta charset="utf-8"></head><body>');
    const total = 40;
    let pulled = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(blobs.getObjectStream).mockImplementation(() => Promise.resolve(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulled === 0) controller.enqueue(head);
        else if (pulled <= total) {
          // The tail of the document is not available until the test releases it.
          if (pulled === total / 2) await gate;
          controller.enqueue(chunk);
        } else controller.close();
        pulled++;
      },
    }, { highWaterMark: 0 })));
    const response = await get(route, {}, "index.html");
    const reader = response.body!.getReader();
    let first = "";
    while (!first.includes("data-viewer=\"navigation\"")) first += new TextDecoder().decode((await reader.read()).value);
    // The navigation script is out while half of the document is still withheld.
    expect(first).toContain("<!doctype html>");
    expect(pulled).toBeLessThan(total / 2);
    expect(pulled * chunk.length).toBeLessThan(total * chunk.length / 2);
    release();
    let size = new TextEncoder().encode(first).length;
    for (let next = await reader.read(); !next.done; next = await reader.read()) size += next.value.length;
    expect(size).toBeGreaterThan(head.length + total * chunk.length);
    expect(pulled).toBe(total + 2);
  });
});
