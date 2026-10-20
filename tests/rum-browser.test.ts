import type { IncomingMessage, ServerResponse } from "node:http";
import type { Page } from "playwright";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "@/worker";
import { isRumEvent, RUM_MAX_EVENTS, type RumEvent } from "@/rum/schema";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";
import { publicRepo, repoReadFixture } from "./helpers/repo-read-fixture";
import { SqliteSearchD1 } from "./helpers/search-sqlite";
import { d1SearchIndex } from "@/search/d1";

/*
 * Real-user monitoring in Chromium (#282): the real Worker serves a public
 * repository shell, its frames, tree pages and POST /rum, with the beacon
 * dataset faked. Every beacon the page sends is captured as the server
 * received it, then answered by the real endpoint. The back/forward cache stays
 * enabled (Playwright disables it by default) so a restore is a real one.
 */
const harness = createBrowserHarness({ ignoreDefaultArgs: ["--disable-back-forward-cache"] });
let fixture: Awaited<ReturnType<typeof repoReadFixture>>;
let search: SqliteSearchD1;
interface Beacon { fetchSite: string | undefined; status: number; body: string }
const beacons: Beacon[] = [];
const points: unknown[] = [];
const shell = `/r/${publicRepo.owner}/${publicRepo.name}`;

async function send(response: ServerResponse, reply: Response) {
  const headers = new Headers(reply.headers);
  response.writeHead(reply.status, Object.entries(Object.fromEntries(headers)).flat());
  response.end(Buffer.from(await reply.arrayBuffer()));
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  const assets = new Map([
    ["/lazy-tree.js", await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts")],
    ["/rum.js", await bundleBrowserAsset("src/rum/client.ts")],
    ["/private-viewer.js", await bundleBrowserAsset("src/viewer/entry.ts")],
  ]);
  await harness.start((request, response) => {
    const url = new URL(request.url ?? "/", harness.origin);
    const headers = new Headers(Object.entries(request.headers).flatMap(([name, value]) => typeof value === "string" ? [[name, value] as [string, string]] : []));
    void body(request).then(async bytes => {
      const env = {
        ...fixture.env, REPO_SEARCH: search,
        RUM_ANALYTICS: { writeDataPoint: (point: unknown) => void points.push(point) },
        RUM_LIMIT: { limit: () => Promise.resolve({ success: true }) },
      };
      const reply = await worker.request(url.href, { method: request.method, headers, body: bytes.length ? new Uint8Array(bytes) : undefined }, env, fixture.ctx);
      if (url.pathname === "/rum") beacons.push({ fetchSite: request.headers["sec-fetch-site"] as string | undefined, status: reply.status, body: bytes.toString("utf8") });
      await send(response, reply);
    });
  }, assets);
});

beforeEach(async () => {
  beacons.length = 0;
  points.length = 0;
  // The endpoint's same-origin check compares against the site the browser is on.
  process.env.SITE_URL = harness.origin;
  fixture = await repoReadFixture();
  // An empty index: a search answers 200 with no results, which the shell reads (an unread body records no timing).
  search = new SqliteSearchD1();
  await d1SearchIndex(search).migrate();
});

async function open(path = shell, init?: string): Promise<Page> {
  const page = await harness.newPage({ viewport: { width: 1100, height: 700 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  Object.assign(page, { errors });
  if (init) await page.addInitScript(init);
  await browserStep(`open ${path}`, () => page.goto(`${harness.origin}${path}`, { waitUntil: "load" }));
  return page;
}
const pageErrors = (page: Page) => (page as Page & { errors: string[] }).errors;

const navigations = (page: Page) => page.evaluate(() => performance.getEntriesByName("rendro:navigation").length);
async function navigated(page: Page, count: number) {
  await page.waitForFunction(n => performance.getEntriesByName("rendro:navigation").length >= n, count);
}

/**
 * Leaves the shell, as a reader following a link elsewhere would; the page hides and sends what it gathered
 * (nothing, when an earlier hide already sent everything: `expectBeacon` false).
 */
async function leave(page: Page, expectBeacon = true) {
  const before = beacons.length;
  await browserStep("leave the shell", () => page.goto(`${harness.origin}/__browser_health`));
  if (expectBeacon) await expect.poll(() => beacons.length).toBeGreaterThan(before);
}

/**
 * Hides the page in place, as switching tabs would: what was gathered is sent,
 * and the reader stays on the shell. The document's own visibilityState is
 * shadowed for the duration, then restored.
 */
async function hide(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    Reflect.deleteProperty(document, "visibilityState");
  });
}

function events(from = 0): RumEvent[] {
  return beacons.slice(from).flatMap(beacon => (JSON.parse(beacon.body) as { events: RumEvent[] }).events);
}

function expectAccepted() {
  for (const beacon of beacons) {
    expect(beacon.status).toBe(204);
    expect(beacon.fetchSite).toBe("same-origin");
    const payload = JSON.parse(beacon.body) as { v: number; events: unknown[] };
    expect(Object.keys(payload)).toEqual(["v", "events"]);
    expect(payload.events.length).toBeLessThanOrEqual(RUM_MAX_EVENTS);
    expect(payload.events.every(isRumEvent)).toBe(true);
    // Nothing that names the repository, its commit or a path ever leaves the page.
    expect(beacon.body).not.toMatch(/octo|public-docs|docs\/|\/r\/|[0-9a-f]{40}|http/i);
  }
  expect(points).toHaveLength(events().length);
}

const link = (page: Page, path: string) => page.locator(`a.tree-link[href$="/files/${path}"]`);
/** A click with no hover first, so nothing was preloaded. */
async function clickUnwarmed(page: Page, path: string) {
  await link(page, path).waitFor();
  await page.evaluate(target => (document.querySelector(`a.tree-link[href$="/files/${target}"]`) as HTMLElement).click(), path);
}

describe("real-user monitoring beacons", () => {
  it("report a cold load: the shell's vitals and Server-Timing, the first document and the tree, naming nothing", async () => {
    const page = await open();
    await navigated(page, 1);
    await leave(page);
    expectAccepted();
    const sent = events();
    for (const metric of ["TTFB", "FCP", "LCP", "CLS", "server"]) {
      expect(sent).toContainEqual(expect.objectContaining({ route: "shell", metric, nav: "cold", tier: "r2" }));
    }
    for (const metric of ["swap", "load", "switch"]) {
      expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric, nav: "cold", preloaded: false, tier: "r2" }));
    }
    // The frame's own response, which only the frame can read.
    expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric: "response", nav: "cold", tier: "r2" }));
    expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric: "server", nav: "cold", tier: "r2" }));
    expect(sent).toContainEqual(expect.objectContaining({ route: "tree", metric: "server", nav: "cold" }));
    const swap = sent.find(event => event.metric === "swap") as RumEvent, load = sent.find(event => event.metric === "load") as RumEvent;
    const paint = sent.find(event => event.metric === "switch") as RumEvent;
    expect(swap.value).toBeLessThanOrEqual(load.value);
    expect(load.value).toBeLessThanOrEqual(paint.value);
    // One leave, one beacon: pagehide on a visible page leaves the sending to visibilitychange.
    expect(beacons).toHaveLength(1);
    expect(pageErrors(page)).toEqual([]);
  });

  it("report in-shell switches with and without the preloaded frame, flushing a full queue early", async () => {
    const page = await open();
    await navigated(page, 1);
    // Warm the next document by hovering it, then open it: the preloaded sibling is revealed.
    await link(page, "docs/huge.md").hover();
    await page.waitForFunction(() => document.querySelector("iframe[data-preload][data-state='ready']") !== null);
    await link(page, "docs/huge.md").click();
    await navigated(page, 2);
    await clickUnwarmed(page, "docs/index.md");
    await navigated(page, 3);
    // Search answers through the same read path; its response is reported too.
    await page.locator("#repo-search-input").fill("start");
    await expect.poll(() => page.evaluate(() => performance.getEntriesByType("resource").some(entry => entry.name.includes("/search?")))).toBe(true);
    // Enough switches to fill the queue: the page sends a beacon before it is ever hidden.
    for (let count = 4; beacons.length === 0 && count < 12; count += 1) {
      await clickUnwarmed(page, count % 2 ? "docs/huge.md" : "docs/index.md");
      await navigated(page, count);
    }
    await expect.poll(() => beacons.length).toBeGreaterThan(0);
    // Hidden in the background: what was gathered since is sent at once, and a second hide in the same task,
    // with nothing new gathered in between, sends nothing.
    const sentByHides = await page.evaluate(() => {
      const counts: number[] = [];
      let sent = 0;
      const original = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => { sent += 1; return original(url, data); };
      for (let hiding = 0; hiding < 2; hiding += 1) {
        const before = sent;
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
        Reflect.deleteProperty(document, "visibilityState");
        counts.push(sent - before);
      }
      return counts;
    });
    expect(sentByHides[0]).toBeGreaterThan(0);
    expect(sentByHides[1]).toBe(0);
    // A frame demoted to the preload pool drops its load handlers: reusing it never re-measures the first document.
    expect(await page.evaluate(() => performance.getEntriesByName("rendro:navigation")
      .filter(entry => ((entry as PerformanceMeasure).detail as { kind: string }).kind === "cold").length)).toBe(1);
    await leave(page, false);
    expectAccepted();
    const sent = events();
    expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric: "switch", nav: "switch", preloaded: true }));
    expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric: "switch", nav: "switch", preloaded: false }));
    expect(sent).toContainEqual(expect.objectContaining({ route: "search", metric: "response", nav: "cold" }));
    expect(sent).toContainEqual(expect.objectContaining({ route: "shell", metric: "INP", nav: "cold" }));
    // A preloaded switch is a reveal of a document already loaded: its swap is its load.
    const preloaded = sent.filter(event => event.preloaded === true && event.nav === "switch");
    expect(preloaded.find(event => event.metric === "swap")?.value).toBe(preloaded.find(event => event.metric === "load")?.value);
    expect(pageErrors(page)).toEqual([]);
  });

  it("report back/forward: between documents inside the shell, then back to the shell from another page", async () => {
    const page = await open();
    await navigated(page, 1);
    await clickUnwarmed(page, "docs/huge.md");
    await navigated(page, 2);
    await page.evaluate(() => history.back());
    await navigated(page, 3);
    await leave(page);
    expect(events()).toContainEqual(expect.objectContaining({ route: "frame", metric: "switch", nav: "history" }));
    const left = beacons.length;
    // Back to the shell from the page it left. A Chromium with the back/forward cache restores it (the full
    // browser does); one without it (Playwright's headless shell, in CI) loads it again as a back/forward
    // navigation. Each is reported as what it was; the restore's code is also covered by the dispatched
    // pageshow below, which every build runs.
    await browserStep("go back", () => page.goBack({ waitUntil: "commit" }));
    await page.waitForFunction(() => document.getElementById("content-frame") !== null);
    await navigated(page, 1);
    const fromCache = await navigations(page) === 3;
    // The shell reports while the reader is still on it.
    await expect.poll(() => page.evaluate(() => performance.getEntriesByType("paint").length)).toBeGreaterThan(0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))));
    await hide(page);
    await expect.poll(() => beacons.length).toBeGreaterThan(left);
    const back = events(left);
    if (fromCache) {
      expect(back).toContainEqual(expect.objectContaining({ route: "shell", metric: "FCP", nav: "bfcache" }));
      // A restore made no request, so it has no cache tier.
      expect(back.filter(event => event.nav === "bfcache").every(event => event.tier === undefined)).toBe(true);
    } else {
      expect(back).toContainEqual(expect.objectContaining({ route: "shell", metric: "TTFB", nav: "back-forward" }));
      expect(back).toContainEqual(expect.objectContaining({ route: "frame", metric: "switch", nav: "back-forward" }));
    }
    expectAccepted();
  });
});

describe("real-user monitoring of comments (#284)", () => {
  it("reports when a page's first comments arrived and how long the reader's own comment took to save", async () => {
    // The comment host's measures, as src/commentor/parent-host.ts writes them; this bundle only reads the timeline.
    const page = await open();
    await navigated(page, 1);
    await page.evaluate(() => {
      performance.measure("rendro:comments", { start: 0, end: 420, detail: { kind: "cold" } });
      performance.measure("rendro:comment-echo", { start: 500, end: 710, detail: { kind: "cold" } });
      performance.measure("rendro:comments", { start: 900, end: 945, detail: { kind: "switch" } });
      performance.measure("rendro:comment-echo", { start: 1_000, end: 1_200, detail: null });
    });
    await leave(page);
    expectAccepted();
    expect(events().filter(event => event.route === "comments")).toEqual([
      { route: "comments", metric: "ready", value: 420, nav: "cold" },
      { route: "comments", metric: "echo", value: 210, nav: "cold" },
      { route: "comments", metric: "ready", value: 45, nav: "switch" },
      { route: "comments", metric: "echo", value: 200, nav: "switch" },
    ]);
  });

  it("counts a prerendered shell's first comments from its activation", async () => {
    // Activated 100 ms after its navigation started, as the prerender test above fakes it.
    const page = await open(shell, `(() => {
      if (window.parent !== window) return;
      const byType = performance.getEntriesByType.bind(performance);
      performance.getEntriesByType = type => type !== "navigation" ? byType(type)
        : byType(type).map(entry => Object.assign(entry.toJSON(), { activationStart: 100, serverTiming: [] }));
    })();`);
    await navigated(page, 1);
    await page.evaluate(() => performance.measure("rendro:comments", { start: 0, end: 400, detail: { kind: "cold" } }));
    await leave(page);
    expect(events().filter(event => event.route === "comments")).toEqual([{ route: "comments", metric: "ready", value: 300, nav: "prerender" }]);
  });
});

describe("real-user monitoring where the browser tells less", () => {
  it("treats a persisted pageshow as a restore from the back/forward cache", async () => {
    // The coverage profiler does not follow a restored document, and Playwright's headless shell has no
    // back/forward cache, so the same lifecycle event is dispatched here on a shell that never left.
    const page = await open();
    await navigated(page, 1);
    await hide(page);
    await expect.poll(() => beacons.length).toBeGreaterThan(0);
    const before = beacons.length;
    await page.evaluate(() => new Promise(resolve => {
      dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
    }));
    await hide(page);
    await expect.poll(() => beacons.length).toBeGreaterThan(before);
    const restored = events(before);
    expect(restored).toContainEqual(expect.objectContaining({ route: "shell", metric: "FCP", nav: "bfcache" }));
    expect(restored.filter(event => event.nav === "bfcache").every(event => event.tier === undefined)).toBe(true);
    expectAccepted();
    expect(pageErrors(page)).toEqual([]);
  });

  it("counts a prerendered shell from its activation and reports no tier it was not told", async () => {
    // The shell was prerendered, activated 300 ms after its navigation started, and its entry carries no Server-Timing.
    const page = await open(shell, `(() => {
      if (window.parent !== window) return;
      let prerendering = true;
      Object.defineProperty(document, "prerendering", { configurable: true, get: () => prerendering });
      const byType = performance.getEntriesByType.bind(performance);
      performance.getEntriesByType = type => type !== "navigation" ? byType(type)
        : byType(type).map(entry => Object.assign(entry.toJSON(), { activationStart: 300, serverTiming: [] }));
      addEventListener("load", () => setTimeout(() => { prerendering = false; document.dispatchEvent(new Event("prerenderingchange")); }, 50));
    })();`);
    await navigated(page, 1);
    // Collection starts at activation: leave only once the reader has "opened" the prerendered shell.
    await page.waitForFunction(() => !document.prerendering);
    await leave(page);
    expectAccepted();
    const sent = events();
    expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric: "switch", nav: "prerender" }));
    // No Server-Timing total on the shell: no server event for it.
    expect(sent.some(event => event.route === "shell" && event.metric === "server")).toBe(false);
    expect(sent.filter(event => event.route === "shell").every(event => event.tier === undefined)).toBe(true);
    expect(pageErrors(page)).toEqual([]);
  });

  it("waits for a frame's report that arrives after its navigation, and keeps only the newest unused reports", async () => {
    // Every document frame announces itself 400 ms late, after the lazy tree has measured the switch.
    const page = await open(shell, `(() => {
      if (window.parent === window) return;
      const real = window.parent;
      Object.defineProperty(window, "parent", { configurable: true, get: () => ({
        postMessage: (message, target) => setTimeout(() => real.postMessage(message, target), message && message.type === "doc-loaded" ? 400 : 0),
      }) });
    })();`);
    await navigated(page, 1);
    // Reports for documents no navigation asked for: the oldest are let go, and nothing is sent for them.
    const frame = page.frames().find(candidate => candidate.url().includes("/files/"))!;
    await frame.evaluate(() => {
      for (let index = 0; index < 20; index += 1) parent.postMessage({ type: "doc-loaded", timing: { url: "/unused/" + index, tier: "r2", response: 1 } }, "*");
    });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 700)));
    await leave(page);
    expectAccepted();
    const sent = events();
    expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric: "switch", nav: "cold", tier: "r2" }));
    expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric: "response", nav: "cold", tier: "r2" }));
    expect(sent.filter(event => event.route === "frame" && event.metric === "response")).toHaveLength(1);
    expect(pageErrors(page)).toEqual([]);
  });

  it("still reports without navigation timing, frame reports or window.event", async () => {
    // No navigation entries anywhere (shell or frames), and no window.event for the click that switches.
    const page = await open(shell, `(() => {
      const byType = performance.getEntriesByType.bind(performance);
      performance.getEntriesByType = type => type === "navigation" ? [] : byType(type);
      Object.defineProperty(window, "event", { configurable: true, get: () => undefined });
    })();`);
    await navigated(page, 1);
    await clickUnwarmed(page, "docs/huge.md");
    await navigated(page, 2);
    // Hidden in place: the navigations still waiting for a report are sent without one.
    await hide(page);
    await leave(page, false);
    expectAccepted();
    const sent = events();
    expect(sent).toContainEqual(expect.objectContaining({ route: "frame", metric: "switch", nav: "switch", preloaded: false }));
    // A frame that reported nothing has no tier and no response events.
    expect(sent.filter(event => event.route === "frame").every(event => event.tier === undefined)).toBe(true);
    expect(sent.some(event => event.route === "frame" && (event.metric === "response" || event.metric === "server"))).toBe(false);
    expect(pageErrors(page)).toEqual([]);
  });
});
