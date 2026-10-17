import type { Frame, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { browserStep, buildBrowserBundle as build, createBrowserHarness } from "./helpers/browser";
import { createAssetFixture, privateBase } from "./fixtures/viewer-assets";

const harness = createBrowserHarness();
const surfaces = ["/p/fixture", "/s/fixture", privateBase];
const cdn = "https://cdn.publisher.test";
let handler: (request: Request) => Promise<Response>;
let html = "";
const seen: Array<{ path: string; cookie?: string; origin?: string }> = [];
const cdnRequests: string[] = [];

/** 0.1 s of 8 kHz 8-bit mono PCM: the smallest honest media file every Chromium build can decode. */
function wav() {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, "data"); view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return bytes;
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>';
const extraFiles = [
  { path: "guide/assets/site2.css", contentType: "text/css", body: '@import "imported.css"; #styled { color: rgb(1, 2, 3) }' },
  { path: "guide/assets/imported.css", contentType: "text/css", body: "#imported { color: rgb(4, 5, 6) }" },
  { path: "guide/assets/tone.wav", contentType: "audio/wav", body: wav() },
];

beforeAll(async () => {
  // Each test serves its own document (and the share's allowed assets are discovered from it): see serve().
  await harness.start((request, response) => {
    void (async () => {
      const url = new URL(request.url!, harness.origin);
      seen.push({ path: url.pathname, cookie: request.headers.cookie, origin: request.headers.origin });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const result = await handler(new Request(url, { headers }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(error => response.destroy(error as Error));
  });
});
beforeEach(() => { seen.length = 0; cdnRequests.length = 0; });
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function serve(documentHtml: string) {
  html = documentHtml;
  const { app } = await createAssetFixture("document.body.dataset.module = 'loaded';", { html, extraFiles });
  for (const [url, entry] of [["/private-viewer.js", "src/viewer/entry.ts"], ["/lazy-tree.js", "src/lazy-tree/lazy-tree.ts"]]) {
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser" });
    app.get(url, c => c.body(bundle.outputFiles[0].text, 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  }
  app.get("/commentor.js", c => c.body("", 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  handler = request => Promise.resolve(app.request(request));
}

async function open(base: string): Promise<{ page: Page; frame: Frame }> {
  const page = await harness.newPage();
  // Third-party services of the shell are out of scope; the publisher's own CDN is answered here, offline.
  await page.route(url => url.origin !== harness.origin, route => {
    const url = new URL(route.request().url());
    if (url.hostname === "cdn.tailwindcss.com") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: "window.tailwind = {};" });
    if (url.origin !== cdn) return route.abort();
    cdnRequests.push(url.pathname);
    if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: "document.documentElement.dataset.external = 'ran';" });
    if (url.pathname.endsWith(".css")) return route.fulfill({ contentType: "text/css", body: "#external { color: rgb(7, 8, 9) }" });
    return route.fulfill({ contentType: "image/svg+xml", body: svg });
  });
  if (base === privateBase) {
    await page.context().addCookies([{ name: "better-auth.session_token", value: "fixture.signature", url: harness.origin, sameSite: "Lax" }]);
  }
  await browserStep("open viewer shell", () => page.goto(harness.origin + base, { waitUntil: "domcontentloaded" }));
  await browserStep("wait for publisher frame", () => page.waitForFunction(() => {
    const src = document.querySelector<HTMLIFrameElement>("#content-frame")?.getAttribute("src");
    return Boolean(src && src !== "about:blank");
  }));
  const frame = await (await page.locator("#content-frame").elementHandle())!.contentFrame();
  if (!frame) throw new Error("Missing publisher frame");
  return { page, frame };
}

describe("publisher content in the opaque frame of every viewer surface", () => {
  it.each(surfaces)("runs inline and external scripts and styles, imports, modules and media in %s", async base => {
    await serve(`<!doctype html><html><head><meta charset="utf-8"><title>Publisher content</title>
      <link rel="stylesheet" href="assets/site2.css"><link rel="stylesheet" href="${cdn}/lib.css">
      <style>#inline { color: rgb(10, 11, 12) }</style>
      <script src="${cdn}/lib.js"></script><script>document.documentElement.dataset.inline = "ran"</script>
      <script type="module" src="assets/module.js"></script></head>
      <body><p id="styled">a</p><p id="imported">b</p><p id="external">c</p><p id="inline">d</p>
      <audio id="audio" preload="auto" src="assets/tone.wav"></audio></body></html>`);
    const { page, frame } = await open(base);
    try {
      await browserStep("run publisher scripts and apply styles", () => frame.waitForFunction(() => {
        const color = (id: string) => getComputedStyle(document.getElementById(id)!).color;
        return document.documentElement.dataset.inline === "ran" && document.documentElement.dataset.external === "ran"
          && document.body.dataset.module === "loaded"
          && color("styled") === "rgb(1, 2, 3)" && color("imported") === "rgb(4, 5, 6)"
          && color("external") === "rgb(7, 8, 9)" && color("inline") === "rgb(10, 11, 12)";
      }));
      const media = await browserStep("decode the media file", () => frame.evaluate(() => new Promise<{ error: boolean; duration: number }>(resolve => {
        const audio = document.getElementById("audio") as HTMLAudioElement;
        const done = () => resolve({ error: audio.error !== null, duration: Math.round(audio.duration * 10) / 10 });
        if (audio.readyState >= 1 || audio.error) done();
        else { audio.addEventListener("loadedmetadata", done, { once: true }); audio.addEventListener("error", done, { once: true }); }
      })));
      expect(media).toEqual({ error: false, duration: 0.1 });
      expect(await frame.evaluate(() => self.origin)).toBe("null");
      expect(cdnRequests.sort()).toEqual(["/lib.css", "/lib.js"]);
      // None of the frame's subresources relied on the reader's cookie.
      for (const file of ["site2.css", "imported.css", "module.js", "tone.wav"]) {
        const requests = seen.filter(request => request.path.endsWith(`/${file}`));
        expect(requests.length, file).toBeGreaterThan(0);
        expect(requests.filter(request => request.cookie !== undefined), file).toEqual([]);
      }
    } finally { await page.close(); }
  });

  it.each(surfaces)("resolves relative resources against a publisher base inside the document tree in %s", async base => {
    await serve('<!doctype html><html><head><base href="assets/"><title>Base</title></head><body><img id="image" src="image.svg"></body></html>');
    const { page, frame } = await open(base);
    try {
      await browserStep("load the image through the base", () => frame.waitForFunction(() => (document.getElementById("image") as HTMLImageElement).naturalWidth === 10));
      expect(seen.filter(request => request.path.endsWith("/assets/image.svg")).length).toBeGreaterThan(0);
      expect(seen.filter(request => request.path.endsWith("/guide/image.svg"))).toEqual([]);
      expect(cdnRequests).toEqual([]);
    } finally { await page.close(); }
  });

  it.each(surfaces)("keeps an external publisher base in charge of relative resources in %s", async base => {
    await serve(`<!doctype html><html><head><base href="${cdn}/base/"><title>External base</title></head><body><img id="image" src="pic.svg"></body></html>`);
    const { page, frame } = await open(base);
    try {
      await browserStep("load the image from the publisher's base", () => frame.waitForFunction(() => (document.getElementById("image") as HTMLImageElement).naturalWidth === 10));
      expect(cdnRequests).toEqual(["/base/pic.svg"]);
      expect(seen.filter(request => request.path.endsWith("/pic.svg"))).toEqual([]);
      expect(await frame.evaluate(() => document.baseURI)).toBe(`${cdn}/base/`);
    } finally { await page.close(); }
  });
});
