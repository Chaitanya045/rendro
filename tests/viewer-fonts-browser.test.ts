import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browserStep, createBrowserHarness } from "./helpers/browser";
import { createAssetFixture, privateBase } from "./fixtures/viewer-assets";

const harness = createBrowserHarness();
const corsRequests: Array<{ file: string; origin?: string; cookie?: string }> = [];

beforeAll(async () => {
  const { app } = await createAssetFixture();
  for (const [url, entry] of [["/private-viewer.js", "src/viewer/entry.ts"], ["/lazy-tree.js", "src/lazy-tree/lazy-tree.ts"]]) {
    const bundle = await browserStep(`bundle ${entry}`, () => build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser" }));
    app.get(url, c => c.body(bundle.outputFiles[0].text, 200, { "Content-Type": "text/javascript" }));
  }
  app.get("/commentor.js", c => c.body("", 200, { "Content-Type": "text/javascript" }));
  await harness.start((request, response) => {
    void (async () => {
      const url = new URL(request.url!, harness.origin);
      const file = url.pathname.split("/").pop()!;
      if (["font.woff2", "image.svg", "module.js", "data.json"].includes(file)) {
        corsRequests.push({ file, origin: request.headers.origin, cookie: request.headers.cookie });
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const result = await app.request(url.href, { headers });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(error => response.destroy(error as Error));
  });
});

afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("opaque viewer CORS resources in Chromium", () => {
  it.each(["/p/fixture", "/s/fixture", privateBase])("loads relative fonts, images, modules and fetch in %s", async base => {
    corsRequests.length = 0;
    const page = await harness.newPage();
    const errors: string[] = [];
    page.on("console", message => {
      if (/cors|access-control|font|content security policy/i.test(message.text()) && message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", error => errors.push(error.message));
    // Shell-only third-party services are outside this offline asset regression.
    await page.route(url => url.origin !== harness.origin, route => route.request().url().includes("cdn.tailwindcss.com")
      ? route.fulfill({ contentType: "text/javascript", body: "window.tailwind = {};" }) : route.abort());
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
    await browserStep("load publisher CORS resources", () => frame.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#image");
      return document.body?.dataset.module === "loaded" && document.body.dataset.fetched === "loaded"
        && image?.complete && image.naturalWidth > 0;
    }));
    const fonts = await browserStep("load relative font face", () => frame.evaluate(async () => {
      await document.fonts.load('16px Fixture', 'AAAA');
      await document.fonts.ready;
      return { origin: self.origin, status: document.fonts.status, check: document.fonts.check('16px Fixture', 'AAAA'),
        faces: [...document.fonts].map(face => ({ family: face.family, status: face.status })) };
    }));
    expect(fonts).toEqual({ origin: "null", status: "loaded", check: true, faces: [{ family: "Fixture", status: "loaded" }] });
    for (const file of ["font.woff2", "image.svg", "module.js", "data.json"]) {
      expect(corsRequests.filter(request => request.file === file)).toEqual([{ file, origin: "null", cookie: undefined }]);
    }
    expect(errors, "font/CORS/CSP console errors and publisher exceptions").toEqual([]);
  });
});
