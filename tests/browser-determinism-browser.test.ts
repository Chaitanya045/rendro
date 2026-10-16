import { beforeAll, expect, it } from "vitest";
import { bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
beforeAll(async () => {
  const assets = new Map([
    ["/tree.js", await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts")],
    ["/select.js", await bundleBrowserAsset("src/ui/select-browser.ts")],
    ["/commentor.js", await bundleBrowserAsset("src/commentor/commentor.ts")],
    ["/host.js", await bundleBrowserAsset("tests/fixtures/deterministic-comment-host.ts")],
  ]);
  await harness.start((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url?.startsWith("/api/tree/")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ children: [{ name: "page.html", path: "fixture/page.html", type: "file" }], isTruncated: false }));
    } else if (request.url === "/tree") {
      response.end('<!doctype html><div class="sidebar-tree" data-tree-org="fixture"><div id="tree-container"></div></div><iframe id="content-frame" name="content-frame"></iframe><script src="/tree.js"></script>');
    } else if (request.url === "/select") {
      response.end('<!doctype html><div id="container"><select class="select" aria-label="Choice"><option>A</option><option>B</option></select></div><script src="/select.js"></script>');
    } else if (request.url === "/comments") {
      response.end('<!doctype html><iframe style="width:800px;height:600px" id="content-frame" sandbox="allow-scripts" src="/legacy-view/fixture/files/page.html?comments"></iframe><script src="/host.js"></script>');
    } else if (request.url?.endsWith("?comments")) {
      response.end('<!doctype html><p id="target">Document</p><script>window.COMMENTOR={transport:"parent",orgSlug:"fixture",filePath:"fixture/page.html",documentPath:"page.html",canWrite:true}</script><script src="/commentor.js"></script>');
    } else response.end('<!doctype html><p>Loaded document</p>');
  }, assets);
});

it.each([0, 600])("settles the document loader after %i ms and handles explicit layout events", async elapsed => {
  const page = await harness.newPage({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  let releaseTree!: () => void;
  const treeHeld = new Promise<void>(resolve => { releaseTree = resolve; });
  await page.route("**/api/tree/**", async route => { await treeHeld; await route.continue(); });
  await page.goto(`${harness.origin}/tree`);
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  releaseTree();
  await page.locator('.tree-item[data-path="fixture/page.html"]').waitFor();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let arrived = false;
  await page.route("**/legacy-view/fixture/files/page.html", async route => {
    arrived = true;
    await held;
    await route.fulfill({ contentType: "text/html", body: "<p>Loaded document</p>" });
  });
  try {
    await page.getByRole("link", { name: "page", exact: true }).click();
    await expect.poll(() => arrived).toBe(true);
    await page.clock.runFor(elapsed);
    release();
    await expect.poll(() => page.locator("#content-frame").getAttribute("aria-busy")).toBeNull();
    await page.clock.runFor(600);
    expect(await page.locator("html").getAttribute("class")).not.toContain("doc-loading");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("rendro:shell-layout"));
      document.querySelector(".sidebar-tree")!.dispatchEvent(new Event("scroll"));
    });
    await page.clock.runFor(32);
    expect(await page.locator("#active-indicator").evaluate(el => (el as HTMLElement).style.opacity)).toBe("1");
  } finally { release(); }
});

it("repositions an open select on an ancestor transition and ignores unrelated transitions", async () => {
  const page = await harness.newPage({ reducedMotion: "reduce" });
  await page.goto(`${harness.origin}/select`);
  await page.getByRole("combobox").click();
  await page.getByRole("listbox").waitFor();
  await page.evaluate(() => {
    const container = document.getElementById("container")!;
    container.style.marginTop = "100px";
    container.dispatchEvent(new Event("transitionend", { bubbles: true }));
    document.body.appendChild(document.createElement("div")).dispatchEvent(new Event("transitionend", { bubbles: true }));
  });
  const trigger = await page.getByRole("combobox").boundingBox();
  const popup = await page.getByRole("listbox").boundingBox();
  expect(popup!.y).toBeGreaterThanOrEqual(trigger!.y + trigger!.height);
});

it("delivers loading, stale subscription, drawer scroll and compatibility states explicitly", async () => {
  const page = await harness.newPage({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  await page.goto(`${harness.origin}/comments`);
  const frame = page.frames().find(frame => frame !== page.mainFrame())!;
  await frame.getByTestId("commentor-panel-btn").waitFor();
  await page.evaluate("fixtureHost.start(true)");
  await expect.poll(() => page.evaluate<number>("fixtureUpdates.length")).toBe(1);
  await page.evaluate("fixtureUpdates[0]([], { canLoadMore: true, loading: true })");
  await frame.getByTestId("commentor-panel-btn").click();
  await expect.poll(() => frame.getByTestId("commentor-load-older-threads").getAttribute("aria-busy")).toBe("true");
  await page.evaluate("fixtureUpdates[0]([], { canLoadMore: true, loading: false })");
  await expect.poll(() => frame.getByTestId("commentor-load-older-threads").getAttribute("aria-busy")).toBe("false");
  await page.evaluate("publishThreads()");
  const card = frame.locator('.drawer-thread[data-thread-id="thread-0"]');
  await card.waitFor();
  await page.clock.runFor(32);
  await card.hover();
  await expect.poll(() => frame.locator(".anchor-highlight-segment:not([hidden])").count()).toBeGreaterThan(0);
  const drawer = frame.getByTestId("commentor-drawer-list");
  await drawer.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  expect(await drawer.evaluate(el => el.scrollHeight > el.clientHeight + 24)).toBe(true);
  await drawer.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
  await frame.evaluate(() => {
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.clock.runFor(32);
  await page.evaluate("fixtureHost.setUserId('replacement')");
  await expect.poll(() => page.evaluate<number>("fixtureUpdates.length")).toBe(2);
  await page.evaluate("fixtureUpdates[0]([], { canLoadMore: false, loading: false })");
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>("iframe")!.contentWindow!.postMessage({ type: "commentor-parent-ready", protocolVersion: -1, canReloadViewer: true }, "*");
  });
  await frame.getByTestId("commentor-panel-btn").click();
  await frame.getByRole("button", { name: "Show reload notice" }).waitFor();
  await page.clock.runFor(32);
  await frame.getByRole("button", { name: "Show reload notice" }).click();
  await page.clock.runFor(500);
  expect(await frame.getByRole("button", { name: "Show reload notice" }).isVisible()).toBe(true);
});
