import type { Frame, FrameLocator, Page } from "playwright";
import { expect } from "vitest";
import type { CommentLab } from "../fixtures/comment-lab-browser";
import { bundleBrowserAsset, createBrowserHarness } from "./browser";

/** A repository's docs (#254): the shell at the repository base, its frames below `files/`. */
export const docsBase = "/r/acme/docs";
export const docPath = `${docsBase}/files/index.html`;
export const LAB_REPO_ID = 9101;
export const LAB_BLOB = "b".repeat(40);
/** A repository anchor on unique text of the lab document: found by its quote (the offset is left to the search). */
export function anchorOn(exact: string, headingSlug = "title") {
  return { kind: "repo-text", blobSha: LAB_BLOB, headingSlug, prefix: "", exact, suffix: "", offset: 0 };
}
export const defaultDocument = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:16px/24px sans-serif}main{padding:24px;width:520px}p{margin:0 0 16px}
</style></head><body><main><h1 id="title">Quarterly report</h1>
<p id="intro">The quick brown fox jumps over the lazy dog and keeps running across the open field until the sentence wraps over several lines of the document.</p>
<p id="second">Second <b>bold</b> paragraph   with   spaced text.</p>
<ul id="list"><li>Alpha</li><li>Beta</li></ul>
<button id="publisher-button" type="button">Publisher action</button>
<div style="height:1600px"></div><p id="footer">Footer text far below</p></main></body></html>`;

export type LabOptions = {
  width?: number; height?: number; canWrite?: boolean; sandbox?: boolean; user?: string; document?: string;
  motion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark"; storage?: boolean;
  /** Install the real shell behaviour behind the Reload notice (a Reload press reloads the page). */
  viewerShell?: boolean;
  /** Refuse the widget script, as an extension, network failure or content blocker would. */
  blockWidget?: boolean;
  /** Runs in every frame before any script of the page does. */
  init?: () => void;
};

/** One server and browser per test file: parent shell with the real host, publisher document with the real widget. */
export function useCommentLab() {
  const harness = createBrowserHarness();
  let document = defaultDocument;
  let canWrite = true;
  let config: Record<string, unknown> | null | undefined;
  let deferred = true;
  return {
    harness,
    /** Reconfigure the server for documents loaded from now on. */
    setCanWrite(value: boolean) { canWrite = value; },
    /** `null` omits the page's configuration script entirely; `undefined` restores the default. */
    setConfig(value: Record<string, unknown> | null | undefined) { config = value; },
    /** Production loads the widget with `defer`; a synchronous script boots while the page is still parsing. */
    setDeferred(value: boolean) { deferred = value; },
    async start() {
      const assets = new Map([
        ["/commentor.js", await bundleBrowserAsset("src/commentor/commentor.ts")],
        ["/lab.js", await bundleBrowserAsset("tests/fixtures/comment-lab-browser.ts")],
      ]);
      await harness.start((request, response) => {
        const url = new URL(request.url!, "http://localhost");
        response.setHeader("Cache-Control", "no-store");
        if (url.pathname.startsWith(`${docsBase}/files/`)) {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          // As the read path embeds it (#254): the configuration rides on the widget's own script element.
          const value = config === undefined
            ? { transport: "parent", repoId: LAB_REPO_ID, blobSha: LAB_BLOB, documentPath: url.pathname.slice(docsBase.length + "/files/".length) }
            : config;
          const attribute = value ? ` data-commentor-config="${JSON.stringify(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` : "";
          response.end(document.replace("</body>", `<script ${deferred ? "defer " : ""}src="/commentor.js"${attribute}></script></body>`));
        } else if (url.pathname === docsBase) {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          const sandbox = url.searchParams.has("sandbox") ? ' sandbox="allow-scripts allow-forms allow-popups allow-downloads"' : "";
          // The read path says who may write; the lab's shell passes the test's choice to the host.
          response.end(`<!doctype html><html><body style="margin:0"><iframe id="content-frame"${sandbox} src="${docPath}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe><div id="viewer-update-notice" hidden style="position:fixed;z-index:100;top:12px;right:12px;background:#fff"><span role="status"></span><button type="button">Reload</button></div><script src="/lab.js${canWrite ? "" : "?readonly"}"></script></body></html>`);
        } else {
          response.writeHead(404).end();
        }
      }, assets);
    },
    async open(options: LabOptions = {}) {
      document = options.document ?? defaultDocument;
      canWrite = options.canWrite ?? true;
      const page = await harness.newPage({
        viewport: { width: options.width ?? 1024, height: options.height ?? 800 },
        reducedMotion: options.motion ?? "reduce", colorScheme: options.colorScheme ?? "light",
      });
      if (options.blockWidget) await page.route("**/commentor.js", route => route.abort("blockedbyclient"));
      if (options.init) await page.addInitScript(options.init);
      const params = new URLSearchParams();
      if (options.sandbox) params.set("sandbox", "");
      if (options.viewerShell) params.set("viewer", "");
      if (options.user !== undefined) params.set("user", options.user);
      await page.goto(`${harness.origin}${docsBase}?${params}`);
      return new Lab(page);
    },
  };
}

export class Lab {
  readonly ui: FrameLocator;
  constructor(readonly page: Page) { this.ui = page.frameLocator("#content-frame"); }
  get frame(): Frame { return this.page.frames().find(frame => frame !== this.page.mainFrame())!; }
  /** Run in the parent shell, next to the real host and in-memory backend. */
  host<T, A = undefined>(action: (lab: CommentLab, arg: A) => T, arg?: A): Promise<Awaited<T>> {
    return this.page.evaluate(`(${action.toString()})(window.lab, ${JSON.stringify(arg ?? null)})`) as Promise<Awaited<T>>;
  }
  /** Run inside the publisher document. */
  doc<T, A = undefined>(action: (arg: A) => T, arg?: A): Promise<Awaited<T>> {
    return this.frame.evaluate(`(${action.toString()})(${JSON.stringify(arg ?? null)})`) as Promise<Awaited<T>>;
  }
  get calls() { return this.host(lab => lab.calls); }
  /** Answer the oldest held request. The widget shows its pending state before the request crosses to the host, so wait for it to arrive. */
  async release(failure?: Parameters<CommentLab["settle"]>[1]) {
    await expect.poll(() => this.host(lab => lab.held.length)).toBeGreaterThan(0);
    await this.host((lab, failure) => { lab.holds = []; lab.settle(0, failure ?? undefined); }, failure ?? null);
  }
  /** Wait for the widget to be hydrated and subscribed, then publish the seed. */
  async ready(threads: Parameters<CommentLab["seed"]>[0] = []) {
    await this.ui.locator('[data-testid="commentor-dock"]').waitFor({ state: "attached" });
    await expect.poll(() => this.host(lab => lab.subscriptions)).toBeGreaterThan(0);
    await this.host((lab, seed) => lab.seed(seed), threads);
  }
  tid(id: string) { return this.ui.locator(`[data-testid="${id}"]`); }
  pins() { return this.tid("commentor-pin"); }
  async select(selector: string, from = 0, to?: number) {
    await this.doc(({ selector, from, to }) => {
      window.focus();
      const text = document.querySelector(selector)!.firstChild as Text;
      const range = document.createRange();
      range.setStart(text, from);
      range.setEnd(text, to ?? text.length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, { selector, from, to });
  }
  async openDrawer() {
    await this.tid("commentor-panel-btn").click();
    await expect.poll(() => this.tid("commentor-panel-btn").getAttribute("aria-expanded")).toBe("true");
  }
  /** Stop the installed clock, so a short widget timer runs only when the test advances it rather than whenever real time passes. */
  async pauseClock() {
    await this.page.clock.pauseAt(await this.page.evaluate(() => Date.now()) + 1_000);
  }
  /** A real task turn in the document, unaffected by a faked clock, so queued events (selectionchange) are delivered. */
  tick() { return this.doc(() => new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); })); }
  /** Deliver a selection change now and let the frame the widget schedules for it run, so its outcome is final. */
  async selectionSettled() {
    await this.doc(() => new Promise<void>(resolve => {
      document.dispatchEvent(new Event("selectionchange"));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  }
  /** Test id of the widget's focused control (the shadow host is itself the document's active element). */
  focused() { return this.doc(() => document.getElementById("commentor-host")!.shadowRoot!.activeElement?.getAttribute("data-testid") ?? null); }
  async toasts() { return this.ui.locator(".toast").allInnerTexts(); }
}
