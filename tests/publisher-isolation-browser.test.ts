import { getRequestListener } from "@hono/node-server";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import * as minio from "@/minio";
import worker from "@/worker";
import { cookie, publisherIsolationFixture } from "./fixtures/publisher-isolation";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
let fixture: Awaited<ReturnType<typeof publisherIsolationFixture>>;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
<style>rect { fill: rgb(0, 128, 0); }</style><rect width="10" height="10"/>
<script><![CDATA[
document.documentElement.setAttribute('data-script', 'ran');
try { document.documentElement.setAttribute('data-cookie', document.cookie); } catch {}
fetch('/api/auth/get-session', {credentials:'include'}).then(r => r.text()).then(value => {
  document.documentElement.setAttribute('data-api', value);
}).catch(() => {});
]]></script></svg>`;

beforeAll(async () => {
  fixture = await publisherIsolationFixture(["style.css", "image.svg", "font.woff2"]);
  const original = vi.mocked(minio.getObjectStream).getMockImplementation()!;
  // Responses announce the manifest size, so a replaced body must be re-measured.
  const manifest = JSON.parse(await minio.getObjectText("") as string) as { files: Array<{ path: string; size: number }> };
  vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ ...manifest, files: manifest.files.map(file =>
    file.path === "image.svg" ? { ...file, size: Buffer.byteLength(svg) } : file) }));
  vi.mocked(minio.getObjectStream).mockImplementation(key => {
    if (key.endsWith("/image.svg")) return Promise.resolve(new Response(svg).body);
    if (key.endsWith("/index.html")) return Promise.resolve(new Response(`<!doctype html><html><head>
      <link rel="stylesheet" href="style.css"></head><body><p id="font">AAAA</p>
      <img id="image" src="image.svg"><script>document.body.dataset.script='ran'</script></body></html>`).body);
    return original(key);
  });
  const viewer = await bundleBrowserAsset("src/viewer/entry.ts");
  const listener = getRequestListener(request => worker.fetch(request, {
    ASSETS: { fetch: () => new Response(viewer, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }) },
  }));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function pageWithSession() {
  const page = await harness.newPage();
  await page.context().addCookies([
    { name: cookie.split("=")[0], value: cookie.split("=")[1], url: harness.origin },
    { name: "readable-fixture", value: "private-value", url: harness.origin },
  ]);
  return page;
}

it("isolates a directly opened scripted SVG from application cookies and API responses", async () => {
  const page = await pageWithSession();
  const control = await page.request.get(harness.origin + "/api/auth/get-session");
  expect(control.status()).toBe(200);
  expect((await control.json()).user.id).toBe("user-a");
  const response = await page.goto(harness.origin + "/p/product/files/image.svg");
  expect(response?.status()).toBe(200);
  expect(await response!.text()).toContain("data-script");
  expect(await page.locator("svg").getAttribute("data-script")).toBeNull();
  expect(await page.locator("svg").getAttribute("data-cookie")).toBeNull();
  expect(await page.locator("svg").getAttribute("data-api")).toBeNull();
  expect(await page.locator("rect").evaluate(rect => getComputedStyle(rect).fill)).toBe("rgb(0, 128, 0)");
  // Automation executes even when document scripts are disabled: prove the
  // browser's origin boundary as well as the CSP script restriction.
  expect(await page.evaluate(async () => {
    let cookieBlocked = false;
    let apiBlocked = false;
    try { void document.cookie; } catch { cookieBlocked = true; }
    try { await fetch('/api/auth/get-session', { credentials: 'include' }); } catch { apiBlocked = true; }
    return { origin: self.origin, cookieBlocked, apiBlocked };
  })).toEqual({ origin: "null", cookieBlocked: true, apiBlocked: true });
});

describe("publisher resource rendering under the response sandbox", () => {
  it.each(["public", "share", "private", "private ticket", "legacy private", "legacy ticket"])("renders HTML, CSS, SVG images and fonts through %s", async name => {
    const page = await pageWithSession();
    const route = fixture.routes.find(route => route.name === name)!;
    const response = await page.goto(harness.origin + route.url(0));
    expect(response?.status()).toBe(200);
    const result = await page.evaluate(async () => {
      await document.fonts.load("16px Fixture", "AAAA");
      await document.fonts.ready;
      const image = document.querySelector<HTMLImageElement>("#image")!;
      return { origin: self.origin, script: document.body.dataset.script,
        color: getComputedStyle(document.querySelector("#font")!).color,
        image: image.complete && image.naturalWidth === 10,
        fonts: [...document.fonts].map(font => ({ family: font.family, status: font.status })) };
    });
    expect(result).toEqual({ origin: "null", script: "ran", color: "rgb(1, 2, 3)", image: true,
      fonts: [{ family: "Fixture", status: "loaded" }] });
  });
});

it("keeps the share iframe opaque across document, asset, error and blank navigations", async () => {
  const page = await pageWithSession();
  await page.goto(harness.origin + "/s/0");
  const iframe = page.locator("#content-frame");
  expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-downloads");
  const frame = await (await iframe.elementHandle())!.contentFrame();
  if (!frame) throw new Error("Share frame missing");
  for (const path of ["/s/0/files/index.html", "/p/product/files/image.svg", "/p/product/files/document.xhtml", "/s/0/files/missing.html", "about:blank"]) {
    await browserStep(`navigate share frame to ${path}`, () => frame.goto(path === "about:blank" ? path : harness.origin + path));
    expect(await frame.evaluate(() => {
      let parentBlocked = false;
      let cookieBlocked = false;
      try { void parent.document.body; } catch { parentBlocked = true; }
      try { void document.cookie; } catch { cookieBlocked = true; }
      return { origin: self.origin, parentBlocked, cookieBlocked };
    }), path).toEqual({ origin: "null", parentBlocked: true, cookieBlocked: true });
  }
});
