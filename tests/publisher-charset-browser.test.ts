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
