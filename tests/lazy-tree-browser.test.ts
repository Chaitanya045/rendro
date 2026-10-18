import type { Page, Route } from "playwright";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
const base = "/organizations/o/projects/p/docs";
type Node = { name: string; path: string; type: "file" | "folder" };
const file = (path: string): Node => ({ name: path.split("/").pop()!, path: `org/${path}`, type: "file" });
const folder = (path: string, slash = true): Node => ({ name: path.replace(/\/$/, "").split("/").pop()!, path: `org/${path}${slash ? "/" : ""}`.replace(/\/\/$/, "/"), type: "folder" });
const legacyTree: Record<string, Node[]> = {
  "org/": [folder("guide", false), folder("big"), folder("empty"), file("top.html")],
  "org/guide/": [folder("guide/deep"), folder("guide/extra", false), file("guide/a.html"), file("guide/b.html")],
  "org/guide/extra/": [file("guide/extra/d.html")],
  "org/guide/deep/": [file("guide/deep/c.html")],
  "org/empty/": [],
};
// Scoped viewers read directory pages (`?dir=&cursor=`) from the deployment index.
type ScopedPage = { children: Array<{ name: string; type: "file" | "folder"; title?: unknown }>; cursor: string | null };
const pagedBase = "/organizations/o/projects/r/docs";
// Repository docs (#234): the shell keeps the branch URL; frames and tree pages come from the pinned commit.
const repoBase = "/r/octo/docs";
const pinnedBase = `${repoBase}/@${"c".repeat(40)}`;
const doc = (name: string) => ({ name, type: "file" as const });
const dir = (name: string) => ({ name, type: "folder" as const });
const scopedTree: Record<string, Record<string, ScopedPage[]>> = {
  [base]: {
    "": [{ children: [dir("guide"), dir("wide"), dir("zeta"), doc("top.html")], cursor: null }],
    "guide/": [{ children: [dir("deep"), doc("a.html"), doc("b.html")], cursor: null }],
    "guide/deep/": [{ children: [doc("c.html")], cursor: null }],
    // The repeated w2 row is dropped; later pages load only on request.
    "wide/": [{ children: [doc("w1.html"), doc("w2.html")], cursor: "1" }, { children: [doc("w2.html"), doc("w3.html")], cursor: "2" }, { children: [doc("w4.html")], cursor: null }],
    "zeta/": [{ children: [doc("z.html")], cursor: null }],
  },
  [pinnedBase]: {
    "": [{ children: [{ ...dir("guide"), title: "The guide" }, { ...doc("index.md"), title: "Home" }, { ...doc("plain.md"), title: "" }, { ...doc("odd.md"), title: 7 }, { ...doc("extra.md"), title: "Extra" }], cursor: null }],
    "guide/": [{ children: [{ ...doc("start.md"), title: "Getting started" }], cursor: null }],
  },
  [pagedBase]: {
    "": [{ children: [dir("a")], cursor: "1" }, { children: [dir("b"), doc("later.html")], cursor: null }],
    "a/": [{ children: [doc("first.html")], cursor: null }],
    "b/": [{ children: [doc("inner.html")], cursor: null }],
  },
};
const requests: string[] = [];

interface Shell { orgAttr?: boolean; org?: string; base?: string; frameBase?: string; sandbox?: boolean; initial?: string; frame?: boolean; tree?: boolean; host?: boolean; late?: boolean; noMatchMedia?: boolean }
function shell(options: Shell = {}): string {
  const org = options.org ?? "org";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:14px system-ui}.sidebar{width:240px;float:left}.sidebar-tree{height:320px;overflow:auto;position:relative}
.tree-item{display:flex;padding:4px 8px;position:relative}.tree-folder-content{margin-left:12px}.active-indicator{position:absolute;top:0;left:0;width:4px;height:24px;background:#06c}
.tree-folder:not(.open)>.tree-folder-collapse{display:none}#content-frame{display:block;width:420px;height:300px;float:left;border:0}
.document-navigation-notice{position:fixed;right:8px;bottom:8px;background:#fff;border:1px solid #333;padding:8px}
${options.noMatchMedia ? "" : ""}</style>
${options.noMatchMedia ? "<script>Object.defineProperty(window,'matchMedia',{value:undefined,configurable:true})</script>" : ""}
<script>window.pushed=[];for(const name of ["pushState","replaceState"]){const original=history[name].bind(history);history[name]=(state,title,url)=>{pushed.push(name+" "+(url?String(url).replace(location.origin,""):""));return original(state,title,url)}}</script>
${options.initial ? `<script>window.RENDRO_INITIAL_DOC=${JSON.stringify(options.initial)}</script>` : ""}</head><body>
${options.host === false ? "" : `<div class="sidebar"><div class="sidebar-resizer"></div><div class="sidebar-tree" ${options.orgAttr === false ? "" : `data-tree-org="${org}"`}${options.base !== undefined ? ` data-document-base="${options.base}"` : ""}${options.frameBase ? ` data-frame-base="${options.frameBase}"` : ""}>${options.tree === false ? "" : '<div id="tree-container"></div>'}</div></div>`}
<div id="main-placeholder">Choose a document</div>
${options.frame === false ? "" : `<div class="doc-frames" style="position:relative;width:420px;height:300px;float:left"><iframe id="content-frame" name="content-frame" ${options.sandbox === false ? "" : 'sandbox="allow-scripts"'} title="Document" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0"></iframe></div>`}
${options.late ? '<script>addEventListener("load",()=>{const s=document.createElement("script");s.src="/lazy-tree.js";document.body.append(s)})</script>' : '<script src="/lazy-tree.js"></script>'}
</body></html>`;
}
const variants: Record<string, Shell> = {
  legacy: {}, "legacy-initial": { initial: "org/guide/a.html" }, "legacy-late": { late: true }, "legacy-open": { sandbox: false },
  "legacy-no-frame": { frame: false }, "legacy-no-matchmedia": { noMatchMedia: true, initial: "org/guide/a.html" },
  "empty-org": { org: "" }, "empty-org-base": { org: "", base }, "empty-org-initial": { org: "", initial: "x/y.html" }, "no-org-attr": { orgAttr: false, initial: "x/y.html" }, "legacy-empty": { org: "void" }, "no-tree": { tree: false }, "no-host": { host: false },
  base: { base }, "base-paged": { base: pagedBase }, repo: { org: "docs", base: repoBase, frameBase: pinnedBase }, "base-empty-project": { base: "/organizations/o/projects/q/docs" }, "base-empty-other": { base: "/other/docs" },
};
function docPage(announce = false): string {
  return `<!doctype html><html><body><h1 id="top">Document</h1><a id="go" href="#">Go</a><script>
window.received=[];window.nextNavigation={type:"doc-navigate",path:"guide/b.html",search:"?v=2",fragment:"#sec"};
addEventListener("message",e=>{if(e.source!==parent)return;if(e.data&&e.data.type==="fixture-post")parent.postMessage(e.data.payload,"*");else received.push(e.data)});
${announce ? 'parent.postMessage({type:"doc-loaded",path:location.pathname.slice(location.pathname.lastIndexOf("/files/")+7),search:location.search,fragment:location.hash},"*");' : ""}
document.getElementById("go").addEventListener("click",e=>{e.preventDefault();parent.postMessage(nextNavigation,"*")});
</script></body></html>`;
}

beforeAll(async () => {
  const assets = new Map([["/lazy-tree.js", await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts")]]);
  await harness.start((request, response) => {
    const url = new URL(request.url!, harness.origin);
    requests.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url.pathname === "/api/tree/org") {
      const prefix = url.searchParams.get("prefix")!, after = url.searchParams.get("startAfter");
      if (prefix === "org/big/") {
        return json(after ? { children: [file("big/f2.html"), file("big/f3.html")], isTruncated: false }
          : { children: [file("big/f1.html"), file("big/f2.html")], isTruncated: true, nextStartAfter: "org/big/f2.html" });
      }
      return json({ children: legacyTree[prefix] ?? [], isTruncated: false });
    }
    if (url.pathname === "/api/tree/void") return json({ children: [], isTruncated: false });
    if (url.pathname.endsWith("/tree")) {
      const pages = scopedTree[url.pathname.slice(0, -"/tree".length)]?.[url.searchParams.get("dir") ?? ""] ?? [];
      return json(pages[Number(url.searchParams.get("cursor") ?? "0")] ?? { children: [], cursor: null });
    }
    if (url.pathname.includes("/files/")) { response.setHeader("Content-Type", "text/html"); return void response.end(docPage(url.pathname.endsWith(".md"))); }
    response.setHeader("Content-Type", "text/html");
    const name = url.pathname.startsWith("/lt/") ? url.pathname.slice(4) : url.pathname.startsWith("/docs") ? "legacy" : url.pathname === base ? "base" : url.pathname === pagedBase ? "base-paged" : url.pathname === repoBase ? "repo" : "";
    response.end(shell(variants[name] ?? {}));
  }, assets);
});
beforeEach(() => { requests.length = 0; });

type Options = { clock?: boolean; motion?: boolean; routes?: (tab: Page) => Promise<void>; init?: string };
async function open(path: string, options: Options = {}) {
  const tab = await harness.newPage({ viewport: { width: 800, height: 600 }, reducedMotion: options.motion ? "no-preference" : "reduce" });
  const errors: string[] = [];
  tab.on("pageerror", error => errors.push(error.message));
  Object.assign(tab, { errors });
  if (options.clock) { await tab.clock.install({ time: new Date("2026-01-01T00:00:00Z") }); await tab.clock.pauseAt(new Date("2026-01-01T00:00:01Z")); }
  if (options.init) await tab.addInitScript(options.init);
  await options.routes?.(tab);
  await browserStep(`open ${path}`, () => tab.goto(harness.origin + path));
  return tab;
}
const pageErrors = (tab: Page) => (tab as Page & { errors: string[] }).errors;
const item = (tab: Page, path: string) => tab.locator(`.tree-item[data-path="${path}"]`);
const folderItem = (tab: Page, path: string) => tab.locator(`.tree-folder[data-path="${path}"] > .tree-item`);
const collapseOf = (tab: Page, path: string) => tab.locator(`.tree-folder[data-path="${path}"] > .tree-folder-collapse`);
const frameSrc = (tab: Page) => tab.locator("#content-frame").getAttribute("src");
const pushes = (tab: Page) => tab.evaluate(() => (window as unknown as { pushed: string[] }).pushed);
const post = (tab: Page, payload: unknown) => tab.evaluate(message => document.querySelector<HTMLIFrameElement>("#content-frame")!.contentWindow!.postMessage({ type: "fixture-post", payload: message }, "*"), payload);
const docFrame = (tab: Page) => tab.frames().find(frame => frame !== tab.mainFrame())!;
async function held(tab: Page, pattern: string, status = 200) {
  const held: Route[] = [];
  let arrived!: () => void; const seen = new Promise<void>(resolve => { arrived = resolve; });
  await tab.route(pattern, route => { held.push(route); arrived(); });
  return { seen, release: async () => { for (const route of held.splice(0)) await (status === 200 ? route.continue() : route.fulfill({ status, body: "{}" })); } };
}
async function indicatorAt(tab: Page, path: string) {
  expect(await tab.evaluate(target => {
    const el = document.querySelector<HTMLElement>(`.tree-item[data-path="${target}"]`)!;
    const indicator = document.getElementById("active-indicator")!;
    return indicator.style.opacity === "1" && indicator.style.transform === `translate(${el.offsetLeft}px, ${el.offsetTop}px)`;
  }, path)).toBe(true);
}

describe("lazy tree folders (legacy API)", () => {
  it("renders folders first, expands them lazily and keeps their state on collapse and re-expand", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    expect(await tab.locator("#tree-container > .tree-folder > .tree-item .tree-label, #tree-container > .tree-item .tree-label").allTextContents()).toEqual(["guide", "big", "empty", "top"]);
    expect(await tab.locator("#tree-container").getAttribute("aria-busy")).toBeNull();
    const guide = folderItem(tab, "org/guide/");
    expect(await guide.getAttribute("aria-expanded")).toBe("false");
    // A closed folder's rows are inert (out of Tab and the accessibility tree) until it opens, and again once it closes.
    expect(await collapseOf(tab, "org/guide/").getAttribute("inert")).toBe("");
    await guide.click();
    await item(tab, "org/guide/a.html").waitFor();
    expect(await guide.getAttribute("aria-expanded")).toBe("true");
    expect(await collapseOf(tab, "org/guide/").getAttribute("inert")).toBeNull();
    expect(await guide.locator(".folder-icon").textContent()).toBe("folder_open");
    expect(await tab.locator('.tree-folder[data-path="org/guide/"]').getAttribute("aria-busy")).toBeNull();
    // Opening the nested folder uses the depth of its parent.
    await folderItem(tab, "org/guide/deep/").click();
    await item(tab, "org/guide/deep/c.html").waitFor();
    await guide.click();
    expect(await guide.getAttribute("aria-expanded")).toBe("false");
    expect(await collapseOf(tab, "org/guide/").getAttribute("inert")).toBe("");
    expect(await collapseOf(tab, "org/guide/deep/").getAttribute("inert")).toBeNull();
    expect(await guide.locator(".folder-icon").textContent()).toBe("folder");
    const before = requests.filter(path => path.startsWith("/api/tree/")).length;
    await guide.click();
    expect(await guide.getAttribute("aria-expanded")).toBe("true");
    expect(await collapseOf(tab, "org/guide/").getAttribute("inert")).toBeNull();
    expect(requests.filter(path => path.startsWith("/api/tree/")).length).toBe(before);
    // A folder with no children still opens, instead of staying busy.
    await folderItem(tab, "org/empty/").click();
    await tab.waitForFunction(() => document.querySelector('.tree-folder[data-path="org/empty/"]')!.classList.contains("loaded"));
    expect(await tab.locator('.tree-folder[data-path="org/empty/"] .tree-item').count()).toBe(1);
  });

  it("ignores repeated clicks while a folder is loading", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    const hold = await held(tab, "**/api/tree/org?prefix=org%2Fguide%2F*");
    await folderItem(tab, "org/guide/").click();
    await hold.seen;
    expect(await tab.locator('.tree-folder[data-path="org/guide/"]').getAttribute("aria-busy")).toBe("true");
    await folderItem(tab, "org/guide/").click();
    await hold.release();
    await item(tab, "org/guide/a.html").waitFor();
    expect(requests.filter(path => path.includes("prefix=org%2Fguide%2F&"))).toHaveLength(1);
    // Only the first click's expansion remains: the second was ignored rather than collapsing it.
    expect(await tab.locator('.tree-folder[data-path="org/guide/"]').getAttribute("class")).toContain("open");
  });

  it("shows a retryable folder error and loads the folder after retry", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    let fail = true;
    await tab.route("**/api/tree/org?prefix=org%2Fguide%2F*", route => fail ? route.fulfill({ status: 500, body: "{}" }) : route.continue());
    await folderItem(tab, "org/guide/").click();
    const error = tab.locator('.tree-folder[data-path="org/guide/"] .tree-error');
    await error.waitFor();
    expect(await error.getAttribute("role")).toBe("alert");
    expect(await error.textContent()).toContain("Failed to load folder.");
    expect(await folderItem(tab, "org/guide/").getAttribute("aria-expanded")).toBe("true");
    // The error and its Retry button are reachable, so the folder is not inert.
    expect(await collapseOf(tab, "org/guide/").getAttribute("inert")).toBeNull();
    expect(await tab.locator('.tree-folder[data-path="org/guide/"]').getAttribute("aria-busy")).toBeNull();
    fail = false;
    await error.getByRole("button", { name: "Retry" }).click();
    await item(tab, "org/guide/a.html").waitFor();
    expect(await error.count()).toBe(0);
  });

  it("pages a folder, drops duplicate rows and retries a failed page", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    await folderItem(tab, "org/big/").click();
    const more = tab.locator('.tree-folder[data-path="org/big/"] .load-more-btn');
    await more.waitFor();
    expect(await more.textContent()).toBe("Load more...");
    let fail = true;
    await tab.route("**/api/tree/org?prefix=org%2Fbig%2F&limit=50&startAfter=*", route => fail ? route.fulfill({ status: 503, body: "{}" }) : route.continue());
    await more.click();
    await tab.waitForFunction(() => document.querySelector('.tree-folder[data-path="org/big/"] .load-more-btn')!.textContent === "Retry");
    expect(await more.isDisabled()).toBe(false);
    expect(await more.getAttribute("aria-busy")).toBeNull();
    fail = false;
    await more.click();
    await item(tab, "org/big/f3.html").waitFor();
    expect(await tab.locator('.tree-folder[data-path="org/big/"] .tree-link').allTextContents()).toEqual(["f1", "f2", "f3"]);
    expect(await tab.locator('.tree-folder[data-path="org/big/"] .tree-load-more').count()).toBe(0);
    expect(requests.some(path => path.includes("startAfter=org%2Fbig%2Ff2.html"))).toBe(true);
  });

  it("leaves the tree alone when a pending page's button was replaced", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    await folderItem(tab, "org/big/").click();
    const more = tab.locator('.tree-folder[data-path="org/big/"] .load-more-btn');
    await more.waitFor();
    const hold = await held(tab, "**/api/tree/org?prefix=org%2Fbig%2F&limit=50&startAfter=*", 500);
    await more.click();
    await hold.seen;
    expect(await more.textContent()).toBe("Loading…");
    expect(await more.isDisabled()).toBe(true);
    expect(await more.getAttribute("aria-busy")).toBe("true");
    await tab.evaluate(() => document.querySelector('.tree-folder[data-path="org/big/"] .tree-load-more')!.replaceChildren());
    await hold.release();
    await tab.waitForFunction(() => !document.querySelector('.tree-folder[data-path="org/big/"] .load-more-btn'));
    expect(await tab.locator('.tree-folder[data-path="org/big/"] .tree-link').allTextContents()).toEqual(["f1", "f2"]);
  });

  it("opens and closes folders from the keyboard and ignores other keys", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    const guide = folderItem(tab, "org/guide/");
    await guide.focus();
    await tab.keyboard.press("Enter");
    await item(tab, "org/guide/a.html").waitFor();
    expect(await guide.getAttribute("aria-expanded")).toBe("true");
    await tab.keyboard.press("Space");
    expect(await guide.getAttribute("aria-expanded")).toBe("false");
    await tab.keyboard.press("a"); await tab.keyboard.press("ArrowDown");
    expect(await guide.getAttribute("aria-expanded")).toBe("false");
    // Keys on non-folder rows or non-HTML targets never toggle anything.
    await tab.evaluate(() => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      document.getElementById("tree-container")!.append(svg);
      svg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      document.querySelector('.tree-item[data-path="org/top.html"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(await guide.getAttribute("aria-expanded")).toBe("false");
    expect(pageErrors(tab)).toEqual([]);
  });

  it("ignores clicks that are not on folder or document rows", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    await tab.evaluate(() => {
      const tree = document.getElementById("tree-container")!;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const plain = document.createElement("div"); plain.id = "plain"; plain.textContent = "Not a row";
      const bare = document.createElement("div"); bare.className = "tree-item"; bare.id = "bare"; bare.textContent = "No path";
      const stray = document.createElement("button"); stray.className = "load-more-btn folder-retry-btn"; stray.id = "stray";
      const orphan = document.createElement("div"); orphan.className = "tree-folder"; orphan.dataset.path = "org/orphan/";
      orphan.innerHTML = '<div class="tree-item" role="button" id="orphan-item"></div>';
      const loose = document.createElement("div"); loose.className = "tree-folder"; loose.id = "loose";
      loose.innerHTML = '<div class="tree-item" id="loose-item"></div>';
      const more = document.createElement("div"); more.className = "tree-folder"; more.dataset.path = "org/more/";
      more.innerHTML = '<div class="tree-item"></div><div class="tree-folder-content"><div class="tree-load-more"><button class="load-more-btn" id="more">Load more...</button></div></div>';
      tree.append(svg, plain, bare, stray, orphan, loose, more);
      for (const target of [svg, plain, bare, stray, document.getElementById("orphan-item")!, document.getElementById("loose-item")!, document.getElementById("more")!]) {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
    });
    expect(await frameSrc(tab)).toBeNull();
    expect(await tab.locator("#main-placeholder").isVisible()).toBe(true);
    expect(await tab.locator("#more").textContent()).toBe("Load more...");
    expect(await tab.locator("#more").isDisabled()).toBe(false);
    expect(await tab.locator("#orphan-item").evaluate(el => el.parentElement!.classList.contains("open"))).toBe(false);
    expect(await pushes(tab)).toEqual([]);
    expect(requests.filter(path => path.startsWith("/api/tree/"))).toHaveLength(1);
  });
});

const location = (tab: Page) => tab.evaluate(() => window.location.pathname + window.location.search + window.location.hash);
const receivedByFrame = (tab: Page) => docFrame(tab).evaluate(() => (window as unknown as { received: unknown[] }).received);
const status = (tab: Page) => tab.locator("#document-load-status");
const activePath = (tab: Page) => tab.evaluate(() => document.querySelector(".tree-item.active")?.getAttribute("data-path") ?? null);

describe("lazy tree document loading", () => {
  it("selects a document, announces loading, then settles after the minimum display time", async () => {
    const tab = await open("/lt/legacy", { clock: true });
    await item(tab, "org/top.html").waitFor();
    await folderItem(tab, "org/guide/").click();
    await item(tab, "org/guide/a.html").waitFor();
    const hold = await held(tab, "**/legacy-view/org/files/guide/a.html");
    await tab.locator('a.tree-link[href="/legacy-view/org/files/guide/a.html"]').click();
    await hold.seen;
    expect(await tab.locator("html").getAttribute("class")).toContain("doc-loading");
    expect(await status(tab).textContent()).toBe("Loading document");
    expect(await status(tab).getAttribute("aria-live")).toBe("polite");
    expect(await status(tab).getAttribute("role")).toBe("status");
    expect(await tab.locator("#content-frame").getAttribute("aria-busy")).toBe("true");
    expect(await tab.locator("#main-placeholder").isHidden()).toBe(true);
    expect(await activePath(tab)).toBe("org/guide/a.html");
    await indicatorAt(tab, "org/guide/a.html");
    expect(await location(tab)).toBe("/docs/org/guide/a.html");
    expect(await tab.evaluate((): unknown => history.state)).toEqual({ docPath: "org/guide/a.html" });
    await hold.release();
    await tab.waitForFunction(() => !document.getElementById("content-frame")!.hasAttribute("aria-busy"));
    expect(await status(tab).textContent()).toBe("");
    // The loader stays up for the minimum display time, then clears.
    expect(await tab.locator("html").getAttribute("class")).toContain("doc-loading");
    await tab.clock.runFor(520);
    expect(await tab.locator("html").getAttribute("class") ?? "").not.toContain("doc-loading");
    expect(await receivedByFrame(tab)).toContainEqual({ type: "doc-fragment", path: "guide/a.html", fragment: "" });
    expect(pageErrors(tab)).toEqual([]);
  });

  it("clears the loader immediately when a slow load has already outlasted the minimum display time", async () => {
    const tab = await open("/lt/legacy", { clock: true });
    await item(tab, "org/top.html").waitFor();
    await folderItem(tab, "org/guide/").click();
    await item(tab, "org/guide/a.html").waitFor();
    const slow = await held(tab, "**/legacy-view/org/files/guide/b.html");
    await tab.locator('a.tree-link[href="/legacy-view/org/files/guide/b.html"]').click();
    await slow.seen;
    await tab.clock.runFor(600);
    await slow.release();
    await tab.waitForFunction(() => !document.documentElement.classList.contains("doc-loading"));
    expect(await activePath(tab)).toBe("org/guide/b.html");
    expect(await location(tab)).toBe("/docs/org/guide/b.html");
    expect(pageErrors(tab)).toEqual([]);
  });

  it.each(["timeout", "error event"])("reports a failed document load after a %s and recovers when it is selected again", async failure => {
    const tab = await open("/lt/legacy", { clock: true });
    await item(tab, "org/top.html").waitFor();
    await folderItem(tab, "org/guide/").click();
    await item(tab, "org/guide/a.html").waitFor();
    const hold = await held(tab, "**/legacy-view/org/files/guide/a.html");
    await tab.locator('a.tree-link[href="/legacy-view/org/files/guide/a.html"]').click();
    await hold.seen;
    if (failure === "timeout") await tab.clock.runFor(15_000);
    else await tab.evaluate(() => document.getElementById("content-frame")!.dispatchEvent(new Event("error")));
    const classes = await tab.locator("html").getAttribute("class");
    expect(classes).toContain("doc-loading-error");
    expect(classes).not.toMatch(/(^|\s)doc-loading(\s|$)/);
    expect(await status(tab).textContent()).toBe("Document failed to load. Select it again to retry.");
    expect(await status(tab).getAttribute("aria-live")).toBe("assertive");
    expect(await tab.locator("#content-frame").getAttribute("aria-busy")).toBeNull();
    // The failed document's request stays held until the retry is asserted: releasing it
    // earlier lets its late load event race the retry's handlers and clear the announcement.
    const next = await held(tab, "**/legacy-view/org/files/guide/b.html");
    await tab.locator('a.tree-link[href="/legacy-view/org/files/guide/b.html"]').click();
    await next.seen;
    expect(await tab.locator("html").getAttribute("class")).not.toContain("doc-loading-error");
    expect(await status(tab).getAttribute("aria-live")).toBe("polite");
    expect(await status(tab).textContent()).toBe("Loading document");
    expect(await tab.locator("#content-frame").getAttribute("aria-busy")).toBe("true");
    await next.release();
    await hold.release();
  });

  it("lets a late load error replace the pending loader and keeps it from being cleared", async () => {
    const tab = await open("/lt/legacy", { clock: true });
    await item(tab, "org/top.html").waitFor();
    await tab.locator('a.tree-link[href="/legacy-view/org/files/top.html"]').click();
    await tab.waitForFunction(() => !document.getElementById("content-frame")!.hasAttribute("aria-busy") && !!document.getElementById("content-frame")!.getAttribute("src"));
    expect(await tab.locator("html").getAttribute("class")).toContain("doc-loading");
    await tab.evaluate(() => document.getElementById("content-frame")!.dispatchEvent(new Event("error")));
    expect(await tab.locator("html").getAttribute("class")).toContain("doc-loading-error");
    await tab.clock.runFor(1000);
    expect(await tab.locator("html").getAttribute("class")).toContain("doc-loading-error");
    expect(await status(tab).textContent()).toBe("Document failed to load. Select it again to retry.");
  });

  it("keeps modified-click links native and takes over plain clicks", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    const outcome = await tab.evaluate(() => {
      const link = document.querySelector<HTMLAnchorElement>('a.tree-link[href="/legacy-view/org/files/top.html"]')!;
      const seen: boolean[] = [];
      document.addEventListener("click", event => { seen.push(event.defaultPrevented); event.preventDefault(); }, { once: false });
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }));
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return seen;
    });
    expect(outcome).toEqual([false, false, true]);
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/top.html");
  });

  it("selects documents without a content frame", async () => {
    const tab = await open("/lt/legacy-no-frame");
    await item(tab, "org/top.html").waitFor();
    await tab.locator('a.tree-link[href="/legacy-view/org/files/top.html"]').click();
    expect(await location(tab)).toBe("/docs/org/top.html");
    expect(await activePath(tab)).toBe("org/top.html");
    expect(await tab.locator("#main-placeholder").isHidden()).toBe(true);
    await tab.evaluate(() => { window.location.hash = "#nowhere"; });
    await tab.waitForFunction(() => window.location.hash === "#nowhere");
    await tab.evaluate(() => window.postMessage({ type: "doc-fragment", path: "top.html", fragment: "#late" }, "*"));
    await tab.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    expect(await location(tab)).toBe("/docs/org/top.html#nowhere");
    expect(pageErrors(tab)).toEqual([]);
  });
});

describe("lazy tree deep links and history", () => {
  it("opens a deep link with its query and fragment, revealing and marking the document", async () => {
    const tab = await open("/docs/org/guide/a.html?docQuery=%3Fv%3D1#details");
    await item(tab, "org/guide/a.html").waitFor();
    await tab.waitForFunction(() => document.querySelector('.tree-item[data-path="org/guide/a.html"]')!.classList.contains("active"));
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/a.html?v=1");
    expect(await folderItem(tab, "org/guide/").getAttribute("aria-expanded")).toBe("true");
    await indicatorAt(tab, "org/guide/a.html");
    expect(await tab.evaluate((): unknown => history.state)).toEqual({ docPath: "org/guide/a.html" });
    expect(await location(tab)).toBe("/docs/org/guide/a.html?docQuery=%3Fv%3D1#details");
    await tab.waitForFunction(() => !document.getElementById("content-frame")!.hasAttribute("aria-busy"));
    expect(await receivedByFrame(tab)).toContainEqual({ type: "doc-fragment", path: "guide/a.html", fragment: "#details" });
  });

  it.each([
    ["/docs/org/gu%20ide/a%20b.html", "/legacy-view/org/files/gu%20ide/a%20b.html"],
    ["/docs/org/guide/a.html?docQuery=nonsense", "/legacy-view/org/files/guide/a.html"],
    ["/docs/org/guide/a.html?docQuery=%3Fx%23y", "/legacy-view/org/files/guide/a.html"],
    ["/lt/legacy-initial", "/legacy-view/org/files/guide/a.html"],
  ])("loads %s into the right frame URL", async (path, expected) => {
    const tab = await open(path);
    await tab.waitForFunction(() => !!document.getElementById("content-frame")!.getAttribute("src"));
    expect(await frameSrc(tab)).toBe(expected);
    expect(await tab.locator("#main-placeholder").isHidden()).toBe(true);
  });

  it.each(["/docs/org", "/docs/other/x.html", "/lt/legacy"])("shows no document for %s", async path => {
    const tab = await open(path);
    await item(tab, "org/top.html").waitFor();
    expect(await frameSrc(tab)).toBeNull();
    expect(await tab.locator("#main-placeholder").isVisible()).toBe(true);
    expect(await activePath(tab)).toBeNull();
  });

  it("converts a legacy ?doc parameter into a canonical document URL and drops dev parameters", async () => {
    const tab = await open("/lt/legacy?doc=org/guide/b.html&dev_user=someone");
    await tab.waitForFunction(() => !!document.getElementById("content-frame")!.getAttribute("src"));
    expect(await location(tab)).toBe("/docs/org/guide/b.html");
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/b.html");
    expect(await tab.evaluate((): unknown => history.state)).toEqual({ docPath: "org/guide/b.html" });
    const plain = await open("/lt/legacy?dev_user=someone&keep=1");
    await item(plain, "org/top.html").waitFor();
    expect(await location(plain)).toBe("/lt/legacy?keep=1");
    expect(await frameSrc(plain)).toBeNull();
  });

  it("restores documents on Back/Forward and keeps the last document for an entry without one", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await tab.waitForFunction(() => document.querySelector(".tree-item.active")?.getAttribute("data-path") === "org/guide/a.html");
    await tab.locator('a.tree-link[href="/legacy-view/org/files/guide/b.html"]').click();
    expect(await location(tab)).toBe("/docs/org/guide/b.html");
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/b.html");
    await tab.goBack();
    await tab.waitForFunction(() => document.getElementById("content-frame")!.getAttribute("src")!.endsWith("guide/a.html"));
    expect(await location(tab)).toBe("/docs/org/guide/a.html");
    expect(await activePath(tab)).toBe("org/guide/a.html");
    await indicatorAt(tab, "org/guide/a.html");
    await tab.goForward();
    await tab.waitForFunction(() => document.getElementById("content-frame")!.getAttribute("src")!.endsWith("guide/b.html"));
    expect(await activePath(tab)).toBe("org/guide/b.html");
    // An entry without a document does not change what is displayed.
    await tab.evaluate(() => history.pushState({}, "", "/lt/legacy?plain=1"));
    await tab.goBack();
    await tab.goForward();
    await tab.waitForFunction(() => window.location.search === "?plain=1");
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/b.html");
    expect(await activePath(tab)).toBe("org/guide/b.html");
  });

  it("never points the frame outside the organization for a foreign history entry", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    await tab.evaluate(() => {
      history.pushState({ docPath: "foreign/secret.html" }, "", "/lt/legacy?entry=1");
      history.pushState({}, "", "/lt/legacy?entry=2");
    });
    await tab.goBack();
    await tab.waitForFunction(() => document.getElementById("content-frame")!.getAttribute("src") === "/legacy-view/org/files/");
    expect(requests.some(path => path.includes("foreign"))).toBe(false);
    expect(await activePath(tab)).toBeNull();
  });

  it("is inert when the shell names no organization", async () => {
    const tab = await open("/lt/empty-org");
    await tab.waitForFunction(() => document.querySelector("#tree-container")!.getAttribute("aria-busy") === null);
    expect(requests.filter(path => path.startsWith("/api/tree/"))).toEqual([]);
    expect(await tab.locator("#tree-container").innerHTML()).toBe("");
    const scoped = await open("/lt/empty-org-base?doc=x/y.html");
    await scoped.waitForFunction(() => window.location.search !== "?doc=x/y.html");
    expect(requests.filter(path => path.includes("/tree"))).toEqual([]);
    expect(await scoped.locator("#tree-container").innerHTML()).toBe("");
    expect(pageErrors(tab)).toEqual([]);
    expect(pageErrors(scoped)).toEqual([]);
  });

  it("starts after load, and does nothing without a tree container or host", async () => {
    const late = await open("/lt/legacy-late");
    await item(late, "org/top.html").waitFor();
    for (const name of ["no-tree", "no-host"]) {
      requests.length = 0;
      const tab = await open(`/lt/${name}`);
      await tab.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(requests).toEqual([`/lt/${name}`]);
      expect(pageErrors(tab)).toEqual([]);
    }
  });
});

async function settled(tab: Page) {
  await tab.waitForFunction(() => !document.getElementById("content-frame")!.hasAttribute("aria-busy") && !!document.getElementById("content-frame")!.getAttribute("src"));
}
const frameLink = (tab: Page) => docFrame(tab).locator("#go");
const nextNavigation = (tab: Page, payload: unknown) => docFrame(tab).evaluate(message => { (window as unknown as { nextNavigation: unknown }).nextNavigation = message; }, payload);

describe("lazy tree messages from the document frame", () => {
  it("applies valid fragment reports and ignores forged, stale and malformed ones", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    const initial = (await pushes(tab)).length;
    for (const payload of [
      null, "text", { type: 1, path: "guide/a.html" }, { type: "doc-fragment" },
      { type: "doc-fragment", path: "guide/b.html", fragment: "#other" },
      { type: "doc-fragment", path: "guide/a.html", fragment: "no-hash" },
      { type: "doc-fragment", path: "guide/a.html", fragment: "#" + "x".repeat(4096) },
    ]) await post(tab, payload);
    // The shell itself is not the content frame, so its own messages are ignored.
    await tab.evaluate(() => window.postMessage({ type: "doc-fragment", path: "guide/a.html", fragment: "#self" }, "*"));
    await post(tab, { type: "doc-fragment", path: "guide/a.html", fragment: "#details" });
    await tab.waitForFunction(() => window.location.hash === "#details");
    expect((await pushes(tab)).slice(initial)).toEqual(["replaceState /docs/org/guide/a.html#details"]);
    expect(await location(tab)).toBe("/docs/org/guide/a.html#details");
  });

  it("forwards the shell's own fragment changes to the frame", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    await tab.evaluate(() => { window.location.hash = "#shell"; });
    await tab.waitForFunction(() => (document.querySelector("#content-frame") as HTMLIFrameElement).src.length > 0);
    await expect.poll(() => receivedByFrame(tab)).toContainEqual({ type: "doc-fragment", path: "guide/a.html", fragment: "#shell" });
  });

  it("does not forward a fragment change when no document is open", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    const reads = await tab.evaluate(() => new Promise<number>(resolve => {
      const frame = document.getElementById("content-frame") as HTMLIFrameElement;
      let count = 0;
      Object.defineProperty(frame, "contentWindow", { get() { count++; return null; } });
      window.addEventListener("hashchange", () => resolve(count), { once: true });
      window.location.hash = "#nothing";
    }));
    expect(reads).toBe(0);
  });

  it("acknowledges loaded documents without navigating or fetching", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    const before = requests.length;
    for (const path of ["guide/a.html", "org/guide/a.html", "org/guide/b.html", "../escape.html", "guide//x.html", "other.html"]) {
      await post(tab, { type: "doc-loaded", path, search: "", fragment: "" });
    }
    await post(tab, { type: "doc-fragment", path: "guide/a.html", fragment: "#after" });
    await tab.waitForFunction(() => window.location.hash === "#after");
    expect(requests.length).toBe(before);
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/a.html");
    expect(await location(tab)).toBe("/docs/org/guide/a.html#after");
  });

  it("follows a link the reader clicks inside the document and keeps its query and fragment", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    const length = await tab.evaluate(() => history.length);
    await frameLink(tab).click();
    await tab.waitForFunction(() => window.location.pathname === "/docs/org/guide/b.html");
    expect(await location(tab)).toBe("/docs/org/guide/b.html?docQuery=%3Fv%3D2#sec");
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/b.html?v=2");
    expect(await activePath(tab)).toBe("org/guide/b.html");
    expect(await tab.evaluate(() => history.length)).toBe(length + 1);
    expect(await tab.locator("#document-navigation-notice").count()).toBe(0);
  });

  it("ignores navigation to the current document, and defaults missing optional fields otherwise", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    const initial = (await pushes(tab)).length;
    await nextNavigation(tab, { type: "doc-navigate", path: "guide/a.html" });
    await frameLink(tab).click();
    await post(tab, { type: "doc-fragment", path: "guide/a.html", fragment: "#sentinel" });
    await tab.waitForFunction(() => window.location.hash === "#sentinel");
    expect((await pushes(tab)).slice(initial)).toEqual(["replaceState /docs/org/guide/a.html#sentinel"]);
    expect(await tab.locator("#document-navigation-notice").count()).toBe(0);
    await nextNavigation(tab, { type: "doc-navigate", path: "guide/deep/c.html" });
    await frameLink(tab).click();
    await tab.waitForFunction(() => window.location.pathname === "/docs/org/guide/deep/c.html");
    expect(await location(tab)).toBe("/docs/org/guide/deep/c.html");
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/deep/c.html");
  });

  it.each([
    ["an escaping path", { path: "../secret.html" }],
    ["an empty segment", { path: "guide//x.html" }],
    ["a non-string path", { path: 5 }],
    ["an oversized fragment", { path: "guide/b.html", fragment: "#" + "x".repeat(4096) }],
    ["a fragment without #", { path: "guide/b.html", fragment: "sec" }],
    ["a query containing a fragment", { path: "guide/b.html", search: "?a#b" }],
    ["a query without ?", { path: "guide/b.html", search: "a=1" }],
  ])("drops navigation with %s", async (_name, fields) => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    const initial = (await pushes(tab)).length;
    await nextNavigation(tab, { type: "doc-navigate", ...fields });
    await frameLink(tab).click();
    await post(tab, { type: "doc-fragment", path: "guide/a.html", fragment: "#sentinel" });
    await tab.waitForFunction(() => window.location.hash === "#sentinel");
    expect((await pushes(tab)).slice(initial)).toEqual(["replaceState /docs/org/guide/a.html#sentinel"]);
    expect(await tab.locator("#document-navigation-notice").count()).toBe(0);
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/a.html");
  });

  it("ignores messages when the content frame stops being sandboxed", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    await tab.evaluate(() => document.getElementById("content-frame")!.removeAttribute("sandbox"));
    const initial = (await pushes(tab)).length;
    await frameLink(tab).click();
    await post(tab, { type: "doc-fragment", path: "guide/a.html", fragment: "#ignored" });
    await tab.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 150)));
    expect((await pushes(tab)).length).toBe(initial);
    expect(await location(tab)).toBe("/docs/org/guide/a.html");
    expect(await tab.locator("#document-navigation-notice").count()).toBe(0);
  });

  it("accepts same-origin messages from a frame that is not sandboxed", async () => {
    const tab = await open("/lt/legacy-open?x=1");
    await item(tab, "org/top.html").waitFor();
    await tab.locator('a.tree-link[href="/legacy-view/org/files/top.html"]').click();
    await settled(tab);
    await post(tab, { type: "doc-fragment", path: "top.html", fragment: "#from-open-frame" });
    await tab.waitForFunction(() => window.location.hash === "#from-open-frame");
  });
});

describe("lazy tree navigation confirmation", () => {
  const request = { type: "doc-navigate", path: "guide/b.html", search: "?v=1", fragment: "#sec" };
  const notice = (tab: Page) => tab.locator("#document-navigation-notice");
  // Input in the shell reserves the browser's activation, so a frame message can no longer navigate by itself.
  const reserve = (tab: Page) => tab.locator(".sidebar").click({ position: { x: 200, y: 300 } });

  it("asks before opening a link no click authorized, keeps one pending target and lets the reader review it", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    await reserve(tab);
    await post(tab, request);
    await notice(tab).waitFor();
    const label = tab.locator("#document-navigation-destination");
    expect(await label.textContent()).toBe("Open linked document guide/b.html?v=1#sec?");
    expect(await label.getAttribute("role")).toBe("status");
    expect(await notice(tab).getByRole("button", { name: "Open linked document" }).getAttribute("aria-describedby")).toBe("document-navigation-destination");
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/a.html");
    // A visible prompt keeps its destination; so does a repeat of the same one.
    await post(tab, { ...request, path: "guide/deep/c.html" });
    await post(tab, request);
    expect(await label.textContent()).toBe("Open linked document guide/b.html?v=1#sec?");
    await notice(tab).getByRole("button", { name: "Dismiss" }).click();
    const review = tab.getByRole("button", { name: "Review linked document" });
    await review.waitFor();
    expect(await notice(tab).count()).toBe(0);
    expect(await tab.evaluate(() => document.activeElement?.textContent)).toBe("Review linked document");
    // While dismissed, later requests only replace the pending target silently.
    await post(tab, { ...request, path: "guide/deep/c.html", search: "", fragment: "" });
    await post(tab, { ...request, path: "guide/deep/c.html", search: "", fragment: "" });
    expect(await notice(tab).count()).toBe(0);
    await review.click();
    await notice(tab).waitFor();
    expect(await label.textContent()).toBe("Open linked document guide/deep/c.html?");
    expect(await tab.evaluate(() => document.activeElement?.textContent)).toBe("Open linked document");
    expect(await tab.locator("#document-navigation-review").count()).toBe(0);
    await notice(tab).getByRole("button", { name: "Open linked document" }).click();
    await tab.waitForFunction(() => window.location.pathname === "/docs/org/guide/deep/c.html");
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/deep/c.html");
    // The row is marked once its folder, guide/deep/, has loaded.
    await expect.poll(() => activePath(tab)).toBe("org/guide/deep/c.html");
    expect(await notice(tab).count()).toBe(0);
  });

  it("opens the offered target with its query and fragment", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    await reserve(tab);
    await post(tab, request);
    await notice(tab).getByRole("button", { name: "Open linked document" }).click();
    await tab.waitForFunction(() => window.location.hash === "#sec");
    expect(await location(tab)).toBe("/docs/org/guide/b.html?docQuery=%3Fv%3D1#sec");
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/b.html?v=1");
  });

  describe("a link to another site", () => {
    const external = { type: "doc-external", path: "guide/a.html", href: "https://outside.test/page?q=1#top" };
    // Opening is observed through window.open: the test never leaves the fixture origin.
    const spyOpen = (tab: Page) => tab.evaluate(() => {
      const calls: unknown[][] = [];
      (window as unknown as { opened: unknown[][] }).opened = calls;
      window.open = (...args: unknown[]) => { calls.push(args); return null; };
    });
    const opened = (tab: Page) => tab.evaluate(() => (window as unknown as { opened: unknown[][] }).opened);

    it("asks first, then opens a new tab that has no handle back to the viewer, leaving the document where it is", async () => {
      const tab = await open("/docs/org/guide/a.html");
      await settled(tab);
      await spyOpen(tab);
      await post(tab, external);
      await notice(tab).waitFor();
      const label = tab.locator("#document-navigation-destination");
      expect(await label.textContent()).toBe("Open external link https://outside.test/page?q=1#top?");
      expect(await notice(tab).getByRole("button", { name: "Open external link" }).getAttribute("aria-describedby")).toBe("document-navigation-destination");
      // Nothing happens until the reader confirms, however often the document asks.
      await post(tab, external);
      await post(tab, { ...external, href: "https://other.test/" });
      expect(await label.textContent()).toBe("Open external link https://outside.test/page?q=1#top?");
      expect(await opened(tab)).toEqual([]);
      const history = (await pushes(tab)).length;
      await notice(tab).getByRole("button", { name: "Open external link" }).click();
      expect(await opened(tab)).toEqual([["https://outside.test/page?q=1#top", "_blank", "noopener,noreferrer"]]);
      expect(await notice(tab).count()).toBe(0);
      expect(await location(tab)).toBe("/docs/org/guide/a.html");
      expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/a.html");
      expect((await pushes(tab)).length).toBe(history);
      // The prompt is free for the next link.
      await post(tab, external);
      await notice(tab).waitFor();
    });

    it("can be dismissed and reviewed, keeping only the latest address, and opens nothing until confirmed", async () => {
      const tab = await open("/docs/org/guide/a.html");
      await settled(tab);
      await spyOpen(tab);
      await post(tab, external);
      await notice(tab).waitFor();
      await notice(tab).getByRole("button", { name: "Dismiss" }).click();
      const review = tab.getByRole("button", { name: "Review external link" });
      await review.waitFor();
      await post(tab, { ...external, href: "https://later.test/" });
      expect(await notice(tab).count()).toBe(0);
      await review.click();
      await notice(tab).waitFor();
      expect(await tab.locator("#document-navigation-destination").textContent()).toBe("Open external link https://later.test/?");
      expect(await opened(tab)).toEqual([]);
      await notice(tab).getByRole("button", { name: "Open external link" }).click();
      expect(await opened(tab)).toEqual([["https://later.test/", "_blank", "noopener,noreferrer"]]);
    });

    it("is replaced by a document the reader picks", async () => {
      const tab = await open("/docs/org/guide/a.html");
      await settled(tab);
      await post(tab, external);
      await notice(tab).waitFor();
      await tab.locator('a.tree-link[href="/legacy-view/org/files/top.html"]').click();
      await tab.waitForFunction(() => window.location.pathname === "/docs/org/top.html");
      expect(await notice(tab).count()).toBe(0);
    });

    it.each([
      ["a same-origin address", { href: "/organizations" }],
      ["the shell's own origin", { href: "PAGE_ORIGIN/other" }],
      ["a mail link", { href: "mailto:someone@outside.test" }],
      ["a script URL", { href: "javascript:alert(1)" }],
      ["a missing address", {}],
      ["a non-string address", { href: 5 }],
      ["an oversized address", { href: `https://outside.test/${"x".repeat(2100)}` }],
    ])("drops %s", async (_name, fields) => {
      const tab = await open("/docs/org/guide/a.html");
      await settled(tab);
      await spyOpen(tab);
      const message = JSON.parse(JSON.stringify({ ...external, ...fields }).replace("PAGE_ORIGIN", harness.origin)) as Record<string, unknown>;
      if (!("href" in fields)) delete message.href;
      await post(tab, message);
      await post(tab, { type: "doc-fragment", path: "guide/a.html", fragment: "#sentinel" });
      await tab.waitForFunction(() => window.location.hash === "#sentinel");
      expect(await notice(tab).count()).toBe(0);
      expect(await opened(tab)).toEqual([]);
    });
  });

  it("drops a prompt, and its stale buttons, when the reader picks another document", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await settled(tab);
    await reserve(tab);
    await post(tab, request);
    await notice(tab).waitFor();
    await tab.evaluate(() => {
      const holder = window as unknown as { staleDismiss: HTMLElement };
      holder.staleDismiss = Array.from(document.querySelectorAll<HTMLElement>("#document-navigation-notice button")).find(button => button.textContent === "Dismiss")!;
    });
    await notice(tab).getByRole("button", { name: "Dismiss" }).click();
    await tab.getByRole("button", { name: "Review linked document" }).waitFor();
    await tab.evaluate(() => {
      (window as unknown as { staleReview: HTMLElement }).staleReview = document.querySelector<HTMLElement>("#document-navigation-review button")!;
    });
    await tab.locator('a.tree-link[href="/legacy-view/org/files/top.html"]').click();
    await tab.waitForFunction(() => window.location.pathname === "/docs/org/top.html");
    expect(await tab.locator("#document-navigation-review").count()).toBe(0);
    await tab.evaluate(() => {
      const holder = window as unknown as { staleDismiss: HTMLElement; staleReview: HTMLElement };
      holder.staleReview.click(); holder.staleDismiss.click();
    });
    expect(await notice(tab).count()).toBe(0);
    expect(await tab.locator("#document-navigation-review").count()).toBe(0);
    expect(await location(tab)).toBe("/docs/org/top.html");
  });
});

describe("lazy tree with scoped documents", () => {
  const treeRequests = () => requests.filter(path => path.includes("/tree"));
  const page = (directory: string, cursor?: string) => `${base}/tree?dir=${encodeURIComponent(directory)}${cursor ? `&cursor=${cursor}` : ""}`;
  const rows = (tab: Page, selector: string) => tab.evaluate(target => Array.from(document.querySelector(target)!.children)
    .filter(row => !row.classList.contains("tree-load-more") && row.id !== "active-indicator")
    .map(row => row.querySelector(".tree-label")!.textContent), selector);

  it("paints the root from one page, reveals a deep link from its folders only and opens the linked document", async () => {
    const tab = await open(`${base}?doc=guide/a.html&docQuery=%3Fv%3D1#top`);
    await tab.waitForFunction(() => document.querySelector(".tree-item.active")?.getAttribute("data-path") === "org/guide/a.html");
    // One root page, then only the deep link's folder: never wide/ or zeta/.
    expect(treeRequests()).toEqual([page(""), page("guide/")]);
    expect(await rows(tab, "#tree-container")).toEqual(["guide", "wide", "zeta", "top"]);
    expect(await rows(tab, '.tree-folder[data-path="org/guide/"] > .tree-folder-collapse > .tree-folder-content')).toEqual(["deep", "a", "b"]);
    expect(await frameSrc(tab)).toBe(`${base}/files/guide/a.html?v=1`);
    await indicatorAt(tab, "org/guide/a.html");
    await folderItem(tab, "org/zeta/").click();
    await item(tab, "org/zeta/z.html").waitFor();
    expect(treeRequests()).toEqual([page(""), page("guide/"), page("zeta/")]);
    await tab.locator(`a.tree-link[href="${base}/files/guide/b.html"]`).click();
    await tab.waitForFunction(() => window.location.search === "?doc=guide%2Fb.html");
    expect(await location(tab)).toBe(`${base}?doc=guide%2Fb.html`);
    expect(await frameSrc(tab)).toBe(`${base}/files/guide/b.html`);
    expect(await activePath(tab)).toBe("org/guide/b.html");
    // Collapsing and re-expanding a loaded folder reads nothing again.
    await folderItem(tab, "org/zeta/").click();
    await folderItem(tab, "org/zeta/").click();
    expect(treeRequests()).toHaveLength(3);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("loads frames and tree pages from the pinned base, keeps history on the shell's URL and shows titles", async () => {
    const tab = await open(`${repoBase}?doc=guide/start.md`);
    await tab.waitForFunction(() => document.querySelector(".tree-item.active")?.getAttribute("data-path") === "docs/guide/start.md");
    expect(treeRequests()).toEqual([`${pinnedBase}/tree?dir=`, `${pinnedBase}/tree?dir=guide%2F`]);
    expect(await frameSrc(tab)).toBe(`${pinnedBase}/files/guide/start.md`);
    // Titles when the page names one; the file name otherwise, including for an empty or non-string title.
    expect(await rows(tab, "#tree-container")).toEqual(["The guide", "Home", "plain.md", "odd.md", "Extra"]);
    expect(await rows(tab, '.tree-folder[data-path="docs/guide/"] > .tree-folder-collapse > .tree-folder-content')).toEqual(["Getting started"]);
    await tab.locator(`a.tree-link[href="${pinnedBase}/files/index.md"]`).click();
    await tab.waitForFunction(() => window.location.search === "?doc=index.md");
    expect(await location(tab)).toBe(`${repoBase}?doc=index.md`);
    expect(await frameSrc(tab)).toBe(`${pinnedBase}/files/index.md`);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("pages a large folder on request, from the mouse and the keyboard, without duplicate rows", async () => {
    const tab = await open(base);
    await folderItem(tab, "org/wide/").click();
    await item(tab, "org/wide/w2.html").waitFor();
    const more = tab.locator('.tree-folder[data-path="org/wide/"] .load-more-btn');
    expect(await rows(tab, '.tree-folder[data-path="org/wide/"] > .tree-folder-collapse > .tree-folder-content')).toEqual(["w1", "w2"]);
    await more.click();
    await item(tab, "org/wide/w3.html").waitFor();
    await more.focus();
    await tab.keyboard.press("Enter");
    await item(tab, "org/wide/w4.html").waitFor();
    expect(await rows(tab, '.tree-folder[data-path="org/wide/"] > .tree-folder-collapse > .tree-folder-content')).toEqual(["w1", "w2", "w3", "w4"]);
    expect(await more.count()).toBe(0);
    expect(treeRequests()).toEqual([page(""), page("wide/"), page("wide/", "1"), page("wide/", "2")]);
  });

  it("loads only the deep-linked folder's later pages to reveal a document beyond the first page", async () => {
    const tab = await open(`${base}?doc=wide/w4.html`);
    await tab.waitForFunction(() => document.querySelector(".tree-item.active")?.getAttribute("data-path") === "org/wide/w4.html");
    await indicatorAt(tab, "org/wide/w4.html");
    expect(treeRequests()).toEqual([page(""), page("wide/"), page("wide/", "1"), page("wide/", "2")]);
    expect(await tab.locator('.tree-folder[data-path="org/wide/"] .load-more-btn').count()).toBe(0);
  });

  it("pages the root, and reveals deep links into later root pages", async () => {
    const tab = await open(pagedBase);
    await folderItem(tab, "org/a/").waitFor();
    expect(await rows(tab, "#tree-container")).toEqual(["a"]);
    await tab.locator("#tree-container > .tree-load-more .load-more-btn").click();
    await item(tab, "org/later.html").waitFor();
    expect(await rows(tab, "#tree-container")).toEqual(["a", "b", "later"]);
    expect(await tab.locator("#tree-container > .tree-load-more").count()).toBe(0);
    // Later root folders keep root depth and expand normally.
    expect(await tab.locator('.tree-folder[data-path="org/b/"]').getAttribute("data-depth")).toBe("0");
    await folderItem(tab, "org/b/").click();
    await item(tab, "org/b/inner.html").waitFor();

    const deep = await open(`${pagedBase}?doc=b/inner.html`);
    await deep.waitForFunction(() => document.querySelector(".tree-item.active")?.getAttribute("data-path") === "org/b/inner.html");
    await indicatorAt(deep, "org/b/inner.html");
    expect(requests.filter(path => path.startsWith(`${pagedBase}/tree`)).slice(-3)).toEqual([
      `${pagedBase}/tree?dir=`, `${pagedBase}/tree?dir=&cursor=1`, `${pagedBase}/tree?dir=b%2F`,
    ]);
  });

  it("leaves a deep link unrevealed when a later page fails or repeats its cursor", async () => {
    const failing = await open(`${base}?doc=wide/w4.html`, { routes: async tab => { await tab.route(`**${base}/tree?dir=wide%2F&cursor=1`, route => route.fulfill({ status: 502, body: "{}" })); } });
    await failing.waitForFunction(() => !!document.getElementById("content-frame")!.getAttribute("src"));
    await item(failing, "org/wide/w2.html").waitFor();
    await failing.waitForFunction(() => document.querySelector('.tree-folder[data-path="org/wide/"] .load-more-btn')?.textContent === "Load more...");
    expect(await activePath(failing)).toBeNull();
    expect(pageErrors(failing)).toEqual([]);

    let repeated = 0;
    const looping = await open(`${base}?doc=wide/missing.html`, { routes: async tab => {
      await tab.route(`**${base}/tree?dir=wide%2F*`, route => { repeated += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ children: [doc(`r${repeated}.html`)], cursor: "1" }) }); });
    } });
    await item(looping, "org/wide/r2.html").waitFor();
    expect(repeated).toBe(2);
    expect(await activePath(looping)).toBeNull();
    expect(pageErrors(looping)).toEqual([]);
  });

  it.each([
    ["an HTTP failure", { status: 500, body: "{}" }],
    ["a non-array page", { status: 200, body: JSON.stringify({ children: "nope" }) }],
    ["a legacy document list", { status: 200, body: JSON.stringify({ documents: ["top.html"], cursor: null }) }],
    ["a null child", { status: 200, body: JSON.stringify({ children: [null] }) }],
    ["a nested child name", { status: 200, body: JSON.stringify({ children: [{ name: "a/b.html", type: "file" }] }) }],
    ["a dot-segment child", { status: 200, body: JSON.stringify({ children: [{ name: "..", type: "folder" }] }) }],
    ["an empty child name", { status: 200, body: JSON.stringify({ children: [{ name: "", type: "file" }] }) }],
    ["an unknown child type", { status: 200, body: JSON.stringify({ children: [{ name: "x.html", type: "link" }] }) }],
  ])("shows a retryable error after %s and recovers", async (_name, failure) => {
    let fail = true;
    const scoped = await open(base, { routes: async page => { await page.route(`**${base}/tree*`, route => fail ? route.fulfill({ ...failure, contentType: "application/json" }) : route.continue()); } });
    const error = scoped.locator("#tree-container .tree-error");
    await error.waitFor();
    expect(await error.getAttribute("role")).toBe("alert");
    expect(await error.textContent()).toContain("Failed to load documents.");
    expect(await scoped.locator("#tree-container").getAttribute("aria-busy")).toBeNull();
    fail = false;
    await error.getByRole("button", { name: "Retry" }).click();
    await item(scoped, "org/top.html").waitFor();
    expect(await error.count()).toBe(0);
  });

  it("treats a missing or malformed cursor as the last page", async () => {
    const fetched: string[] = [];
    const single = await open(base, { routes: async page => { await page.route(`**${base}/tree*`, route => { fetched.push(route.request().url()); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ children: [doc("only.html")], cursor: 7 }) }); }); } });
    await item(single, "org/only.html").waitFor();
    expect(fetched).toHaveLength(1);
    expect(await single.locator(".load-more-btn").count()).toBe(0);
  });

  it.each([
    ["/lt/base-empty-project", "No documents deployed yet.", "/organizations/o/projects/q"],
    ["/lt/base-empty-other", "No documents available.", null],
    ["/lt/legacy-empty", "No documents yet.", null],
  ])("explains an empty tree at %s", async (path, message, returnTo) => {
    const tab = await open(path);
    await tab.locator("#tree-container .tree-empty").waitFor();
    expect(await tab.locator("#tree-container .tree-empty").textContent()).toBe(message);
    const link = tab.locator("#tree-container .tree-empty-create a");
    expect(await link.count()).toBe(returnTo ? 1 : 0);
    if (returnTo) {
      expect(await link.getAttribute("href")).toBe(returnTo);
      expect(await link.textContent()).toBe("Return to project");
    }
    expect(await tab.locator("#active-indicator").count()).toBe(1);
    if (returnTo) {
      // The tree must leave the link's navigation alone. Stay on the page so
      // its browser coverage is kept: observe the click after the tree saw it.
      await tab.evaluate(() => document.addEventListener("click", event => {
        (window as unknown as { linkFollowed: boolean }).linkFollowed = !event.defaultPrevented;
        event.preventDefault();
      }));
      await link.click();
      expect(await tab.evaluate(() => (window as unknown as { linkFollowed?: boolean }).linkFollowed)).toBe(true);
    }
  });

  it("falls back to an empty tree when a folder lies outside the scoped organization", async () => {
    const tab = await open(base);
    await item(tab, "org/top.html").waitFor();
    await tab.evaluate(() => {
      const outside = document.createElement("div"); outside.className = "tree-folder"; outside.dataset.path = "elsewhere/x/";
      outside.innerHTML = '<div class="tree-item" role="button" id="outside-item"><span class="folder-icon">folder</span></div><div class="tree-folder-collapse"><div class="tree-folder-content"></div></div>';
      document.getElementById("tree-container")!.append(outside);
    });
    await tab.locator("#outside-item").click();
    await tab.waitForFunction(() => document.querySelector('.tree-folder[data-path="elsewhere/x/"]')!.classList.contains("loaded"));
    expect(await tab.locator('.tree-folder[data-path="elsewhere/x/"] .tree-item').count()).toBe(1);
  });
});

describe("lazy tree active indicator", () => {
  const frames = (tab: Page) => tab.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const misplace = (tab: Page) => tab.evaluate(() => { document.getElementById("active-indicator")!.style.transform = "translate(0px, 0px)"; });
  const misplaced = (tab: Page) => tab.evaluate(() => document.getElementById("active-indicator")!.style.transform === "translate(0px, 0px)");
  const dispatch: Record<string, () => void> = {
    resize: () => window.dispatchEvent(new Event("resize")),
    "shell layout": () => document.dispatchEvent(new Event("rendro:shell-layout")),
    "sidebar scroll": () => document.querySelector(".sidebar-tree")!.dispatchEvent(new Event("scroll")),
    "sidebar transition": () => document.querySelector(".sidebar")!.dispatchEvent(new Event("transitionend", { bubbles: true })),
    "resizer transition": () => document.querySelector(".sidebar-resizer")!.dispatchEvent(new Event("transitionend", { bubbles: true })),
  };

  it.each(Object.keys(dispatch))("re-aligns the indicator after a %s", async name => {
    const tab = await open("/docs/org/guide/a.html");
    await tab.waitForFunction(() => document.querySelector(".tree-item.active") !== null);
    await indicatorAt(tab, "org/guide/a.html");
    await misplace(tab);
    await tab.evaluate(`(${dispatch[name].toString()})()`);
    await tab.waitForFunction(() => document.getElementById("active-indicator")!.style.transform !== "translate(0px, 0px)");
    await indicatorAt(tab, "org/guide/a.html");
  });

  it("re-aligns immediately when a folder's own transition ends, and ignores unrelated transitions", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await tab.waitForFunction(() => document.querySelector(".tree-item.active") !== null);
    await misplace(tab);
    await tab.evaluate(() => {
      const tree = document.getElementById("tree-container")!;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const other = document.createElement("div");
      tree.append(svg, other);
      for (const target of [svg, other, document.querySelector(".sidebar-tree")!]) target.dispatchEvent(new Event("transitionend", { bubbles: true }));
      const outside = document.createElement("div"); outside.className = "sidebar";
      document.body.append(outside);
      const unrelated = document.createElementNS("http://www.w3.org/2000/svg", "svg"); document.body.append(unrelated);
      unrelated.dispatchEvent(new Event("transitionend", { bubbles: true }));
      document.createElement("div").dispatchEvent(new Event("transitionend", { bubbles: true }));
      const plain = document.createElement("div"); document.body.append(plain);
      plain.dispatchEvent(new Event("transitionend", { bubbles: true }));
    });
    await frames(tab);
    expect(await misplaced(tab)).toBe(true);
    await tab.evaluate(() => document.querySelector(".tree-folder-collapse")!.dispatchEvent(new Event("transitionend", { bubbles: true })));
    expect(await misplaced(tab)).toBe(false);
    await indicatorAt(tab, "org/guide/a.html");
  });

  it("hides the indicator while the active document's folder is collapsed and restores it on re-expansion", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await tab.waitForFunction(() => document.querySelector(".tree-item.active") !== null);
    await indicatorAt(tab, "org/guide/a.html");
    await folderItem(tab, "org/guide/").click();
    expect(await tab.evaluate(() => document.getElementById("active-indicator")!.style.opacity)).toBe("0");
    await folderItem(tab, "org/guide/").click();
    await indicatorAt(tab, "org/guide/a.html");
  });

  it("animates the indicator unless motion is reduced, even when the browser cannot report the preference", async () => {
    const reduced = await open("/docs/org/guide/a.html");
    await reduced.waitForFunction(() => document.querySelector(".tree-item.active") !== null);
    expect(await reduced.evaluate(() => document.getElementById("active-indicator")!.style.transition)).toBe("none");
    const unknown = await open("/lt/legacy-no-matchmedia");
    await unknown.waitForFunction(() => document.querySelector(".tree-item.active") !== null);
    expect(await unknown.evaluate(() => document.getElementById("active-indicator")!.style.transition)).toContain("transform 0.3s");
    expect(await unknown.evaluate(() => typeof window.matchMedia)).toBe("undefined");
  });

  it("keeps selecting documents when the indicator element is gone", async () => {
    const tab = await open("/docs/org/guide/a.html");
    await tab.waitForFunction(() => document.querySelector(".tree-item.active") !== null);
    await tab.evaluate(() => document.getElementById("active-indicator")!.remove());
    await tab.locator('a.tree-link[href="/legacy-view/org/files/guide/b.html"]').click();
    expect(await activePath(tab)).toBe("org/guide/b.html");
    expect(await tab.locator("#active-indicator").count()).toBe(0);
    expect(pageErrors(tab)).toEqual([]);
  });
});

describe("lazy tree races and malformed shells", () => {
  it("drops a fragment report that was queued before the reader opened another document", async () => {
    const tab = await open("/docs/org/guide/a.html", { clock: true });
    await settled(tab);
    const initial = (await pushes(tab)).length;
    await post(tab, { type: "doc-fragment", path: "guide/a.html", fragment: "#one" });
    await expect.poll(async () => (await pushes(tab)).length).toBe(initial + 1);
    await post(tab, { type: "doc-fragment", path: "guide/a.html", fragment: "#two" });
    // Wait until the second report is accepted, then navigate before its trailing flush.
    await tab.waitForFunction(() => true);
    await tab.locator('a.tree-link[href="/legacy-view/org/files/guide/b.html"]').click();
    await tab.clock.runFor(150);
    expect(await location(tab)).toBe("/docs/org/guide/b.html");
    expect((await pushes(tab)).some(entry => entry.endsWith("#two"))).toBe(false);
  });

  it("shows the newest document when its folder is still loading for an earlier navigation", async () => {
    const tab = await open("/docs/org/guide/deep/c.html", { routes: async page => { await page.route("**/api/tree/org?prefix=org%2Fguide%2F&*", () => new Promise(() => {})); } });
    await tab.waitForFunction(() => document.querySelector('.tree-folder[data-path="org/guide/"]')?.classList.contains("loading"));
    await tab.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate", { state: { docPath: "org/guide/b.html" } })));
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/b.html");
    expect(pageErrors(tab)).toEqual([]);
  });

  it("marks the newest document, not the earlier one, once a folder they share has loaded", async () => {
    let hold!: Awaited<ReturnType<typeof held>>;
    const tab = await open("/docs/org/guide/deep/c.html", { routes: async page => { hold = await held(page, "**/api/tree/org?prefix=org%2Fguide%2F&*"); } });
    await hold.seen;
    await tab.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate", { state: { docPath: "org/guide/b.html" } })));
    await hold.release();
    // The earlier reveal still finishes loading its own folder, but leaves the selection alone.
    await item(tab, "org/guide/deep/c.html").waitFor();
    await expect.poll(() => activePath(tab)).toBe("org/guide/b.html");
    expect(await tab.locator(".tree-item.active").count()).toBe(1);
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/guide/b.html");
    await indicatorAt(tab, "org/guide/b.html");
    expect(pageErrors(tab)).toEqual([]);
  });

  it("keeps working when folder rows are missing their icon, content or depth", async () => {
    const tab = await open("/lt/legacy");
    await item(tab, "org/top.html").waitFor();
    await tab.evaluate(() => {
      const tree = document.getElementById("tree-container")!;
      const bare = document.createElement("div"); bare.className = "tree-folder"; bare.dataset.path = "org/guide/extra/";
      bare.innerHTML = '<div class="tree-item" role="button" id="bare-item"></div><div class="tree-folder-collapse"><div class="tree-folder-content"></div></div>';
      const hollow = document.createElement("div"); hollow.className = "tree-folder open"; hollow.dataset.path = "org/hollow/";
      hollow.innerHTML = '<div class="tree-item" role="button" id="hollow-item"></div>';
      const lonely = document.createElement("div"); lonely.className = "tree-load-more"; lonely.innerHTML = '<button class="load-more-btn" id="lonely">Load more...</button>';
      const content = bare.querySelector(".tree-folder-content")!;
      content.append(document.createElement("div"), document.createElementNS("http://www.w3.org/2000/svg", "svg"));
      content.firstElementChild!.className = "junk";
      tree.append(bare, hollow, lonely);
    });
    await tab.locator("#bare-item").click();
    await item(tab, "org/guide/extra/d.html").waitFor();
    expect(await tab.locator("#bare-item").getAttribute("aria-expanded")).toBe("true");
    expect(await tab.locator('.tree-folder[data-path="org/guide/extra/"]').getAttribute("class")).toContain("open");
    // Row indexes are set only on rows that hold items.
    expect(await tab.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.tree-folder[data-path="org/guide/extra/"] .tree-item')).map(el => el.style.getPropertyValue("--tree-index")))).toEqual(["", "0"]);
    await tab.locator("#hollow-item").click();
    expect(await tab.locator('.tree-folder[data-path="org/hollow/"]').getAttribute("class")).not.toContain("open");
    await tab.locator("#lonely").click();
    expect(await tab.locator("#lonely").textContent()).toBe("Load more...");
    // A document under a folder that cannot open still loads, without marking a row.
    await tab.evaluate(() => {
      const shut = document.createElement("div"); shut.className = "tree-folder"; shut.dataset.path = "org/shut/";
      shut.innerHTML = '<div class="tree-item" role="button"></div>';
      document.getElementById("tree-container")!.append(shut);
      window.dispatchEvent(new PopStateEvent("popstate", { state: { docPath: "org/shut/x.html" } }));
    });
    expect(await frameSrc(tab)).toBe("/legacy-view/org/files/shut/x.html");
    expect(await tab.locator('.tree-folder[data-path="org/shut/"]').getAttribute("class")).not.toContain("open");
    expect(await activePath(tab)).toBeNull();
    expect(pageErrors(tab)).toEqual([]);
  });

  it("ignores clicks on the root error text and reloads the list from its Retry button", async () => {
    let fail = true;
    const tab = await open("/lt/legacy", { routes: async page => { await page.route("**/api/tree/org?prefix=org%2F&limit=1000", route => fail ? route.fulfill({ status: 500, body: "{}" }) : route.continue()); } });
    const error = tab.locator("#tree-container .tree-error");
    await error.waitFor();
    expect(await error.textContent()).toContain("Failed to load documents.");
    await tab.locator("#tree-container .tree-error").click({ position: { x: 4, y: 4 } });
    expect(await error.count()).toBe(1);
    fail = false;
    const retry = error.getByRole("button", { name: "Retry" });
    await retry.click();
    await item(tab, "org/top.html").waitFor();
    expect(await error.count()).toBe(0);
    expect(await tab.locator("#tree-container").getAttribute("aria-busy")).toBeNull();
  });

  it.each(["empty-org-initial", "no-org-attr"])("ignores every frame message and still shows the frame in %s", async name => {
    const tab = await open(`/lt/${name}`);
    await tab.waitForFunction(() => !!document.getElementById("content-frame")!.getAttribute("src"));
    await settled(tab);
    const initial = (await pushes(tab)).length;
    for (const payload of [
      { type: "doc-loaded", path: "y.html", search: "", fragment: "" },
      { type: "doc-navigate", path: "guide/b.html", search: "", fragment: "" },
      { type: "doc-fragment", path: "y.html", fragment: "#x" },
    ]) await post(tab, payload);
    await tab.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 150)));
    expect((await pushes(tab)).length).toBe(initial);
    expect(await frameSrc(tab)).toBe("/legacy-view//files/");
    expect(await tab.locator("#document-navigation-notice").count()).toBe(0);
    expect(pageErrors(tab)).toEqual([]);
  });
});

describe("lazy tree instant navigation (#245)", () => {
  const indexHref = `${pinnedBase}/files/index.md`;
  const plainHref = `${pinnedBase}/files/plain.md`;
  const startHref = `${pinnedBase}/files/guide/start.md`;
  const oddHref = `${pinnedBase}/files/odd.md`;
  const extraHref = `${pinnedBase}/files/extra.md`;
  const link = (tab: Page, href: string) => tab.locator(`a.tree-link[href="${href}"]`);
  const inPool = (href: string) => `document.querySelector('iframe[data-preload=${JSON.stringify(href)}]')`;
  const poolSize = (tab: Page) => tab.locator("iframe[data-preload]").count();
  const frameHrefCount = (href: string) => requests.filter(path => path === href).length;
  const measures = (tab: Page) => tab.evaluate(() => performance.getEntriesByName("rendro:frame-switch").length);
  const waitForPreloaded = (tab: Page, href: string) => tab.waitForFunction(
    `!!${inPool(href)} && ${inPool(href)}.dataset.state === "ready"`);
  const openRepo = (options: Options = {}) => open(`${repoBase}?doc=guide/start.md`, options);

  it("adopts a preload with no second request, a view transition, and an under-budget switch", async () => {
    const tab = await openRepo({ motion: true });
    await link(tab, indexHref).waitFor();
    await tab.evaluate(() => {
      const holder = window as unknown as { vt: string[] };
      holder.vt = [];
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = function (this: Document, update: () => void) {
        holder.vt.push(typeof update);
        return original(update);
      };
    });
    await link(tab, indexHref).hover();
    await waitForPreloaded(tab, indexHref);
    expect(frameHrefCount(indexHref)).toBe(1);
    const before = await measures(tab);
    await link(tab, indexHref).click();
    await tab.waitForFunction(n => performance.getEntriesByName("rendro:frame-switch").length > n, before);
    expect(await frameSrc(tab)).toBe(indexHref);
    // Adoption revealed the same browsing context: the document is not fetched again.
    expect(frameHrefCount(indexHref)).toBe(1);
    expect(await tab.evaluate(() => (window as unknown as { vt: string[] }).vt)).toEqual(["function"]);
    const duration = await tab.evaluate(() => performance.getEntriesByName("rendro:frame-switch").at(-1)!.duration);
    expect(duration).toBeLessThan(200);
    // The preload slot is empty: the reader's frame is the preloaded element.
    expect(await poolSize(tab)).toBe(0);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("loads the document normally when the reader clicks a link that was not preloaded", async () => {
    const tab = await openRepo();
    await link(tab, indexHref).waitFor();
    const before = await measures(tab);
    await tab.evaluate(href => (document.querySelector(`a.tree-link[href="${href}"]`) as HTMLElement).click(), indexHref);
    await tab.waitForFunction(n => performance.getEntriesByName("rendro:frame-switch").length > n, before);
    expect(await frameSrc(tab)).toBe(indexHref);
    expect(frameHrefCount(indexHref)).toBe(1);
    expect(await poolSize(tab)).toBe(0);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("falls back to a normal load when the preload fails", async () => {
    let first = true;
    const tab = await openRepo({ routes: async page => {
      await page.route(`**${plainHref}`, route => { if (first) { first = false; return route.abort(); } return route.continue(); });
    } });
    await link(tab, plainHref).waitFor();
    await link(tab, plainHref).hover();
    await tab.waitForFunction(href => !!document.querySelector(`iframe[data-preload="${href}"]`), plainHref);
    await link(tab, plainHref).click();
    await settled(tab);
    expect(await frameSrc(tab)).toBe(plainHref);
    expect(await tab.locator("html").getAttribute("class") ?? "").not.toContain("doc-loading-error");
    expect(await poolSize(tab)).toBe(0);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("keeps only the newest preloads in flight", async () => {
    const tab = await openRepo();
    await link(tab, indexHref).waitFor();
    await link(tab, indexHref).hover();
    await link(tab, plainHref).hover();
    await link(tab, oddHref).hover();
    await tab.waitForFunction(() => document.querySelectorAll("iframe[data-preload]").length === 3);
    await link(tab, extraHref).hover();
    await tab.waitForFunction(href => !document.querySelector(`iframe[data-preload="${href}"]`), indexHref);
    expect(await poolSize(tab)).toBe(3);
    expect(await tab.locator(`iframe[data-preload="${extraHref}"]`).count()).toBe(1);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("preloads on keyboard focus and ignores rows that are not frame links", async () => {
    const tab = await openRepo();
    await link(tab, indexHref).waitFor();
    await link(tab, indexHref).focus();
    await tab.waitForFunction(href => !!document.querySelector(`iframe[data-preload="${href}"]`), indexHref);
    await tab.evaluate(() => {
      const tree = document.getElementById("tree-container")!;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const plainRow = document.createElement("div");
      plainRow.className = "tree-item";
      tree.append(svg, plainRow);
      svg.dispatchEvent(new Event("pointerover", { bubbles: true }));
      plainRow.dispatchEvent(new Event("pointerover", { bubbles: true }));
      const foreign = document.createElement("div");
      foreign.className = "tree-item";
      foreign.innerHTML = '<a class="tree-link" target="content-frame" href="https://outside.test/x.md">foreign</a>';
      const noHref = document.createElement("div");
      noHref.className = "tree-item";
      noHref.innerHTML = '<a class="tree-link" target="content-frame">no href</a>';
      tree.append(foreign, noHref);
      document.querySelector<HTMLElement>('a.tree-link[href="https://outside.test/x.md"]')!.dispatchEvent(new Event("pointerover", { bubbles: true }));
      document.querySelector<HTMLElement>("a.tree-link:not([href])")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(frameHrefCount(indexHref)).toBe(1);
    expect(await poolSize(tab)).toBe(1);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("keeps the plain click-to-load path on a metered or slow connection", async () => {
    const saveData = await openRepo({ init: "Object.defineProperty(navigator,'connection',{value:{saveData:true},configurable:true})" });
    await link(saveData, indexHref).waitFor();
    await link(saveData, indexHref).hover();
    await link(saveData, indexHref).focus();
    expect(await poolSize(saveData)).toBe(0);
    expect(frameHrefCount(indexHref)).toBe(0);
    await link(saveData, indexHref).click();
    await settled(saveData);
    expect(await frameSrc(saveData)).toBe(indexHref);
    expect(frameHrefCount(indexHref)).toBe(1);
    expect(pageErrors(saveData)).toEqual([]);

    const slow = await openRepo({ init: "Object.defineProperty(navigator,'connection',{value:{effectiveType:'2g'},configurable:true})" });
    await link(slow, indexHref).waitFor();
    await link(slow, indexHref).hover();
    expect(await poolSize(slow)).toBe(0);
    expect(pageErrors(slow)).toEqual([]);
  });

  it("swaps without a view transition when motion is reduced or the API is missing", async () => {
    const reduced = await openRepo();
    await link(reduced, indexHref).waitFor();
    await reduced.evaluate(() => {
      const holder = window as unknown as { vt: number };
      holder.vt = 0;
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = function (this: Document, update: () => void) { holder.vt += 1; return original(update); };
    });
    await link(reduced, indexHref).hover();
    await waitForPreloaded(reduced, indexHref);
    await link(reduced, indexHref).click();
    await settled(reduced);
    expect(await reduced.evaluate(() => (window as unknown as { vt: number }).vt)).toBe(0);

    const missing = await openRepo({ motion: true });
    await link(missing, indexHref).waitFor();
    await missing.evaluate(() => { Reflect.deleteProperty(document, "startViewTransition"); });
    await link(missing, indexHref).hover();
    await waitForPreloaded(missing, indexHref);
    await link(missing, indexHref).click();
    await settled(missing);
    expect(await frameSrc(missing)).toBe(indexHref);
    expect(pageErrors(reduced)).toEqual([]);
    expect(pageErrors(missing)).toEqual([]);
  });

  it("settles the newest preload when two links are opened in the same frame", async () => {
    const tab = await openRepo();
    await link(tab, indexHref).waitFor();
    await link(tab, indexHref).hover();
    await link(tab, plainHref).hover();
    await waitForPreloaded(tab, indexHref);
    await waitForPreloaded(tab, plainHref);
    await tab.evaluate(([first, second]) => {
      (document.querySelector(`a.tree-link[href="${first}"]`) as HTMLElement).click();
      (document.querySelector(`a.tree-link[href="${second}"]`) as HTMLElement).click();
    }, [indexHref, plainHref]);
    await tab.waitForFunction(href => document.getElementById("content-frame")!.getAttribute("src") === href, plainHref);
    await tab.waitForFunction(() => !document.getElementById("content-frame")!.hasAttribute("aria-busy")
      && performance.getEntriesByName("rendro:frame-switch").length > 0);
    expect(await frameSrc(tab)).toBe(plainHref);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("preloads into the content area even once the reader's frame is gone", async () => {
    const tab = await openRepo();
    await link(tab, indexHref).waitFor();
    await tab.evaluate(() => document.getElementById("content-frame")!.remove());
    await link(tab, indexHref).hover();
    await tab.waitForFunction(href => {
      const frame = document.querySelector(`iframe[data-preload="${href}"]`);
      return !!frame && frame.parentElement === document.body && !frame.hasAttribute("sandbox");
    }, indexHref);
    expect(frameHrefCount(indexHref)).toBe(1);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("does not re-warm the document the reader is already showing, and titles a frame that has none", async () => {
    const tab = await openRepo();
    await link(tab, indexHref).waitFor();
    await link(tab, indexHref).hover();
    await waitForPreloaded(tab, indexHref);
    await tab.evaluate(() => document.getElementById("content-frame")!.removeAttribute("title"));
    await link(tab, indexHref).click();
    await settled(tab);
    await tab.waitForFunction(href => document.getElementById("content-frame")!.getAttribute("src") === href, indexHref);
    expect(await tab.locator("#content-frame").getAttribute("title")).toBe("Document content");
    await tab.evaluate(href => document.querySelector<HTMLElement>(`a.tree-link[href="${href}"]`)!.dispatchEvent(new Event("pointerover", { bubbles: true })), indexHref);
    await tab.waitForFunction(() => performance.getEntriesByName("rendro:frame-switch").length > 0);
    expect(await poolSize(tab)).toBe(0);
    expect(frameHrefCount(indexHref)).toBe(1);
    expect(pageErrors(tab)).toEqual([]);
  });

  it("keeps the visible frame, URL and selection agreeing through Back and Forward after a swap", async () => {
    const tab = await openRepo();
    await link(tab, indexHref).waitFor();
    await link(tab, indexHref).hover();
    await waitForPreloaded(tab, indexHref);
    await link(tab, indexHref).click();
    await settled(tab);
    await tab.waitForFunction(target => document.getElementById("content-frame")!.getAttribute("src") === target, indexHref);
    expect(await tab.locator("iframe#content-frame").count()).toBe(1);
    // Back returns to the document the reader started on.
    await tab.goBack();
    await settled(tab);
    await tab.waitForFunction(target => document.getElementById("content-frame")!.getAttribute("src") === target, startHref);
    expect(tab.url()).toContain("doc=guide/start.md");
    expect(await activePath(tab)).toBe("docs/guide/start.md");
    expect(await tab.locator("#content-frame").getAttribute("name")).toBe("content-frame");
    // Forward returns to the document that was adopted by a swap.
    await tab.goForward();
    await settled(tab);
    await tab.waitForFunction(target => document.getElementById("content-frame")!.getAttribute("src") === target, indexHref);
    expect(tab.url()).toContain("doc=index.md");
    expect(await activePath(tab)).toBe("docs/index.md");
    expect(await tab.locator("#content-frame").getAttribute("name")).toBe("content-frame");
    expect(pageErrors(tab)).toEqual([]);
  });

  it("settles the reveal when the view transition update rejects", async () => {
    const tab = await openRepo({ motion: true });
    await link(tab, indexHref).waitFor();
    await tab.evaluate(() => {
      (document as unknown as { startViewTransition: (update: () => void) => { updateCallbackDone: Promise<unknown> } }).startViewTransition =
        (update: () => void) => { update(); return { updateCallbackDone: Promise.reject(new Error("view transition failed")) }; };
    });
    await link(tab, indexHref).hover();
    await waitForPreloaded(tab, indexHref);
    await link(tab, indexHref).click();
    await settled(tab);
    expect(await frameSrc(tab)).toBe(indexHref);
    expect(await measures(tab)).toBeGreaterThan(0);
    expect(pageErrors(tab)).toEqual([]);
  });
});
