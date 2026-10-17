import type { BrowserContextOptions, Frame, Page } from "playwright";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { injectViewerHeadStream } from "@/routes/document-html";
import { viewerScript } from "@/viewer/markup";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";
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
let heldAsset = "";
const heldSheets: Array<{ path: string; release: (status: number) => void }> = [];
const harness = createBrowserHarness();

async function openViewer(options: BrowserContextOptions = {}) {
  const page = await harness.newPage(options);
  // Install before any viewer code reads Date.now(), including in opaque frames.
  // Keep rendering/timers real; only the ticket clock advances explicitly.
  await page.clock.setFixedTime(epoch);
  await browserStep("navigate to fixture and load viewer frame", () => page.goto(harness.origin));
  return page;
}

async function renew(page: Page, frame: Frame, round: number, minutes = round * 6) {
  now = epoch + minutes * 60_000;
  await browserStep(`renew ticket ${round} and apply its prefix`, async () => {
    await page.clock.setFixedTime(now);
    await frame.evaluate(() => window.dispatchEvent(new Event("focus")));
    await frame.waitForFunction(expected => document.baseURI.includes(expected), `/view/renewed-${round}/`);
  });
}

beforeAll(async () => {
  const bundle = await bundleBrowserAsset("src/viewer/entry.ts");
  await harness.start((request, response) => {
    void (async () => {
      const url = new URL(request.url!, harness.origin);
      const send = (status: number, type: string, body: string) => {
        requests.push({ path: url.pathname, status });
        response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "null" });
        response.end(body);
      };
      if (url.pathname === "/private-viewer.js") return send(200, "text/javascript; charset=utf-8", bundle);
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
        if (asset === heldAsset && match[1] !== "initial") {
          const status = await new Promise<number>(release => heldSheets.push({ path: url.pathname, release }));
          if (status !== 200) return send(status, "text/plain", "replacement failed");
        }
        if (asset === "swap.css") return send(200, "text/css", '@import "nested/swap.css"; #probe, #cascade { color: rgb(0, 128, 0) }');
        if (asset === "nested/swap.css") return send(200, "text/css", '#nested-probe { color: rgb(128, 0, 128) }');
        if (asset === "site.css") return send(200, "text/css", '@import "nested/theme.css"; #linked { background-image: url(linked.svg) }');
        if (asset === "nested/theme.css") return send(200, "text/css", '#nested { background-image: url(../nested.svg) }');
        if (asset === "import.css") return send(200, "text/css", '#imported { background-image: url(imported.svg) }');
        if (asset.endsWith(".svg")) return send(200, "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>');
      }
      send(404, "text/plain", "missing");
    })().catch(error => { response.destroy(error as Error); });
  });
});

beforeEach(() => {
  now = epoch;
  serial = 0;
  tickets.clear();
  tickets.set("initial", epoch + ttl);
  requests.length = 0;
  heldAsset = "";
  heldSheets.length = 0;
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
    const page = await openViewer();
    try {
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      // Parent sees a true opaque-origin postMessage, not a same-origin DOM mock.
      await page.evaluate(() => {
        window.addEventListener("message", event => {
          if (event.data?.type === "viewer-renew") document.body.dataset.frameOrigin = event.origin;
        });
      });
      for (let round = 1; round <= 3; round++) {
        await renew(page, frame, round);
        await browserStep(`load linked and imported styles for ticket ${round}`, () => frame.waitForFunction(expected =>
          [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every(link => link.sheet !== null)
          && ["linked", "nested", "imported"].every(id => getComputedStyle(document.getElementById(id)!).backgroundImage.includes(expected)),
        `/view/renewed-${round}/`));
        await expect.poll(() => requests.some(request => request.path.includes(`/view/renewed-${round}/`)
          && request.path.endsWith("/nested/theme.css") && request.status === 200), { message: `serve nested sheet for ticket ${round}` }).toBe(true);
      }
      expect(await page.locator("body").getAttribute("data-frame-origin")).toBe("null");
      expect(requests.filter(request => request.path.endsWith(".svg"))).toEqual([]);
      // Server-side fake clock enforces TTL: the original capability now fails.
      const expired = await page.request.get(`${harness.origin}${prefix("initial")}guide/assets/probe.svg`);
      expect(expired.status()).toBe(404);
      requests.length = 0;
      await frame.locator("#hidden").evaluate(element => { (element as HTMLElement).style.display = "block"; });
      await expect.poll(() => requests.filter(request => request.path.endsWith(".svg") && request.status === 200).length, { message: "load all five images after expiry" }).toBe(5);
      for (const resource of ["inline(escaped).svg", "block.svg", "linked.svg", "nested.svg", "imported.svg"]) {
        expect(requests.some(request => decodeURIComponent(request.path) === `${prefix("renewed-3")}guide/assets/${resource}`
          && request.status === 200), resource).toBe(true);
      }
      expect(requests.some(request => request.path.includes("/view/initial/"))).toBe(false);
      expect(await frame.locator("textarea").inputValue()).toBe("Comment draft");
    } finally { await page.close(); }
  });

  it("keeps the same document, its scroll position, focus and an unsent draft through every renewal", async () => {
    publisherHtml = `<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body>
      <img id="picture" src="assets/picture.svg"><div style="height:3000px"></div>
      <textarea id="draft" aria-label="Draft"></textarea><div style="height:1500px"></div></body></html>`;
    const page = await openViewer();
    try {
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      await browserStep("settle the document", () => frame.waitForFunction(() =>
        (document.getElementById("picture") as HTMLImageElement).naturalWidth === 10));
      await frame.evaluate(() => {
        const draft = document.getElementById("draft") as HTMLTextAreaElement;
        draft.scrollIntoView({ block: "center" });
        draft.focus();
        draft.value = "A comment I have not sent yet";
        draft.setSelectionRange(2, 9);
        Object.assign(window, { identity: { origin: performance.timeOrigin, node: draft, scrollY: window.scrollY } });
      });
      const documentLoads = () => requests.filter(request => request.path === `${base}/files/guide/index.html`).length;
      expect(documentLoads()).toBe(1);
      for (let round = 1; round <= 3; round++) {
        await renew(page, frame, round);
        await browserStep(`apply ticket ${round} to the picture`, () => frame.waitForFunction(expected =>
          (document.getElementById("picture") as HTMLImageElement).src.includes(expected), `/view/renewed-${round}/`));
        expect(await frame.evaluate(() => {
          const kept = (window as unknown as { identity: { origin: number; node: Element; scrollY: number } }).identity;
          const draft = document.getElementById("draft") as HTMLTextAreaElement;
          return {
            sameDocument: performance.timeOrigin === kept.origin, sameNode: draft === kept.node, scrollY: window.scrollY === kept.scrollY && kept.scrollY > 0,
            value: draft.value, selection: [draft.selectionStart, draft.selectionEnd], focused: document.activeElement === draft,
          };
        }), `after renewal ${round}`).toEqual({ sameDocument: true, sameNode: true, scrollY: true, value: "A comment I have not sent yet", selection: [2, 9], focused: true });
        expect(documentLoads()).toBe(1);
      }
    } finally { await page.close(); }
  });

  it.each([
    ["inline image-set", '<div id="target" style=\'background-image:image-set("assets/candidate.svg" 1x, "assets/double.svg" 2x)\'></div>', "candidate.svg"],
    ["block image-set", '<style>#target { background-image:image-set("assets/candidate.svg" 1x, "assets/double.svg" 2x) }</style><div id="target"></div>', "candidate.svg"],
    ["inline -webkit-image-set", '<div id="target" style=\'background-image:-webkit-image-set("assets/candidate.svg" 1x)\'></div>', "candidate.svg"],
    ["block -webkit-image-set", '<style>#target { background-image:-webkit-image-set("assets/candidate.svg" 1x) }</style><div id="target"></div>', "candidate.svg"],
    ["string @import only", '<style>@import "assets/import.css";</style><div id="imported"></div>', "imported.svg"],
  ])("renews isolated %s before its first image use after expiry", async (_name, markup, asset) => {
    // No other resource URL in the style block can trigger a reparsing and hide
    // a missed candidate/import rewrite. Layout rules live in a separate block.
    publisherHtml = `<!doctype html><style>#hidden div { width:10px; height:10px }</style>
      <div id="hidden" style="display:none">${markup}</div>`;
    const page = await openViewer({ deviceScaleFactor: 1 });
    try {
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      // Force CSS resolution without fetching the hidden image, reproducing a
      // document whose styles were inspected before its deferred first paint.
      expect(await frame.evaluate(() => getComputedStyle(document.querySelector("#target, #imported")!).backgroundImage))
        .toContain("/view/initial/");
      for (let round = 1; round <= 3; round++) {
        await renew(page, frame, round);
        if (asset === "imported.svg") {
          await expect.poll(() => requests.some(request => request.path === `${prefix(`renewed-${round}`)}guide/assets/import.css`
            && request.status === 200), { message: `serve imported sheet for ticket ${round}` }).toBe(true);
          await browserStep(`apply imported sheet for ticket ${round}`, () => frame.waitForFunction(expected =>
            getComputedStyle(document.getElementById("imported")!).backgroundImage.includes(expected), `/view/renewed-${round}/`));
        }
      }
      expect(requests.filter(request => request.path.endsWith(".svg"))).toEqual([]);
      expect((await page.request.get(`${harness.origin}${prefix("initial")}guide/assets/probe.svg`)).status()).toBe(404);
      requests.length = 0;
      await frame.locator("#hidden").evaluate(element => { (element as HTMLElement).style.display = "block"; });
      await expect.poll(() => requests.some(request => request.path === `${prefix("renewed-3")}guide/assets/${asset}`
        && request.status === 200), { message: `load ${asset} with the renewed ticket after expiry` }).toBe(true);
      expect(requests.some(request => request.path.includes("/view/initial/") || request.status !== 200)).toBe(false);
    } finally { await page.close(); }
  });

  it.each([
    ["link", "swap.css"], ["link", "nested/swap.css"],
    ["style", "swap.css"], ["style", "nested/swap.css"],
  ])("retains the %s cascade through delayed, overlapping and failed %s replacement", async (kind, asset) => {
    heldAsset = asset;
    publisherHtml = `<!doctype html><head>
      <style>#probe, #cascade, #nested-probe { color: rgb(255, 0, 0) }</style>
      ${kind === "link"
        ? '<link rel="stylesheet" href="assets/swap.css" media="screen" nonce="publisher-nonce" data-publisher="preserved" crossorigin="anonymous">'
        : '<style media="screen" nonce="publisher-nonce" data-publisher="preserved" crossorigin="anonymous">@import "assets/swap.css";</style>'}
      <style>#cascade { color: rgb(0, 0, 255) }</style>
      </head><body><p id="probe">Sheet</p><p id="cascade">Cascade order</p><p id="nested-probe">Nested sheet</p></body>`;
    const page = await openViewer();
    try {
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      await browserStep("apply initial nested stylesheet", () => frame.waitForFunction(() =>
        getComputedStyle(document.getElementById("nested-probe")!).color === "rgb(128, 0, 128)"));
      await frame.evaluate(() => {
        const samples = { count: 0, wrong: [] as string[], maxSheets: 0 };
        Object.assign(window, { sheetSamples: samples });
        const sample = () => {
          const colors = ["probe", "cascade", "nested-probe"].map(id => getComputedStyle(document.getElementById(id)!).color);
          if (colors.join(";") !== "rgb(0, 128, 0);rgb(0, 0, 255);rgb(128, 0, 128)") samples.wrong.push(colors.join(";"));
          samples.count++;
          samples.maxSheets = Math.max(samples.maxSheets, document.querySelectorAll("[data-publisher]").length);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const sampleFrames = () => browserStep("sample cascade across 12 rendered frames", () => frame.evaluate(() => new Promise<void>(resolve => {
        let count = 0;
        const tick = () => { if (++count === 12) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      })));
      await renew(page, frame, 1, 6);
      await expect.poll(() => heldSheets.length, { message: "receive held stylesheet request 1" }).toBe(1);
      await sampleFrames();
      expect(await frame.evaluate(() => (window as unknown as { sheetSamples: { wrong: string[] } }).sheetSamples.wrong)).toEqual([]);
      expect(await frame.locator("[data-publisher]").count()).toBe(2);
      expect(await frame.locator("[data-publisher]").nth(1).getAttribute("media")).toBe("screen");
      expect(await frame.locator("[data-publisher]").nth(1).getAttribute("data-publisher")).toBe("preserved");
      expect(await frame.locator("[data-publisher]").nth(1).getAttribute("crossorigin")).toBe("anonymous");
      expect(await frame.locator("[data-publisher]").nth(1).evaluate(el => (el as HTMLElement).nonce)).toBe("publisher-nonce");
      expect(await frame.locator("head").evaluate(el => [...el.querySelectorAll("style,link")].map(sheet => sheet.tagName)))
        .toEqual(["STYLE", kind.toUpperCase(), kind.toUpperCase(), "STYLE"]);
      // A second renewal while the first replacement is loading must coalesce.
      await renew(page, frame, 2, 12);
      await sampleFrames();
      expect(heldSheets).toHaveLength(1);
      expect(await frame.locator("[data-publisher]").count()).toBe(2);
      heldSheets[0].release(200);
      await expect.poll(() => heldSheets.length, { message: "receive held stylesheet request 2" }).toBe(2);
      expect(heldSheets[1].path).toContain("/view/renewed-2/");
      await sampleFrames();
      heldSheets[1].release(200);
      await browserStep("commit stylesheet replacement 2", () => frame.waitForFunction(() => document.querySelectorAll("[data-publisher]").length === 1
        && (document.querySelector("[data-publisher]")!.getAttribute("href") ?? document.querySelector("[data-publisher]")!.textContent!).includes("/view/renewed-2/")));
      await renew(page, frame, 3, 18);
      await expect.poll(() => heldSheets.length, { message: "receive held stylesheet request 3" }).toBe(3);
      await sampleFrames();
      heldSheets[2].release(200);
      await browserStep("commit stylesheet replacement 3", () => frame.waitForFunction(() => document.querySelectorAll("[data-publisher]").length === 1
        && (document.querySelector("[data-publisher]")!.getAttribute("href") ?? document.querySelector("[data-publisher]")!.textContent!).includes("/view/renewed-3/")));
      // Chromium reports load on <style> when only a nested import fails.
      // Exercise error retention on its direct import; linked sheets also
      // propagate nested failures. Both variants above delay nested imports.
      if (kind === "style") heldAsset = "swap.css";
      // A failed refresh keeps both parent and imported rules active.
      await renew(page, frame, 4, 24);
      await expect.poll(() => heldSheets.length, { message: "receive held stylesheet request 4" }).toBe(4);
      await sampleFrames();
      heldSheets[3].release(503);
      await browserStep("discard failed stylesheet replacement", () => frame.waitForFunction(() =>
        document.querySelectorAll("[data-publisher]").length === 1));
      expect(await frame.locator("[data-publisher]").evaluate(el => el.getAttribute("href") ?? el.textContent)).toContain("/view/renewed-3/");
      await sampleFrames();
      heldAsset = asset;
      await renew(page, frame, 5, 30);
      await expect.poll(() => heldSheets.length, { message: "receive held stylesheet request 5" }).toBe(5);
      expect(heldSheets[4].path).toContain("/view/renewed-5/");
      heldSheets[4].release(200);
      await browserStep("commit stylesheet replacement 5", () => frame.waitForFunction(() => document.querySelectorAll("[data-publisher]").length === 1
        && (document.querySelector("[data-publisher]")!.getAttribute("href") ?? document.querySelector("[data-publisher]")!.textContent!).includes("/view/renewed-5/")));
      await sampleFrames();
      const samples = await frame.evaluate(() => (window as unknown as {
        sheetSamples: { count: number; wrong: string[]; maxSheets: number };
      }).sheetSamples);
      expect(samples.count).toBeGreaterThan(60);
      expect(samples.wrong).toEqual([]);
      expect(samples.maxSheets).toBe(2);
      expect(await frame.locator("head").evaluate(el => [...el.querySelectorAll("style,link")].map(sheet => sheet.tagName)))
        .toEqual(["STYLE", kind.toUpperCase(), "STYLE"]);
    } finally {
      for (const pending of heldSheets) pending.release(200);
      await page.close();
    }
  });


  it("updates a block without imports synchronously without replacing its element or losing rules", async () => {
    publisherHtml = `<!doctype html><head><style id="plain">
      #probe { color: rgb(0, 128, 0); background-image: url(assets/plain.svg) }
      </style></head><body><p id="probe">Plain block</p></body>`;
    const page = await openViewer();
    try {
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      await frame.evaluate(() => {
        const original = document.getElementById("plain");
        const samples = { count: 0, wrong: 0 };
        Object.assign(window, { plainSamples: samples });
        const sample = () => {
          samples.count++;
          if (document.getElementById("plain") !== original
            || getComputedStyle(document.getElementById("probe")!).color !== "rgb(0, 128, 0)") samples.wrong++;
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      for (let round = 1; round <= 3; round++) {
        await renew(page, frame, round);
        await browserStep(`rewrite plain stylesheet for ticket ${round}`, () => frame.waitForFunction(expected =>
          document.getElementById("plain")!.textContent!.includes(expected), `/view/renewed-${round}/`));
        await browserStep("sample plain stylesheet across 12 rendered frames", () => frame.evaluate(() => new Promise<void>(resolve => {
          let count = 0;
          const tick = () => { if (++count === 12) resolve(); else requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        })));
      }
      const samples = await frame.evaluate(() => (window as unknown as { plainSamples: { count: number; wrong: number } }).plainSamples);
      expect(samples.count).toBeGreaterThanOrEqual(36);
      expect(samples.wrong).toBe(0);
    } finally { await page.close(); }
  });

  it.each(viewerHtmlForms)("loads the first stylesheet with an %s document", async (_name, source) => {
    now = epoch;
    publisherHtml = source;
    requests.length = 0;
    const page = await openViewer();
    try {
      expect(requests.some(request => request.path === `${prefix("initial")}guide/assets/site.css` && request.status === 200)).toBe(true);
      expect(requests.some(request => request.path === `${base}/files/guide/assets/site.css`)).toBe(false);
    } finally { await page.close(); }
  });
});
