import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureCliPush } from "./helpers/cli-push";
import { getRequestListener } from "@hono/node-server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as minio from "@/minio";
import worker from "@/worker";
import { cookie, publisherIsolationFixture } from "./fixtures/publisher-isolation";
import { bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
beforeAll(async () => {
  const viewer = await bundleBrowserAsset("src/viewer/entry.ts");
  const listener = getRequestListener(request => worker.fetch(request, {
    ASSETS: { fetch: () => new Response(viewer, { headers: { "Content-Type": "text/javascript" } }) },
  }));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(["stored charset", "in-band charset"])("%s", mode => {
  it.each(["public", "private", "private ticket", "legacy private", "legacy ticket"])(
    "renders a Windows-1252 non-ASCII CSS selector through %s", async name => {
      const { routes } = await publisherIsolationFixture();
      const cssType = mode === "stored charset" ? "text/css; charset=windows-1252" : "text/css";
      vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ files: [
        { path: "index.html", contentType: "text/html; charset=utf-8" },
        { path: "style.css", contentType: cssType },
      ] }));
      vi.mocked(minio.headObject).mockImplementation(key => Promise.resolve({
        contentType: key.endsWith("/style.css") ? cssType : "text/html; charset=utf-8",
      }));
      const declaration = mode === "in-band charset" ? '@charset "windows-1252"; ' : '';
      const css = Buffer.from(declaration + '.caf\xe9 { color: rgb(1, 2, 3) }', "latin1");
      vi.mocked(minio.getObjectStream).mockImplementation(key => Promise.resolve(new Response(key.endsWith("/style.css")
        ? css : '<!doctype html><link rel="stylesheet" href="style.css"><p class="café">Publisher text</p>').body));
      const page = await harness.newPage();
      await page.context().addCookies([{ name: cookie.split("=")[0], value: cookie.split("=")[1], url: harness.origin }]);
      const stylesheet = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/style.css"));
      const response = await page.goto(harness.origin + routes.find(route => route.name === name)!.url(0));
      expect(response?.status()).toBe(200);
      const sheet = await stylesheet;
      expect(sheet.status()).toBe(200);
      expect(sheet.headers()["content-type"]).toBe(cssType);
      // Chromium exposes decoded text through response.body(); the request API
      // reads the actual HTTP bytes independently of the browser text decoder.
      expect(await (await page.request.get(sheet.url())).body()).toEqual(css);
      expect(await page.locator("p").evaluate(element => getComputedStyle(element).color)).toBe("rgb(1, 2, 3)");
      expect(await page.evaluate(() => self.origin)).toBe("null");
    },
  );

  it.each(["private", "private ticket", "legacy private", "legacy ticket"])(
    "preserves Windows-1252 HTML rendering through %s", async name => {
      const { routes } = await publisherIsolationFixture();
      const htmlType = mode === "stored charset" ? "text/html; charset=windows-1252" : "text/html";
      vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ files: [
        { path: "index.html", contentType: htmlType },
      ] }));
      vi.mocked(minio.headObject).mockResolvedValue({ contentType: htmlType });
      const declaration = mode === "in-band charset" ? '<meta charset="windows-1252">' : '';
      const html = Buffer.from(`<!doctype html><html><head>${declaration}</head><body><p>caf\xe9</p></body></html>`, "latin1");
      vi.mocked(minio.getObjectStream).mockImplementation(() => Promise.resolve(new Response(html).body));
      const page = await harness.newPage();
      await page.context().addCookies([{ name: cookie.split("=")[0], value: cookie.split("=")[1], url: harness.origin }]);
      const response = await page.goto(harness.origin + routes.find(route => route.name === name)!.url(0));
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-type"]).toBe(htmlType);
      expect(await (await page.request.get(response!.url())).body()).toEqual(html);
      expect(await page.locator("p").textContent()).toBe("café");
      expect(await page.evaluate(() => self.origin)).toBe("null");
    },
  );
});

// Feed the real CLI's manifest and upload bytes into the existing Worker fixture.
// Storage/auth remain substituted, while browser decoding and Worker delivery run.
it.each(["fresh", "reused", "existing UTF-8"])("renders CLI CSS café € through Worker routes (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "rendro-cli-charset-"));
  try {
    const css = mode === "existing UTF-8"
      ? Buffer.from('p::before { content: "café €"; }')
      : Buffer.from('@charset "windows-1252"; p::before { content: "caf\xe9 \x80"; }', "latin1");
    const html = Buffer.from('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><p>Publisher text</p>');
    await writeFile(join(root, "style.css"), css);
    await writeFile(join(root, "index.html"), html);
    const previous = [{ path: "style.css", contentType: "text/css; charset=utf-8", size: css.length,
      sha256: createHash("sha256").update(css).digest("hex") }];
    const capture = await captureCliPush(root, { previous: mode === "reused" ? previous : undefined });
    const cssType = mode === "existing UTF-8" ? previous[0].contentType : "text/css";
    expect(capture.manifest.files.find(file => file.path === "style.css")?.contentType).toBe("text/css");
    if (mode === "reused") {
      expect(capture.copied).toEqual(["style.css"]);
      expect(capture.uploads.has("style.css")).toBe(false);
    } else expect(capture.uploads.get("style.css")).toEqual({ bytes: css, contentType: "text/css" });
    const { routes } = await publisherIsolationFixture();
    // Old manifests are still valid; exercise them unchanged as well.
    const manifest = mode === "existing UTF-8" ? { ...capture.manifest, files: capture.manifest.files.map(file =>
      file.path === "style.css" ? previous[0] : { ...file, contentType: "text/html; charset=utf-8" }) } : capture.manifest;
    vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify(manifest));
    // Copied objects retain old storage metadata. Modern routes use the manifest.
    vi.mocked(minio.headObject).mockResolvedValue({ contentType: "text/css; charset=utf-8" });
    vi.mocked(minio.getObjectStream).mockImplementation(key => Promise.resolve(new Response(new Uint8Array(key.endsWith("/style.css")
      ? capture.uploads.get("style.css")?.bytes ?? css : capture.uploads.get("index.html")!.bytes)).body));
    for (const name of ["public", "private", "private ticket"]) {
      const page = await harness.newPage();
      await page.context().addCookies([{ name: cookie.split("=")[0], value: cookie.split("=")[1], url: harness.origin }]);
      const stylesheet = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/style.css"));
      await page.goto(harness.origin + routes.find(route => route.name === name)!.url(0));
      const sheet = await stylesheet;
      expect(sheet.status(), name).toBe(200);
      expect(sheet.headers()["content-type"], name).toBe(cssType);
      expect(await (await page.request.get(sheet.url())).body(), name).toEqual(css);
      expect(await page.locator("p").evaluate(element => getComputedStyle(element, "::before").content), name).toBe('"café €"');
      expect(await page.evaluate(() => self.origin), name).toBe("null");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
