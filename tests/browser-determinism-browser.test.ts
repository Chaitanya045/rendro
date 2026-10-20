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
    if (request.url?.startsWith("/r/acme/docs/tree?")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ children: [{ name: "page.html", type: "file" }] }));
    } else if (request.url === "/tree") {
      response.end('<!doctype html><div class="sidebar-tree" data-tree-org="fixture" data-document-base="/r/acme/docs" data-frame-base="/r/acme/docs"><div id="tree-container"></div></div><iframe id="content-frame" name="content-frame"></iframe><script src="/tree.js"></script>');
    } else if (request.url === "/select") {
      response.end('<!doctype html><div id="container"><select class="select" aria-label="Choice"><option>A</option><option>B</option></select></div><script src="/select.js"></script>');
    } else if (request.url === "/comments") {
      response.end('<!doctype html><iframe style="width:800px;height:600px" id="content-frame" sandbox="allow-scripts" src="/r/acme/docs/files/page.html?comments"></iframe><script src="/host.js"></script>');
    } else if (request.url?.endsWith("?comments")) {
      response.end(`<!doctype html><h1 id="title">Fixture</h1><p id="target">Document</p><script src="/commentor.js" data-commentor-config='{"transport":"parent","repoId":9101,"blobSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","documentPath":"page.html"}'></script>`);
    } else response.end('<!doctype html><p>Loaded document</p>');
  }, assets);
});

it.each([0, 600])("settles the document loader after %i ms and handles explicit layout events", async elapsed => {
  const page = await harness.newPage({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  let releaseTree!: () => void;
  const treeHeld = new Promise<void>(resolve => { releaseTree = resolve; });
  await page.route("**/r/acme/docs/tree?*", async route => { await treeHeld; await route.continue(); });
  await page.goto(`${harness.origin}/tree`);
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  releaseTree();
  await page.locator('.tree-item[data-path="fixture/page.html"]').waitFor();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let arrived = false;
  await page.route("**/r/acme/docs/files/page.html", async route => {
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
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      source: document.querySelector<HTMLIFrameElement>("#content-frame")!.contentWindow,
      origin: "https://untrusted.invalid", data: { type: "doc-loaded", path: "other.html" },
    })));
    expect(await page.locator(".tree-item.active").getAttribute("data-path")).toBe("fixture/page.html");
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
  await page.clock.runFor(32);
  await frame.getByTestId("commentor-comment-btn").hover();
  await page.clock.runFor(160);
  expect(await frame.getByTestId("commentor-tip").getAttribute("aria-hidden")).toBe("false");
  await frame.locator("#target").hover();
  expect(await frame.getByTestId("commentor-tip").getAttribute("aria-hidden")).toBe("true");
  await page.evaluate("publishThreads()");
  const card = frame.locator('.drawer-thread[data-thread-id="thread-0"]');
  await card.waitFor();
  await page.clock.runFor(32);
  await card.hover();
  await expect.poll(() => frame.locator(".anchor-highlight-segment:not([hidden])").count()).toBeGreaterThan(0);
  // Reposition while the segment exists; incidental layout callbacks are not
  // guaranteed to run between hover and removal on a two-CPU CI runner.
  const reusedHighlight = await card.evaluate(el => {
    const root = el.getRootNode() as ShadowRoot;
    const segments = Array.from(root.querySelectorAll<HTMLElement>(".anchor-highlight-segment"));
    const previousLeft = parseFloat(segments[0].style.left);
    document.getElementById("target")!.style.transform = "translateX(12px)";
    el.dispatchEvent(new PointerEvent("pointerenter"));
    const updated = Array.from(root.querySelectorAll<HTMLElement>(".anchor-highlight-segment"));
    return {
      reused: updated.length === segments.length && updated.every((segment, index) => segment === segments[index]),
      offset: parseFloat(updated[0].style.left) - previousLeft,
    };
  });
  expect(reusedHighlight).toEqual({ reused: true, offset: 12 });
  await frame.locator("#target").evaluate(el => { el.style.transform = "translateY(-1000px)"; });
  await card.dispatchEvent("pointerenter");
  expect(await frame.locator(".anchor-highlight-segment:not([hidden])").count()).toBe(0);
  await frame.locator("#target").evaluate(el => { el.style.transform = ""; });
  await card.dispatchEvent("pointerenter");
  expect(await frame.locator(".anchor-highlight-segment:not([hidden])").count()).toBeGreaterThan(0);
  await card.dispatchEvent("pointerleave");
  expect(await frame.locator(".anchor-highlight-segment:not([hidden])").count()).toBe(0);
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
  await harness.flushCoverage(page);
});
