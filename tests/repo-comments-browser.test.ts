import type { ServerResponse } from "node:http";
import type { Frame, Page } from "playwright";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RENDERER_VERSION } from "@/ingest/limits";
import { manifestKey } from "@/ingest/orchestrator/keys";
import worker from "@/worker";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";
import { publicRepo, repoReadFixture } from "./helpers/repo-read-fixture";

/*
 * Comments on repository docs in Chromium (#254). The document frame is the real Worker's, with its real policy
 * (scripts and styles by source and hash, nothing else), and loads the real widget bundle. The parent is a minimal
 * stand-in speaking the parent protocol: it says who may write and hands the widget threads, so the test controls
 * exactly which anchors arrive. Anchors are made by selecting text, then fed back on the same blob, on a changed blob
 * with the context intact, and in the ways that must orphan: no silent jump to other text.
 */
const harness = createBrowserHarness();
const BLOB = "c".repeat(40);
const OTHER_BLOB = "d".repeat(40);
const PAGE = "docs/guide.md";
let fixture: Awaited<ReturnType<typeof repoReadFixture>>;
let assets: Map<string, string>;

const html = [
  `<h1 id="user-content-guide">Guide</h1>`,
  `<p id="intro">Before you start, read this.</p>`,
  `<h2 id="user-content-install">Install</h2>`,
  `<p id="install">Run <code>pnpm install</code> first. Later, run pnpm install again to be sure.</p>`,
  `<h2>🚀</h2>`,
  `<p id="unnamed">Under a heading without an id.</p>`,
  `<h2 id="user-content-usage">Usage</h2>`,
  `<p id="usage">Call the API.</p>`,
].join("\n");

async function send(response: ServerResponse, reply: Response) {
  const headers = Object.fromEntries(reply.headers);
  response.writeHead(reply.status, headers);
  response.end(Buffer.from(await reply.arrayBuffer()));
}

/** Adds the guide page (known blob, known headings) to the public repository's snapshot. */
async function addGuide(commit: string) {
  const render = `render/v${RENDERER_VERSION}/markdown/${BLOB}/${"e".repeat(32)}`;
  await fixture.bucket.put(`gh/v1/repo/${publicRepo.id}/${render}`, new TextEncoder().encode(JSON.stringify({ title: "Guide", headings: [], html })));
  const key = manifestKey(publicRepo.id, commit, RENDERER_VERSION);
  const manifest = fixture.bucket.json<{ files: Record<string, unknown> }>(key) as { files: Record<string, unknown> };
  manifest.files[PAGE] = { sha: BLOB, size: 1, render, title: "Guide" };
  await fixture.bucket.put(key, new TextEncoder().encode(JSON.stringify(manifest)));
}

const parent = `<!doctype html><meta charset="utf-8">
<iframe name="content-frame" id="content-frame" sandbox="allow-scripts allow-popups" width="900" height="560"></iframe>
<script>
const frame = document.getElementById("content-frame");
window.calls = []; window.threads = []; window.canWrite = window.canWrite === true;
const post = message => frame.contentWindow.postMessage(message, "*");
window.ready = (canWrite, generation = "g1") => post({ type: "commentor-parent-ready", protocolVersion: 2, parentGeneration: generation, canReloadViewer: true,
  userId: canWrite ? "user-a" : null, canWrite, recoveryState: { operations: {}, drafts: {} } });
window.publish = threads => { window.threads = threads; post({ type: "commentor-parent-update", threads, canLoadMore: false, loading: false }); };
addEventListener("message", event => {
  const data = event.data;
  if (event.source !== frame.contentWindow || !data || data.type !== "commentor-parent-request") return;
  window.calls.push(data);
  post({ type: "commentor-parent-response", requestId: data.requestId, ok: true });
  if (data.method === "subscribe") post({ type: "commentor-parent-update", threads: window.threads, canLoadMore: false, loading: false });
});
frame.addEventListener("load", () => window.ready(window.canWrite));
frame.src = new URLSearchParams(location.search).get("frame");
</script>`;

beforeAll(async () => {
  assets = new Map([["/commentor.js", await bundleBrowserAsset("src/commentor/commentor.ts")]]);
  await harness.start((request, response) => {
    const url = new URL(request.url ?? "/", harness.origin);
    if (url.pathname === "/viewer") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(parent);
      return;
    }
    if (url.pathname === "/bare") {
      // A widget page that is not a repository frame: its configuration and markup come from the query.
      const config = url.searchParams.get("config") ?? "";
      const body = url.searchParams.get("article") === "1" ? `<article class="markdown-body"><p id="text">Bare text here.</p></article>` : `<p id="text">Bare text here.</p>`;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><body>${body}<script src="/commentor.js" data-commentor-config="${config.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></script></body>`);
      return;
    }
    void Promise.resolve(worker.request(url.href, {}, fixture.env, fixture.ctx)).then(reply => send(response, reply));
  }, assets);
});

beforeEach(async () => {
  fixture = await repoReadFixture();
  await addGuide(fixture.commits.public);
});

type Opened = { page: Page; frame: Frame };

async function open(canWrite: boolean, path = `/r/${publicRepo.owner}/${publicRepo.name}/@${fixture.commits.public}/files/${PAGE}`): Promise<Opened> {
  const page = await harness.newPage();
  await page.addInitScript(() => {
    const store = window as unknown as { violations: string[] };
    store.violations = [];
    document.addEventListener("securitypolicyviolation", event => store.violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
  });
  await page.addInitScript(value => { (window as unknown as { canWrite: boolean }).canWrite = value; }, canWrite);
  await browserStep("open the guide", () => page.goto(`${harness.origin}/viewer?frame=${encodeURIComponent(path)}`, { waitUntil: "load" }));
  const frame = () => page.frames().find(candidate => candidate.name() === "content-frame" && candidate.url() !== "about:blank" && candidate.url() !== "");
  await expect.poll(() => frame()?.evaluate(() => Boolean(document.getElementById("commentor-host"))) ?? false).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { calls: Array<{ method: string }> }).calls.some(call => call.method === "subscribe"))).toBe(true);
  return { page, frame: frame()! };
}

/** Select [start, end) of an element's text inside the frame, as a reader would. */
async function select(frame: Frame, id: string, text: string, occurrence = 0) {
  await frame.evaluate(({ id, text, occurrence }) => {
    const element = document.getElementById(id)!;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      for (let index = node.data.indexOf(text); index !== -1; index = node.data.indexOf(text, index + 1)) {
        if (seen++ !== occurrence) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
    }
    throw new Error(`No occurrence ${occurrence} of ${text}`);
  }, { id, text, occurrence });
}

/** Comment on a selection through the widget; returns the anchor it sent to the parent. */
async function comment(opened: Opened, id: string, text: string, occurrence = 0): Promise<Record<string, unknown>> {
  // An open (or closing) bubble holds the selection chip back, as for any reader.
  await expect.poll(() => opened.frame.getByTestId("commentor-composer").count()).toBe(0);
  const before = await opened.page.evaluate(() => (window as unknown as { calls: Array<{ method: string }> }).calls.filter(call => call.method === "thread.create").length);
  await select(opened.frame, id, text, occurrence);
  const chip = opened.frame.getByTestId("commentor-selection-action");
  await expect.poll(() => chip.getAttribute("data-state")).toBe("open");
  await chip.click();
  await opened.frame.getByTestId("commentor-composer-textarea").fill(`About ${text}`);
  await opened.frame.getByTestId("commentor-composer-post").click();
  await expect.poll(() => opened.page.evaluate(() => (window as unknown as { calls: Array<{ method: string }> }).calls.filter(call => call.method === "thread.create").length)).toBe(before + 1);
  const create = await opened.page.evaluate(() => (window as unknown as { calls: Array<{ method: string; args: { anchor: Record<string, unknown> } }> }).calls.filter(call => call.method === "thread.create").at(-1)!);
  return create.args.anchor;
}

function thread(id: string, anchor: Record<string, unknown>) {
  return { _id: id, _creationTime: 1, authorEmail: "", authorName: "Reader", body: `Thread ${id}`, anchor, resolved: false, archived: false, replies: [], canDelete: false };
}

/** Where pins sit, and the quote's own rectangle for one occurrence. */
async function pins(opened: Opened) {
  return opened.frame.evaluate(() => [...document.getElementById("commentor-host")!.shadowRoot!.querySelectorAll<HTMLElement>(".pin")]
    .filter(pin => getComputedStyle(pin).display !== "none" && !pin.classList.contains("orphan"))
    .map(pin => ({ top: pin.getBoundingClientRect().top })));
}

async function quoteTop(opened: Opened, id: string, text: string, occurrence: number) {
  return opened.frame.evaluate(({ id, text, occurrence }) => {
    const element = document.getElementById(id)!;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      for (let index = node.data.indexOf(text); index !== -1; index = node.data.indexOf(text, index + 1)) {
        if (seen++ !== occurrence) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        return range.getBoundingClientRect().top;
      }
    }
    return Number.NaN;
  }, { id, text, occurrence });
}

async function orphans(opened: Opened) {
  await opened.frame.getByTestId("commentor-panel-btn").click();
  return opened.frame.locator(".is-orphan").count();
}

describe("comments in a repository document frame", () => {
  it("runs the widget under the frame's own policy, read-only until the parent grants writing", async () => {
    const opened = await open(false);
    expect(await opened.frame.getByTestId("commentor-comment-btn").isDisabled()).toBe(true);
    await select(opened.frame, "install", "first");
    await opened.frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await opened.frame.getByTestId("commentor-selection-action").getAttribute("data-state")).toBe("closed");
    await opened.page.evaluate(() => (window as unknown as { ready: (canWrite: boolean, generation: string) => void }).ready(true, "g2"));
    await expect.poll(() => opened.frame.getByTestId("commentor-comment-btn").isDisabled()).toBe(false);
    // The shadow stylesheet is allowed by hash: nothing was blocked, and the widget is styled.
    expect(await opened.frame.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([]);
    expect(await opened.frame.evaluate(() => getComputedStyle(document.getElementById("commentor-host")!.shadowRoot!.querySelector(".dock")!).position)).toBe("fixed");
    // The widget never connects anywhere: only the parent sees its requests.
    expect(await opened.page.evaluate(() => (window as unknown as { calls: Array<{ method: string; args: { documentPath?: string } }> }).calls[0])).toMatchObject({ method: "subscribe", args: { documentPath: PAGE } });
  });

  it("anchors a selection by heading, quote, context, offset and blob", async () => {
    const opened = await open(true);
    const anchor = await comment(opened, "install", "pnpm install", 1);
    expect(anchor).toEqual({
      kind: "repo-text", blobSha: BLOB, headingSlug: "install", exact: "pnpm install",
      offset: expect.any(Number), prefix: expect.stringMatching(/first\. Later, run $/), suffix: expect.stringMatching(/^ again to be sure\./),
    });
    // Before the first heading's id-less sibling: a heading without an id belongs to the section before it.
    expect(await comment(opened, "unnamed", "without an id")).toMatchObject({ headingSlug: "install" });
    expect(await comment(opened, "intro", "read this")).toMatchObject({ headingSlug: "guide", prefix: expect.stringContaining("Before you start, ") });
    // Text with no box on screen offers no chip.
    await opened.frame.evaluate(() => { document.getElementById("intro")!.style.fontSize = "0"; });
    await select(opened.frame, "intro", "read this");
    await opened.frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await opened.frame.getByTestId("commentor-selection-action").getAttribute("data-state")).toBe("closed");
    // A selection across a heading has no single section: no chip.
    await opened.frame.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.getElementById("intro")!.firstChild!, 0);
      range.setEnd(document.getElementById("install")!.lastChild!, 3);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await opened.frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await opened.frame.getByTestId("commentor-selection-action").getAttribute("data-state")).toBe("closed");
  });

  it("pins each anchor on its own text: exact on the same blob, re-found on a changed one, never moved to other text", async () => {
    const opened = await open(true);
    const second = await comment(opened, "install", "pnpm install", 1);
    const secondTop = await quoteTop(opened, "install", "pnpm install", 1);
    const publish = (threads: unknown[]) => opened.page.evaluate(value => (window as unknown as { publish: (threads: unknown[]) => void }).publish(value), threads);

    // Same blob: the offset picks the second of two identical quotes.
    await publish([thread("same", second)]);
    await expect.poll(async () => (await pins(opened)).length).toBe(1);
    expect(Math.abs((await pins(opened))[0].top - secondTop)).toBeLessThan(40);

    // A later commit changed the page (another blob) but kept this passage: found again by its context.
    await publish([thread("moved", { ...second, blobSha: OTHER_BLOB, offset: 0 })]);
    await expect.poll(async () => (await pins(opened)).length).toBe(1);
    expect(Math.abs((await pins(opened))[0].top - secondTop)).toBeLessThan(40);
    // A forged offset on the same blob is checked against the text, then searched like a changed page.
    await publish([thread("forged", { ...second, offset: 999 })]);
    await expect.poll(async () => (await pins(opened)).length).toBe(1);
    expect(Math.abs((await pins(opened))[0].top - secondTop)).toBeLessThan(40);

    // Orphans: the context no longer singles out one of two occurrences; the text is gone; the heading is gone.
    await publish([
      thread("ambiguous", { ...second, blobSha: OTHER_BLOB, prefix: "changed ", suffix: " changed" }),
      thread("deleted", { ...second, blobSha: OTHER_BLOB, exact: "npm ci", prefix: "", suffix: "" }),
      thread("heading", { ...second, headingSlug: "removed-section" }),
    ]);
    await expect.poll(async () => (await pins(opened)).length).toBe(0);
    expect(await orphans(opened)).toBe(3);
    // A quote that occurs once in its section is found even when its surroundings changed.
    const usage = await comment(opened, "usage", "Call the API");
    await publish([thread("unique", { ...usage, blobSha: OTHER_BLOB, prefix: "different", suffix: "context" })]);
    await expect.poll(async () => (await pins(opened)).length).toBe(1);

    await publish([
      thread("ambiguous", { ...second, blobSha: OTHER_BLOB, prefix: "changed ", suffix: " changed" }),
    ]);
    await expect.poll(() => opened.frame.locator(".is-orphan").count()).toBe(1);
    // Locating an orphan says so instead of scrolling anywhere.
    await opened.frame.locator('.is-orphan [aria-label="Locate commented text on page"]').first().click();
    await expect.poll(() => opened.frame.locator('.toast[role="alert"]').last().innerText()).toBe("This comment’s anchor is no longer available.");
    // A blank quote is never shown as one.
    await publish([thread("blank", { ...second, exact: "   " })]);
    // Wait for the blank thread itself: the drawer briefly still shows the previous (ambiguous) thread, which has a
    // Locate control, and a count of one would match it too.
    await expect.poll(() => opened.frame.locator('.drawer-thread[data-thread-id="blank"]').count()).toBe(1);
    await expect.poll(() => opened.frame.locator('.drawer-thread [aria-label="Locate commented text on page"]').count()).toBe(0);
    // A found anchor is located on the page.
    await publish([thread("found", second)]);
    const alerts = await opened.frame.locator('.toast[role="alert"]').count();
    await opened.frame.locator('[data-thread-id="found"] [aria-label="Locate commented text on page"]').click();
    await opened.frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await opened.frame.locator('.toast[role="alert"]').count()).toBeLessThanOrEqual(alerts);
  });

  it("anchors a clicked element by its text, and refuses one without text", async () => {
    const opened = await open(true);
    await opened.frame.getByTestId("commentor-comment-btn").click();
    await opened.frame.locator("#usage").click();
    await opened.frame.getByTestId("commentor-composer-textarea").fill("On the paragraph");
    await opened.frame.getByTestId("commentor-composer-post").click();
    await expect.poll(() => opened.page.evaluate(() => (window as unknown as { calls: Array<{ method: string; args: { anchor?: unknown } }> }).calls.find(call => call.method === "thread.create")?.args.anchor))
      .toMatchObject({ kind: "repo-text", headingSlug: "usage", exact: "Call the API." });
    await opened.frame.evaluate(() => {
      const image = Object.assign(document.createElement("img"), { width: 40, height: 20, alt: "" });
      document.getElementById("usage")!.replaceChildren(image);
    });
    await opened.frame.getByTestId("commentor-comment-btn").click();
    await expect.poll(() => opened.frame.getByTestId("commentor-composer").count()).toBe(0);
    await opened.frame.locator("#usage img").click();
    await expect.poll(() => opened.frame.locator(".toast").last().innerText()).toBe("Select some text to comment on.");
  });
});

describe("the widget's configuration attribute", () => {
  const repo = { transport: "parent", repoId: publicRepo.id, documentPath: PAGE, blobSha: BLOB };
  const bare = (config: string, article = false) => open(true, `/bare?article=${article ? 1 : 0}&config=${encodeURIComponent(config)}`);
  const started = (opened: Opened) => opened.frame.evaluate(() => Boolean(document.getElementById("commentor-host")));

  it("refuses to start on an unreadable or non-object configuration", async () => {
    for (const config of ["{not json", "1"]) {
      const page = await harness.newPage();
      const errors: string[] = [];
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await browserStep("open a bare page", () => page.goto(`${harness.origin}/viewer?frame=${encodeURIComponent(`/bare?config=${encodeURIComponent(config)}`)}`, { waitUntil: "load" }));
      await expect.poll(() => errors.some(text => text.includes("[commentor] not started"))).toBe(true);
      const frame = page.frames().find(candidate => candidate.name() === "content-frame")!;
      expect(await frame.evaluate(() => Boolean(document.getElementById("commentor-host")))).toBe(false);
    }
  });

  it("anchors in the page body when a repository page has no article", async () => {
    const opened = await bare(JSON.stringify(repo));
    expect(await started(opened)).toBe(true);
    expect(await comment(opened, "text", "Bare text")).toMatchObject({ kind: "repo-text", headingSlug: "", exact: "Bare text", offset: 0 });
  });

  it("orphans a repository anchor that reaches a widget outside a repository frame", async () => {
    const opened = await bare(JSON.stringify({ transport: "parent", organizationId: "org", projectId: "project", documentPath: PAGE }), true);
    await opened.page.evaluate(value => (window as unknown as { publish: (threads: unknown[]) => void }).publish(value),
      [thread("stray", { kind: "repo-text", blobSha: BLOB, headingSlug: "", prefix: "", exact: "Bare text", suffix: "", offset: 0 })]);
    await opened.frame.getByTestId("commentor-panel-btn").click();
    await expect.poll(() => opened.frame.locator(".is-orphan").count()).toBe(1);
    await opened.frame.locator('.is-orphan [aria-label="Locate commented text on page"]').click();
    await expect.poll(() => opened.frame.locator('.toast[role="alert"]').last().innerText()).toBe("This comment’s anchor is no longer available.");
  });
});
