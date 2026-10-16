import { getRequestListener } from "@hono/node-server";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import shareRoutes from "../src/routes/share-v2";
import { shareCreationFixture } from "./helpers/share-creation";
import { createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
beforeAll(async () => {
  const listener = getRequestListener(request => shareRoutes.fetch(request));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>';
const html = '<!doctype html><img id="asset" src="café.svg"><link rel="stylesheet" href="style.css"><p>fixture</p>';
const css = 'p { background-image: url("café.css.svg"); color: rgb(1, 2, 3) }';
const latin = (value: string) => Buffer.from(value, "latin1");
const utf8 = (value: string) => Buffer.from(value);
const bom8 = (value: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(value)]);
const bom16 = (value: string, big = false) => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
  return big ? bytes.swap16() : bytes;
};

it.each([
  { name: "invalid charset before content and later UTF-8", html: utf8('<meta charset=bogus content="charset=windows-1252" http-equiv=content-type><meta charset=utf-8>' + html), css: utf8(css) },
  { name: "HTML meta + CSS inheritance", html: latin('<meta charset=windows-1252>' + html), css: latin(css) },
  { name: "http-equiv + CSS inheritance", html: latin('<meta content="text/html; charset=iso-8859-1" http-equiv=Content-Type>' + html), css: latin(css) },
  { name: "manifest overrides declarations", html: latin('<meta charset=utf-8>' + html), css: latin('@charset "utf-8";' + css), htmlType: "text/html; charset=windows-1252", cssType: "text/css; charset=windows-1252" },
  { name: "UTF-8 BOM overrides manifest", html: bom8(html), css: bom8(css), htmlType: "text/html; charset=windows-1252", cssType: "text/css; charset=windows-1252" },
  { name: "UTF-16LE BOM", html: bom16(html), css: bom16(css) },
  { name: "UTF-16BE BOM", html: bom16(html, true), css: bom16(css, true) },
  { name: "CSS charset overrides document", html: utf8('<meta charset=utf-8>' + html), css: latin('@charset "windows-1252";' + css) },
  { name: "UTF-8 fallback", html: utf8(html.replace("café.svg", "caf%C3%A9.svg")), css: utf8(css), cssType: "text/css; charset=utf-8" },
])("creates and delivers discovered resources: $name", async testCase => {
  const f = await shareCreationFixture();
  // CSS references its own resource so HTML discovery cannot mask a CSS failure.
  const files = [
    { path: "guide/index.html", contentType: testCase.htmlType ?? "text/html", body: testCase.html },
    { path: "guide/style.css", contentType: testCase.cssType ?? "text/css", body: testCase.css },
    { path: "guide/café.svg", contentType: "image/svg+xml", body: utf8(svg) },
    { path: "guide/café.css.svg", contentType: "image/svg+xml", body: utf8(svg) },
    { path: "guide/cafÃ©.svg", contentType: "application/json", body: utf8("unrelated") },
    { path: "guide/private.json", contentType: "application/json", body: utf8("private") },
  ];
  f.manifest.mockResolvedValue(JSON.stringify({ files }));
  f.read.mockImplementation(key => Promise.resolve(new Response(files.find(file => key.endsWith("/files/" + file.path))!.body).body));
  const created = await f.request();
  expect(created.status).toBe(201);
  const { token, grant } = await created.json();
  expect(grant.assetPaths).toEqual(["guide/café.css.svg", "guide/café.svg", "guide/style.css"]);
  const page = await harness.newPage();
  const resource = page.waitForResponse(response => decodeURIComponent(response.url()).endsWith("/café.css.svg"));
  const response = await page.goto(`${harness.origin}/s/${token}/files/guide/index.html`);
  expect(response?.status()).toBe(200);
  expect((await resource).status()).toBe(200);
  await expect.poll(() => page.locator("#asset").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(10);
  expect(await page.locator("p").evaluate(el => getComputedStyle(el).color)).toBe("rgb(1, 2, 3)");
  expect((await page.request.get(`${harness.origin}/s/${token}/files/guide/private.json`)).status()).toBe(404);
  expect((await page.request.get(`${harness.origin}/s/${token}/files/guide/caf%C3%83%C2%A9.svg`)).status()).toBe(404);
});

it.each(["\u00a0", "\u2028", "\u3000", "\u0085", "\u200b", "\ufeff"])("does not authorize a Unicode-separated srcset prefix (%j)", async whitespace => {
  const f = await shareCreationFixture();
  const exact = `private.json${whitespace}1x`;
  const files = [
    { path: "guide/index.html", contentType: "text/html; charset=utf-8", body: `<img id="asset" srcset="${exact}">` },
    { path: "guide/" + exact, contentType: "image/svg+xml", body: svg },
    { path: "guide/private.json", contentType: "application/json", body: "private" },
  ];
  f.manifest.mockResolvedValue(JSON.stringify({ files }));
  f.read.mockImplementation(key => Promise.resolve(new Response(files.find(file => key.endsWith("/files/" + file.path))!.body).body));
  const created = await f.request();
  expect(created.status).toBe(201);
  const { token, grant } = await created.json();
  expect(grant.assetPaths).toEqual(["guide/" + exact]);
  const page = await harness.newPage();
  const requested = page.waitForRequest(request => decodeURIComponent(new URL(request.url()).pathname).endsWith("/" + exact));
  await page.goto(`${harness.origin}/s/${token}/files/guide/index.html`);
  expect(decodeURIComponent(new URL((await requested).url()).pathname)).toBe(`/s/${token}/files/guide/${exact}`);
  const actual = await page.locator("#asset").evaluate(el => (el as HTMLImageElement).currentSrc);
  expect(decodeURIComponent(new URL(actual).pathname)).toBe(`/s/${token}/files/guide/${exact}`);
  expect((await page.request.get(`${harness.origin}/s/${token}/files/guide/private.json`)).status()).toBe(404);
});
