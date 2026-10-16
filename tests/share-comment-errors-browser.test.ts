import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { beforeAll, expect, it } from "vitest";
import type { Page } from "playwright";
import { renderScopedDocumentShell } from "../src/routes/app";
import { bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
const base = "/organizations/org-a/projects/project-a/docs";
beforeAll(async () => {
  const assets = new Map([
    ["/commentor.js", await bundleBrowserAsset("src/commentor/commentor.ts")],
    ["/fixture.js", await bundleBrowserAsset("tests/fixtures/comment-quota-browser.ts")],
  ]);
  const app = new Hono();
  app.get(base, c => c.html(renderScopedDocumentShell({ user: null, namespace: "org-a/project-a", title: "Docs", basePath: base,
    selectedPath: "index.html", shareConfig: { organizationId: "org-a", projectId: "project-a" },
  }).replace('src="about:blank"', `src="${base}/files/index.html"`).replace('style="display:none"', 'style="display:block"').replace(/<script[^>]*src="\/lazy-tree.js[^>]*><\/script>/, `<script>window.RENDRO_CURRENT_DOC="org-a/project-a/index.html"</script><script src="/fixture.js"></script>`)));
  app.get(`${base}/files/index.html`, c => c.html(`<!doctype html><html><body><p id="target">Comment target</p>
    <script>window.COMMENTOR={transport:"parent",organizationId:"org-a",projectId:"project-a",documentPath:"index.html",canWrite:true}</script>
    <script src="/commentor.js"></script></body></html>`));
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((req, res) => { void listener(req, res).catch(error => res.destroy(error as Error)); }, assets);
});
async function open(width = 1024, dark = false) {
  const page = await harness.newPage({ viewport: { width, height: 800 }, colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
  await page.route(url => ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.tailwindcss.com"].includes(url.hostname), route => route.fulfill({ body: "" }));
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} } }); });
  await page.goto(harness.origin + base);
  return page;
}
async function failure(page: Page, kind: string) {
  await page.evaluate(kind => { (window as unknown as { commentFixture: { failure: string } }).commentFixture.failure = kind; }, kind);
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as { commentFixture: { calls: unknown[] } }).commentFixture.calls);
}

it.each([{ width: 320, dark: false }, { width: 1024, dark: true }])("share complexity and generic errors persist, dismiss and retry ($width, dark=$dark)", async ({ width, dark }) => {
  const page = await open(width, dark);
  let status = 400;
  await page.route("**/api/rendro/shares", route => route.fulfill({ status, json: status === 400 ? { error: "document too complex to share", code: "share_limit", reason: "assets" } : { error: "private trace" } }));
  await page.locator("#share-btn").click();
  const notice = page.locator("#share-error");
  await expect.poll(() => notice.innerText()).toContain("This document references too many assets to share");
  // The live region is a persistent sibling of the notice, and the notice follows the toolbar in DOM order.
  const live = page.locator("#share-live");
  expect(await live.getAttribute("aria-live")).toBe("polite");
  expect(await live.evaluate(el => !el.closest("#share-error"))).toBe(true);
  expect(await live.textContent()).toContain("references too many assets");
  expect(await notice.evaluate(el => Boolean(document.querySelector("header.topbar")!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  expect(await page.locator("#share-retry").isVisible()).toBe(false);
  await page.clock.install({ time: new Date("2025-12-31T23:59:59Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"));
  await page.clock.fastForward(30_000);
  expect(await notice.isVisible()).toBe(true);
  const rect = await notice.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
  await page.locator("#share-dismiss").click();
  expect(await notice.isVisible()).toBe(false);
  expect(await page.locator("#share-btn").evaluate(el => el === document.activeElement)).toBe(true);
  status = 500;
  await page.locator("#share-btn").click();
  await expect.poll(() => notice.innerText()).toContain("The share link could not be created");
  expect(await notice.innerText()).not.toContain("private trace");
  await page.route("**/api/rendro/shares", route => route.fulfill({ json: { url: "/s/fixture" } }));
  await page.locator("#share-retry").click();
  await expect.poll(() => page.locator("#share-btn").getAttribute("aria-label")).toBe("Share link copied!");
  expect(await notice.isVisible()).toBe(false);
  await page.clock.fastForward(1800);
  expect(await page.locator("#share-btn").getAttribute("aria-label")).toBe("Share document");
});

it.each([
  [{ code: "share_limit", reason: "assets" }, "references too many assets", false],
  [{ code: "share_limit", reason: "tags" }, "too large or complex", false],
  [{ code: "share_limit", reason: "attributes" }, "too large or complex", false],
  [{ code: "share_limit", reason: "source_size" }, "too large or complex", false],
  [{ code: "share_limit", reason: "<b>unknown</b>" }, "too large or complex", false],
  [{}, "too large or complex", false],
  [{ code: "share_busy", reason: "deadline" }, "taking longer than expected", true],
  [{ code: "share_unavailable", reason: "unavailable" }, "is unavailable", false],
])("share failure %j shows stable wording without server text (retry=%s)", async (body, wording, retryable) => {
  const page = await open();
  let attempts = 0;
  await page.route("**/api/rendro/shares", route => {
    attempts++;
    // An empty body models a Worker that predates the stable code.
    const json = "code" in body ? { error: "private server text", ...body } : { error: "document too complex to share" };
    return attempts === 1 ? route.fulfill({ status: 400, json }) : route.fulfill({ json: { url: "/s/fixture" } });
  });
  await page.locator("#share-btn").click();
  const notice = page.locator("#share-error");
  await expect.poll(() => notice.innerText()).toContain(wording);
  expect(await notice.innerText()).not.toContain("private server text");
  expect(await page.locator("#share-live").textContent()).toContain(wording);
  expect(await page.locator("#share-retry").isVisible()).toBe(retryable);
  if (retryable) {
    await page.locator("#share-retry").click();
    await expect.poll(() => page.locator("#share-btn").getAttribute("aria-label")).toBe("Share link copied!");
    expect(attempts).toBe(2);
  }
});

it("a 400 without a recognized failure is the generic retryable error", async () => {
  const page = await open();
  await page.route("**/api/rendro/shares", route => route.fulfill({ status: 400, json: { error: "private server text", code: "surprise" } }));
  await page.locator("#share-btn").click();
  await expect.poll(() => page.locator("#share-error").innerText()).toContain("The share link could not be created");
  expect(await page.locator("#share-retry").isVisible()).toBe(true);
  expect(await page.locator("#share-error").innerText()).not.toContain("private server text");
});

it("Escape dismisses the share notice and returns focus to the toolbar action", async () => {
  const page = await open();
  await page.route("**/api/rendro/shares", route => route.fulfill({ status: 500, json: { error: "private trace" } }));
  await page.locator("#share-btn").click();
  const notice = page.locator("#share-error");
  await expect.poll(() => notice.isVisible()).toBe(true);
  await page.locator("#share-retry").focus();
  await page.keyboard.press("Escape");
  expect(await notice.isVisible()).toBe(false);
  expect(await page.locator("#share-btn").evaluate(el => el === document.activeElement)).toBe(true);
  // Escape elsewhere in the page must leave a visible notice alone.
  await page.locator("#share-btn").click();
  await expect.poll(() => notice.isVisible()).toBe(true);
  await page.locator("#theme-toggle").focus();
  await page.keyboard.press("Escape");
  expect(await notice.isVisible()).toBe(true);
});

it("share failures belong to their document, but the account quota keeps counting", async () => {
  const page = await open();
  let status = 500;
  await page.route("**/api/rendro/shares", route => route.fulfill(status === 429
    ? { status, headers: { "Retry-After": "30" }, body: "not JSON" } : { status, json: { error: "private trace" } }));
  const change = () => page.evaluate(() => {
    (window as unknown as { RENDRO_CURRENT_DOC: string }).RENDRO_CURRENT_DOC = "org-a/project-a/other.html";
    window.dispatchEvent(new Event("rendro:document-change"));
  });
  const notice = page.locator("#share-error");
  await page.locator("#share-btn").click();
  await expect.poll(() => notice.isVisible()).toBe(true);
  await change();
  expect(await notice.isVisible()).toBe(false);
  expect(await page.locator("#share-live").textContent()).toBe("");
  status = 429;
  await page.locator("#share-btn").click();
  await expect.poll(() => notice.innerText()).toContain("Too many shares right now");
  await change();
  expect(await notice.isVisible()).toBe(true);
  expect(await page.locator("#share-count").innerText()).toMatch(/^\d+$/);
  // A failure arriving after the reader moved on is dropped, and the toolbar action recovers.
  await page.unroute("**/api/rendro/shares");
  await page.reload();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/rendro/shares", async route => { await gate; await route.fulfill({ status: 500, json: { error: "late" } }); });
  await page.locator("#share-btn").click();
  await expect.poll(() => page.locator("#share-btn").getAttribute("aria-busy")).toBe("true");
  await change();
  release();
  await expect.poll(() => page.locator("#share-btn").getAttribute("aria-busy")).toBeNull();
  expect(await page.locator("#share-btn").getAttribute("aria-label")).toBe("Share document");
  expect(await notice.isVisible()).toBe(false);
});

it.each(["3", "date", "invalid"])("share quota honors Retry-After %s and permits an explicit retry", async value => {
  const page = await open();
  await page.clock.install({ time: new Date("2025-12-31T23:59:59Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"));
  let count = 0;
  await page.route("**/api/rendro/shares", route => {
    count++;
    return route.fulfill(count === 1 ? { status: 429, headers: { "Retry-After": value === "date" ? "Thu, 01 Jan 2026 00:00:03 GMT" : value }, body: "not JSON" } : { json: { url: "/s/fixture" } });
  });
  await page.evaluate(() => {
    const live = document.getElementById("share-live")!;
    const writes: string[] = [];
    (window as unknown as { liveWrites: string[] }).liveWrites = writes;
    new MutationObserver(() => writes.push(live.textContent!.trim())).observe(live, { childList: true, characterData: true, subtree: true });
  });
  await page.locator("#share-btn").click();
  await expect.poll(() => page.locator("#share-error").innerText()).toContain("Too many shares right now");
  const liveWrites = () => page.evaluate(() => (window as unknown as { liveWrites: string[] }).liveWrites.filter(Boolean));
  if (value !== "invalid") {
    expect(await page.locator("#share-retry").isDisabled()).toBe(true);
    expect(await page.locator("#share-error-message").innerText()).toContain("3 seconds");
    expect(await page.locator("#share-count").innerText()).toBe("3");
    expect(await liveWrites()).toEqual(["Too many shares right now; try again in 3 seconds."]);
    await page.locator("#share-dismiss").click();
    // aria-disabled keeps the focused toolbar action reachable, but no duplicate write is allowed.
    await page.locator("#share-btn").dispatchEvent("click");
    expect(count).toBe(1);
    expect(await page.locator("#share-error").isVisible()).toBe(true);
    await page.clock.fastForward(1000);
    expect(await page.locator("#share-error-message").innerText()).toContain("2 seconds");
    expect(await page.locator("#share-count").innerText()).toBe("2");
    await page.clock.fastForward(1000);
    expect(await page.locator("#share-error-message").innerText()).toContain("1 second.");
    await page.clock.fastForward(1000);
    expect(await page.locator("#share-error-message").innerText()).toContain("You can share again now.");
    // Per-second changes stay out of the live region: one announcement at the start and one at the end.
    expect(await liveWrites()).toEqual(["Too many shares right now; try again in 3 seconds.", "You can share again now."]);
  } else {
    expect(await liveWrites()).toEqual(["Too many shares right now; please try again later."]);
  }
  expect(await page.locator("#share-retry").isEnabled()).toBe(true);
  expect(count).toBe(1);
  await page.locator("#share-retry").click();
  await expect.poll(() => page.locator("#share-btn").getAttribute("aria-label")).toBe("Share link copied!");
  expect(count).toBe(2);
});

it("an oversized Retry-After is capped to the timer limit rather than dropped", async () => {
  const page = await open();
  await page.route("**/api/rendro/shares", route => route.fulfill({ status: 429, headers: { "Retry-After": "99999999999" }, body: "" }));
  await page.locator("#share-btn").click();
  await expect.poll(() => page.locator("#share-count").innerText()).toBe("2147484");
  expect(await page.locator("#share-retry").isDisabled()).toBe(true);
});

it("clipboard failure stays readable and retries successfully", async () => {
  const page = await open();
  await page.route("**/api/rendro/shares", route => route.fulfill({ json: { url: "/s/fixture" } }));
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error("denied")); document.execCommand = () => false; });
  await page.locator("#share-btn").click();
  await expect.poll(() => page.locator("#share-error-message").innerText()).toContain("The link could not be copied");
  await page.evaluate(() => { navigator.clipboard.writeText = async () => {}; });
  await page.locator("#share-retry").click();
  await expect.poll(() => page.locator("#share-btn").getAttribute("aria-label")).toBe("Share link copied!");
});

it.each(["create", "reply"])("comment %s quota crosses the real bridge, retains the draft, counts down and retries", async action => {
  const page = await open(375, true);
  const frame = page.frameLocator("#content-frame");
  await frame.getByTestId("commentor-panel-btn").click();
  if (action === "create") {
    await frame.getByTestId("commentor-comment-btn").click();
    await frame.locator("#target").click();
  }
  const input = frame.getByTestId(action === "create" ? "commentor-composer-textarea" : "commentor-reply-input");
  const submit = frame.getByTestId(action === "create" ? "commentor-composer-post" : "commentor-reply-send");
  await input.fill("Retained draft");
  await frame.locator("body").evaluate(() => {
    const live = document.querySelector("#commentor-host")!.shadowRoot!.querySelector(".quota-live")!;
    const writes: string[] = [];
    (window as unknown as { liveWrites: string[] }).liveWrites = writes;
    new MutationObserver(() => writes.push(live.textContent!.trim())).observe(live, { childList: true, characterData: true, subtree: true });
  });
  await page.clock.install({ time: new Date("2025-12-31T23:59:59Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"));
  await submit.click();
  const status = frame.locator('.quota-live');
  const visible = frame.locator('.comment-quota');
  await expect.poll(() => status.textContent()).toContain("3 seconds");
  expect(await status.getAttribute("aria-live")).toBe("polite");
  expect(await status.evaluate(el => !el.closest(".comment-quota"))).toBe(true);
  expect(await visible.isVisible()).toBe(true);
  expect(await visible.locator('[aria-hidden="true"]').count()).toBe(1);
  const noticeBounds = await visible.boundingBox();
  expect(noticeBounds!.x).toBeGreaterThanOrEqual(0);
  expect(noticeBounds!.x + noticeBounds!.width).toBeLessThanOrEqual(375);
  expect(await submit.isDisabled()).toBe(true);
  expect(await input.inputValue()).toBe("Retained draft");
  expect(await input.isEditable()).toBe(true);
  await input.press("Enter");
  expect(await calls(page)).toHaveLength(1);
  // Dismissal returns focus to the draft, and Enter during the cooldown explains the wait again.
  await frame.locator(".comment-quota button").click();
  expect(await visible.isVisible()).toBe(false);
  expect(await input.evaluate(el => (el.getRootNode() as ShadowRoot).activeElement === el)).toBe(true);
  await input.press("Enter");
  expect(await visible.isVisible()).toBe(true);
  expect(await calls(page)).toHaveLength(1);
  // The visible countdown ticks while the live region keeps its single start announcement.
  await page.clock.fastForward(1000);
  expect(await visible.textContent()).toContain("2 seconds");
  expect(await status.textContent()).toContain("3 seconds");
  await page.evaluate(() => (window as unknown as { commentFixture: { refresh(): void } }).commentFixture.refresh());
  expect(await submit.isDisabled()).toBe(true);
  await page.clock.fastForward(1100);
  await expect.poll(() => submit.isEnabled()).toBe(true);
  expect(await status.textContent()).toContain("You can post comments again now.");
  expect(await visible.textContent()).toContain("You can post comments again now.");
  expect(await calls(page)).toHaveLength(1);
  // One announcement when the delay starts and one when it ends, never per second.
  expect(await frame.locator("body").evaluate(() => (window as unknown as { liveWrites: string[] }).liveWrites.filter(Boolean)))
    .toEqual(["Too many comments right now; try again in 3 seconds.", "You can post comments again now."]);
  await input.fill("Edited after quota");
  await failure(page, "success");
  await submit.click();
  await expect.poll(() => calls(page).then(c => c.length)).toBe(2);
  if (action === "create") await expect.poll(() => frame.locator('.composer[data-state="open"]').count()).toBe(0);
  else await expect.poll(() => input.inputValue()).toBe("");
  expect(await frame.locator('.comment-quota').count()).toBe(0);
});

it.each(["create", "reply"])("comment %s generic failure keeps the draft and allows retry", async action => {
  const page = await open();
  await failure(page, "generic");
  const frame = page.frameLocator("#content-frame");
  await frame.getByTestId("commentor-panel-btn").click();
  if (action === "create") { await frame.getByTestId("commentor-comment-btn").click(); await frame.locator("#target").click(); }
  const input = frame.getByTestId(action === "create" ? "commentor-composer-textarea" : "commentor-reply-input");
  const submit = frame.getByTestId(action === "create" ? "commentor-composer-post" : "commentor-reply-send");
  await input.fill("Retry unchanged");
  await submit.click();
  await expect.poll(() => frame.locator('.toast[role="alert"]').textContent()).toContain(action === "create" ? "Could not post comment" : "Could not post reply");
  expect(await submit.isEnabled()).toBe(true);
  expect(await input.inputValue()).toBe("Retry unchanged");
  await failure(page, "success");
  await submit.click();
  await expect.poll(() => calls(page).then(c => c.length)).toBe(2);
  const attempts = await calls(page) as { clientOperationId: string }[];
  expect(attempts[1].clientOperationId).toBe(attempts[0].clientOperationId);
});

it("a generic failure while a reply cooldown is active keeps the create button disabled", async () => {
  const page = await open(1024);
  const frame = page.frameLocator("#content-frame");
  await frame.getByTestId("commentor-panel-btn").click();
  await frame.getByTestId("commentor-comment-btn").click();
  await frame.locator("#target").click();
  const composer = frame.getByTestId("commentor-composer-textarea");
  const post = frame.getByTestId("commentor-composer-post");
  await composer.fill("New thread");
  await page.evaluate(() => { (window as unknown as { commentFixture: { hold: boolean } }).commentFixture.hold = true; });
  await post.click();
  await expect.poll(() => calls(page).then(c => c.length)).toBe(1);
  // While the create is pending, a reply is rate limited and starts the shared cooldown.
  await failure(page, "quota");
  const reply = frame.getByTestId("commentor-reply-input");
  await reply.fill("A reply");
  await frame.getByTestId("commentor-reply-send").click();
  await expect.poll(() => frame.locator(".comment-quota").count()).toBe(1);
  await page.evaluate(() => (window as unknown as { commentFixture: { release(): void } }).commentFixture.release());
  await expect.poll(() => frame.locator('.toast[role="alert"]').textContent()).toContain("Could not post comment");
  expect(await composer.inputValue()).toBe("New thread");
  expect(await post.isDisabled()).toBe(true);
});
