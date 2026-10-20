import type { Page } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import type { RepoCommentLab } from "./fixtures/repo-comment-lab-browser";
import { bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

/*
 * Comment latency on /r/ (#284) in Chromium: the real repository host, access renewal, transport and widget, with
 * Convex and the Worker's access endpoint modelled with latency (tests/fixtures/repo-comment-lab-browser.ts). The
 * first comments come with the first access answer and the live page takes over; the reader's own comment shows at
 * once. The last test measures both, in main's boot order before this change and in this one.
 */
const harness = createBrowserHarness();
const FRAME_DELAY_MS = 150;
const BLOB = "c".repeat(40);
const config = (documentPath: string) => JSON.stringify({ transport: "parent", repoId: 9001, documentPath, blobSha: BLOB }).replaceAll('"', "&quot;");
const documentHtml = (documentPath: string) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/24px sans-serif}main{padding:24px;width:520px}</style></head>
<body><main><h1 id="title">Guide</h1><p id="intro">Install the tools first, then run the build.</p></main>
<script defer src="/commentor.js" data-commentor-config="${config(documentPath)}"></script></body></html>`;

beforeAll(async () => {
  const assets = new Map([
    ["/commentor.js", await bundleBrowserAsset("src/commentor/commentor.ts")],
    ["/lab.js", await bundleBrowserAsset("tests/fixtures/repo-comment-lab-browser.ts")],
  ]);
  await harness.start((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("Cache-Control", "no-store");
    const page = /^\/r\/octo\/docs\/files\/(guide|other)\.md$/.exec(url.pathname);
    if (page) {
      // A frame takes a while to arrive too (the Worker, its caches): comments are measured from its load.
      setTimeout(() => {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(documentHtml(`${page[1]}.md`));
      }, FRAME_DELAY_MS);
    } else if (url.pathname === "/r/octo/docs") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body style="margin:0"><iframe id="content-frame" sandbox="allow-scripts" src="/r/octo/docs/files/guide.md" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe><script src="/lab.js"></script></body></html>`);
    } else {
      response.writeHead(404).end();
    }
  }, assets);
});

type Seed = { threads: Array<Record<string, unknown>>; snapshot?: Array<Record<string, unknown>> };

/** Every distinct set of pins the frame showed, with when it first showed it. */
function recordPins() {
  const seen: Array<{ at: number; pins: string[] }> = [];
  Object.assign(window, { seenPins: seen });
  const tick = () => {
    const pins = [...document.getElementById("commentor-host")?.shadowRoot?.querySelectorAll<HTMLElement>(".pin") ?? []]
      .map(pin => `${pin.classList.contains("is-sending") ? "sending:" : ""}${pin.dataset.tip}`);
    if (JSON.stringify(pins) !== JSON.stringify(seen.at(-1)?.pins ?? [])) seen.push({ at: Date.now(), pins });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Each frame reports every comment toast it shows to the shell, so a page that is being left is heard too. */
function reportToasts() {
  const seen = new Set<Element>();
  const tick = () => {
    for (const toast of document.getElementById("commentor-host")?.shadowRoot?.querySelectorAll(".toast") ?? []) {
      if (seen.has(toast)) continue;
      seen.add(toast);
      window.parent.postMessage({ type: "lab-toast", text: toast.textContent }, "*");
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** With `?holdSubscribes`, the shell holds the widgets' subscribe requests until `releaseSubscribes()`, as a slow frame or a busy shell delays them. */
function holdSubscribes() {
  const held: Array<{ data: unknown; source: MessageEventSource | null }> = [];
  const state = Object.assign(window, { holdingSubscribes: new URLSearchParams(location.search).has("holdSubscribes"), heldSubscribes: held, releaseSubscribes() {
    state.holdingSubscribes = false;
    for (const { data, source } of held.splice(0)) dispatchEvent(new MessageEvent("message", { data, source }));
  } });
  addEventListener("message", event => {
    const data = event.data as { type?: unknown; method?: unknown } | null;
    if (!state.holdingSubscribes || data?.type !== "commentor-parent-request" || data.method !== "subscribe") return;
    event.stopImmediatePropagation();
    held.push({ data: event.data, source: event.source });
  });
}

async function open(seed: Seed, params: Record<string, string> = {}): Promise<Page> {
  const page = await harness.newPage({ viewport: { width: 1024, height: 700 }, reducedMotion: "reduce" });
  await page.addInitScript(value => { if (window === window.top) Object.assign(window, { labSeed: value }); }, seed);
  await page.addInitScript(`if (window !== window.top) { (${recordPins.toString()})(); (${reportToasts.toString()})(); } else (${holdSubscribes.toString()})()`);
  await page.goto(`${harness.origin}/r/octo/docs?${new URLSearchParams(params)}`);
  return page;
}

const frame = (page: Page) => page.frames().find(candidate => candidate !== page.mainFrame())!;
const seenPins = (page: Page) => frame(page).evaluate(() => (window as unknown as { seenPins: Array<{ at: number; pins: string[] }> }).seenPins);
const lab = <T>(page: Page, read: (lab: RepoCommentLab) => T) => page.evaluate(`(${read.toString()})(window.lab)`) as Promise<T>;

describe("first comments without waiting on the socket (#284)", () => {
  it("shows the snapshot, then the live page replaces it: a deleted thread goes, an edited one changes, a new one arrives", async () => {
    const page = await open({
      snapshot: [{ _id: "a", body: "Deleted since" }, { _id: "b", body: "Before the edit" }],
      threads: [{ _id: "b", body: "After the edit" }, { _id: "c", body: "Arrived since" }],
    // A slow socket, so the frame has surely loaded (and shown the snapshot) before the live page arrives.
    }, { socket: "2500" });
    await expect.poll(async () => (await seenPins(page)).at(-1)?.pins).toEqual(["Ada: After the edit", "Ada: Arrived since"]);
    const states = (await seenPins(page)).map(state => state.pins);
    // The snapshot first, then the live page: never a mix of the two, never the empty pre-grant page in between.
    expect(states.slice(states.findIndex(pins => pins.length > 0))).toEqual([
      ["Ada: Deleted since", "Ada: Before the edit"], ["Ada: After the edit", "Ada: Arrived since"],
    ]);
  });

  it("shows a reader the read path denies nothing, and lets them write nothing", async () => {
    const page = await open({ threads: [{ _id: "a", body: "Not for this reader" }] }, { access: "denied" });
    await expect.poll(() => frame(page).locator('[data-testid="commentor-dock"]').count()).toBe(1);
    await expect.poll(() => lab(page, l => l.subscribers.length)).toBe(1);
    await page.waitForTimeout(1_000);
    expect((await seenPins(page)).flatMap(state => state.pins)).toEqual([]);
    expect(await frame(page).locator('[data-testid="commentor-comment-btn"]').isDisabled()).toBe(true);
  });
});

describe("switching pages while the first page's comments are still loading (#284)", () => {
  it("drops the left page's late subscription and its held first answer silently, and shows the current page's threads", async () => {
    const page = await open({ threads: [{ _id: "g", path: "guide.md", body: "On the guide" }, { _id: "o", path: "other.md", body: "On the other page" }] }, { holdAccess: "1", holdSubscribes: "1" });
    // The guide's widget has asked for its comments; the request is still on its way, and so is the first access answer.
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldSubscribes: unknown[] }).heldSubscribes.length)).toBeGreaterThan(0);
    await expect.poll(() => lab(page, l => l.answer !== null)).toBe(true);
    // The reader moves on, as the sidebar does it; the guide's request reaches the shell only after that.
    await page.evaluate(() => {
      (document.getElementById("content-frame") as HTMLIFrameElement).src = "/r/octo/docs/files/other.md";
      (window as unknown as { releaseSubscribes(): void }).releaseSubscribes();
    });
    await expect.poll(() => frame(page).url()).toContain("/files/other.md");
    await expect.poll(() => frame(page).locator('[data-testid="commentor-dock"]').count()).toBe(1);
    // Now the first answer arrives, with the guide's snapshot: it is not this page's, so it is never shown.
    await page.evaluate(() => (window as unknown as { lab: RepoCommentLab }).lab.answer!());
    await expect.poll(async () => (await seenPins(page)).at(-1)?.pins).toEqual(["Ada: On the other page"]);
    expect((await seenPins(page)).flatMap(state => state.pins)).not.toContain("Ada: On the guide");
    await page.waitForTimeout(300);
    expect(await lab(page, l => l.toasts)).toEqual([]);
  });
});

describe("the reader's own comment on a repository page (#284)", () => {
  it("takes a failed post back and explains it, without a composer, once the read path no longer lets the reader write", async () => {
    const page = await open({ threads: [] });
    const ui = frame(page);
    await expect.poll(() => ui.locator('[data-testid="commentor-comment-btn"]').isDisabled()).toBe(false);
    await page.evaluate(() => { (window as unknown as { lab: RepoCommentLab }).lab.holdWrites = true; });
    await ui.locator('[data-testid="commentor-comment-btn"]').click();
    await ui.locator("#intro").click();
    await ui.locator('[data-testid="commentor-composer-textarea"]').fill("Too late");
    await ui.locator('[data-testid="commentor-composer-post"]').click();
    await expect.poll(() => ui.locator(".pin.is-sending").count()).toBe(1);
    await expect.poll(() => lab(page, l => l.release !== null)).toBe(true);
    // Access ends while the write is on its way (a renewal said 404), then the write fails.
    await page.evaluate(() => (window as unknown as { lab: { host: { setWritable(value: boolean): void } } }).lab.host.setWritable(false));
    await expect.poll(() => ui.locator('[data-testid="commentor-comment-btn"]').isDisabled()).toBe(true);
    await page.evaluate(() => (window as unknown as { lab: RepoCommentLab }).lab.release!(true));
    await expect.poll(() => ui.locator('.toast[role="alert"]').innerText()).toBe("Could not post comment. Try again.");
    await expect.poll(() => ui.locator(".pin").count()).toBe(0);
    // No composer comes back with the draft: the reader may no longer write here.
    expect(await ui.locator('[data-testid="commentor-composer"][data-state="open"]').count()).toBe(0);
    await expect.poll(() => ui.locator('[data-testid="commentor-composer"]').count()).toBe(0);
  });
});

describe("measured: comments visible after the frame loads, and the reader's own comment (#284)", () => {
  async function measure(mode: "before" | "after") {
    const page = await open({ threads: [{ _id: "a", body: "Existing comment" }] }, { mode });
    await expect.poll(async () => (await seenPins(page)).some(state => state.pins.includes("Ada: Existing comment"))).toBe(true);
    const frameLoaded = await lab(page, l => l.frameLoadedAt);
    const visible = (await seenPins(page)).find(state => state.pins.includes("Ada: Existing comment"))!.at;
    const boot = await lab(page, l => l.boot);
    // The reader's own comment: from the Post click to its pin (optimistic), and to the server's echo.
    const ui = frame(page);
    await expect.poll(() => ui.locator('[data-testid="commentor-comment-btn"]').isDisabled()).toBe(false);
    await ui.locator('[data-testid="commentor-comment-btn"]').click();
    await ui.locator("#intro").click();
    await ui.locator('[data-testid="commentor-composer-textarea"]').fill("My comment");
    const clicked = await ui.locator('[data-testid="commentor-composer-post"]').evaluate(button => { (button as HTMLButtonElement).click(); return Date.now(); });
    await expect.poll(async () => (await seenPins(page)).at(-1)?.pins).toContain("Me: My comment");
    const states = (await seenPins(page)).filter(state => state.at >= clicked);
    const shown = states.find(state => state.pins.some(pin => pin.endsWith("My comment")))!.at;
    const echoed = states.find(state => state.pins.includes("Me: My comment"))!.at;
    // The shell's timeline carries both for real-user monitoring (#282): this page's first comments, and the save.
    // The save is marked on the write's acknowledgement, which may come after the live page already showed the thread.
    const marks = () => page.evaluate(() => ["rendro:comments", "rendro:comment-echo"].map(name =>
      performance.getEntriesByName(name).map(entry => ((entry as PerformanceMeasure).detail as { kind: string }).kind)));
    await expect.poll(marks).toEqual([["cold"], ["cold"]]);
    await page.context().close();
    return {
      frameLoaded: frameLoaded - boot, commentsAfterBoot: visible - boot, commentsAfterFrameLoad: visible - frameLoaded,
      ownCommentShown: shown - clicked, ownCommentEchoed: echoed - clicked,
    };
  }

  it("reports when comments show after the frame loads, and when the reader's own comment shows", async () => {
    const before = await measure("before");
    const after = await measure("after");
    // Before #284 the reader first saw their own comment with the echo; now the optimistic pin comes first.
    console.log(`[#284 latency] ${JSON.stringify({ before, after })}`);
    // The comment timings depend on when the frame loads on this host, so they are reported, not asserted. What
    // holds on any host: the reader's own pin shows before the echo, which still takes a Convex round trip.
    for (const value of Object.values({ ...before, ...after })) expect(value).toBeGreaterThanOrEqual(0);
    expect(after.ownCommentShown).toBeLessThan(after.ownCommentEchoed);
  });
});
