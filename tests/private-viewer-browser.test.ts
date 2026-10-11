import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { injectViewerHeadStream } from "@/routes/document-html";
import { viewerScript } from "@/viewer/markup";
import { viewerHtmlForms } from "./fixtures/private-viewer-html";

const base = "/organizations/org/projects/project/docs";
const prefix = (ticket: string) => `${base}/view/${ticket}/files/`;
const epoch = 1_800_000_000_000;
const ttl = 15 * 60_000;
let now = epoch;
let serial = 0;
const tickets = new Map([["initial", epoch + ttl]]);
const requests: Array<{ path: string; status: number }> = [];
let publisherHtml = "";
let browser: Browser;
let server: Server;
let origin: string;

beforeAll(async () => {
  const bundle = await build({ entryPoints: ["src/viewer/entry.ts"], bundle: true, write: false, format: "iife", platform: "browser" });
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, origin);
      const send = (status: number, type: string, body: string) => {
        requests.push({ path: url.pathname, status });
        response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "null" });
        response.end(body);
      };
      if (url.pathname === "/private-viewer.js") return send(200, "text/javascript", bundle.outputFiles[0].text);
      if (url.pathname === "/") return send(200, "text/html", `<!doctype html>
        <iframe id="content-frame" sandbox="allow-scripts" src="${base}/files/guide/index.html"></iframe>
        ${viewerScript("parent", { base })}`);
      if (url.pathname === `${base}/viewer-ticket`) {
        const ticket = `renewed-${++serial}`;
        tickets.set(ticket, now + ttl);
        return send(200, "application/json", JSON.stringify({ prefix: prefix(ticket) }));
      }
      if (url.pathname === `${base}/files/guide/index.html`) {
        response.setHeader("Content-Security-Policy", "sandbox allow-scripts; frame-ancestors 'self'");
        const html = await new Response(injectViewerHeadStream(new Response(publisherHtml).body!, () =>
          `<base data-rendro-viewer href="${prefix('initial')}guide/index.html">`
          + viewerScript("frame", { base, prefix: prefix("initial"), manifestKey: "release/manifest.json" }),
        )).text();
        return send(200, "text/html", html);
      }
      const match = url.pathname.match(/\/view\/([^/]+)\/files\/guide\/assets\/(.+)$/);
      if (match) {
        if ((tickets.get(match[1]) ?? 0) <= now) return send(404, "text/plain", "expired");
        const asset = decodeURIComponent(match[2]);
        if (asset === "site.css") return send(200, "text/css", '@import "nested/theme.css"; #linked { background-image: url(linked.svg) }');
        if (asset === "nested/theme.css") return send(200, "text/css", '#nested { background-image: url(../nested.svg) }');
        if (asset === "import.css") return send(200, "text/css", '#imported { background-image: url(imported.svg) }');
        if (asset.endsWith(".svg")) return send(200, "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>');
      }
      send(404, "text/plain", "missing");
    })().catch(error => { response.destroy(error as Error); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  // CI installs Playwright Chromium; developer hosts may use a local Chromium.
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined) });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("opaque-origin Chromium private viewer", () => {
  it("loads first-used inline, block, imported and linked CSS images after the initial ticket expires", async () => {
    publisherHtml = String.raw`<!doctype html><html><head>
      <link rel="stylesheet" href="assets/site.css">
      <style>@import "assets/import.css";
        #block { background-image: url('assets/block.svg') }
        #hidden div { width: 10px; height: 10px }
      </style></head><body>
      <div id="hidden" style="display:none">
        <div id="inline" style="background-image: u\72l(assets/inline\(escaped\).svg)"></div>
        <div id="block"></div><div id="linked"></div><div id="nested"></div><div id="imported"></div>
      </div><textarea>Comment draft</textarea></body></html>`;
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      // Parent sees a true opaque-origin postMessage, not a same-origin DOM mock.
      await page.evaluate(() => {
        window.addEventListener("message", event => {
          if (event.data?.type === "viewer-renew") document.body.dataset.frameOrigin = event.origin;
        });
      });
      for (let round = 1; round <= 3; round++) {
        now = epoch + round * 6 * 60_000;
        await frame.evaluate(time => { Date.now = () => time; window.dispatchEvent(new Event("focus")); }, now);
        await frame.waitForFunction(expected => document.baseURI.includes(expected), `/view/renewed-${round}/`);
        await frame.waitForFunction(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
          .every(link => link.sheet !== null));
        await expect.poll(() => requests.some(request => request.path.includes(`/view/renewed-${round}/`)
          && request.path.endsWith("/nested/theme.css") && request.status === 200)).toBe(true);
      }
      expect(await page.locator("body").getAttribute("data-frame-origin")).toBe("null");
      expect(requests.filter(request => request.path.endsWith(".svg"))).toEqual([]);
      // Server-side fake clock enforces TTL: the original capability now fails.
      const expired = await page.request.get(`${origin}${prefix("initial")}guide/assets/probe.svg`);
      expect(expired.status()).toBe(404);
      requests.length = 0;
      await frame.locator("#hidden").evaluate(element => { (element as HTMLElement).style.display = "block"; });
      await expect.poll(() => requests.filter(request => request.path.endsWith(".svg") && request.status === 200).length).toBe(5);
      for (const resource of ["inline(escaped).svg", "block.svg", "linked.svg", "nested.svg", "imported.svg"]) {
        expect(requests.some(request => decodeURIComponent(request.path) === `${prefix("renewed-3")}guide/assets/${resource}`
          && request.status === 200), resource).toBe(true);
      }
      expect(requests.some(request => request.path.includes("/view/initial/"))).toBe(false);
      expect(await frame.locator("textarea").inputValue()).toBe("Comment draft");
    } finally { await page.close(); }
  });

  it.each(viewerHtmlForms)("loads the first stylesheet with an %s document", async (_name, source) => {
    now = epoch;
    publisherHtml = source;
    requests.length = 0;
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      expect(requests.some(request => request.path === `${prefix("initial")}guide/assets/site.css` && request.status === 200)).toBe(true);
      expect(requests.some(request => request.path === `${base}/files/guide/assets/site.css`)).toBe(false);
    } finally { await page.close(); }
  });
});
