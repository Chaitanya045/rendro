import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Cookie, Frame, FrameLocator, Page } from "@playwright/test";
import { test as base, expect, guardContext } from "./fixtures";
import { pushDocuments } from "./seed";
import { api, provision } from "./shell-helpers";

/**
 * One document site pushed through the real CLI per worker, browsed by every viewer spec: a private project
 * (owner and outsider sessions), two publications (whole deployment and a prefix) and helpers for private shares.
 * Pages are plain publisher HTML. The ones with scripts behave like hostile or sloppy publishers: they click their
 * own links as soon as they load, which no reader authorized.
 */
export type ViewerSite = {
  organizationId: string;
  projectId: string;
  /** `/organizations/<id>/projects/<id>/docs`. */
  docs: string;
  /** Session cookies of the owner and of a signed-in user with no membership. */
  owner: Cookie[];
  outsider: Cookie[];
  whole: string;
  scoped: string;
  key: string;
};

export const html = (title: string, body = "", head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1 id="top">${title}</h1>${body}</body></html>`;
const spacer = (height: number) => `<div style="height:${height}px" aria-hidden="true"></div>`;

/**
 * A publisher script that acts on its own links when told to, standing in for a document that follows them with no reader
 * action. The shell tells it to once the shell's user activation has lapsed (`trackActivation`), so the request carries no
 * authorization. `forge` sends malformed and hostile requests first and one valid request last; messages are handled in
 * order, so the valid request being offered proves the forged ones before it were all processed and refused.
 */
const remote = `<script>addEventListener("message",function(event){
  var data=event.data;
  if(!data||typeof data!=="object")return;
  if(typeof data.click==="string")document.getElementById(data.click).click();
  if(data.forge){
    for(var message of [
      {type:"doc-navigate",path:"../other.html"},
      {type:"doc-navigate",path:"guide//intro.html"},
      {type:"doc-navigate",path:"guide/intro.html",fragment:"no-hash"},
      {type:"doc-navigate",path:"guide/intro.html",search:"?a#b"},
      {type:"doc-navigate",path:"guide/intro.html",search:42}
    ])parent.postMessage(message,"*");
    // Leaving the shell is not possible from a sandboxed document, with or without activation.
    try{top.location.href="https://docs.example.test/top"}catch(error){}
    try{parent.location.href="https://docs.example.test/parent"}catch(error){}
    document.getElementById("valid").click();
  }
})</script>`;

export const pages: Record<string, string> = {
  // The links stay in view while the document scrolls, so a click never scrolls the document by itself.
  "index.html": html("Viewer home", `
    <nav aria-label="Links" style="position:fixed;top:0;left:0;right:0;z-index:5;padding:6px;background:#fff;border-bottom:1px solid #ccc">
      <a id="to-section-two" href="#section-two">Section two</a>
      <a id="to-cafe" href="#caf%C3%A9">Café</a>
      <a id="to-legacy" href="#legacy-anchor">Legacy anchor</a>
      <a id="to-bare" href="#">Bare hash</a>
      <a id="to-missing" href="#missing-target">Missing target</a>
      <a id="to-intro" href="guide/intro.html">Intro</a>
      <a id="to-intro-details" href="guide/intro.html#details">Intro details</a>
      <a id="to-intro-query" href="guide/intro.html?lang=fr#details">Intro in French</a>
      <a id="to-topic" href="guide/deep/topic.html">Deep topic</a>
      <a id="external" href="https://docs.example.test/outside">External</a>
      <a id="new-tab" href="guide/intro.html" target="_blank" rel="noopener">New tab</a>
    </nav>
    <input id="draft" aria-label="Draft" value="" style="margin-top:96px">
    ${spacer(1800)}<h2 id="section-two">Section two</h2>${spacer(1800)}
    <h2 id="café">Café</h2>${spacer(1200)}
    <a name="legacy-anchor"></a><p>Legacy anchor target</p>${spacer(800)}`),
  "guide/intro.html": html("Guide intro", `
    <nav><a id="to-home" href="../index.html">Home</a> <a id="to-home-section" href="../index.html#section-two">Home section two</a>
    <a id="to-topic" href="deep/topic.html">Deep topic</a> <a id="to-details" href="#details">Details</a></nav>
    ${spacer(2200)}<h2 id="details">Details</h2>${spacer(1200)}`),
  "guide/deep/topic.html": html("Deep topic", '<a id="to-home" href="../../index.html">Home</a>'),
  "other/elsewhere.html": html("Elsewhere"),
  // Text to comment on, a link within the document and, with the publisher script, one that follows its own link unasked.
  "comment.html": html("Comment page", `
    <p id="intro">The quick brown fox jumps over the lazy dog.</p>
    <a id="to-later" href="#later">Jump to a later section</a> <a id="go" href="guide/intro.html#details">Go</a>
    ${spacer(1600)}<h2 id="later">Later section</h2>${spacer(900)}${remote}`),
  "late.html": html("Late link", `<a id="go" href="guide/intro.html#details">Go</a>${remote}`),
  // Unsolicited targets, one wave at a time.
  "flood.html": html("Flood", `
    <a id="first" href="guide/intro.html">First</a><a id="second" href="guide/deep/topic.html">Second</a><a id="third" href="other/elsewhere.html?x=1#y">Third</a>${remote}`),
  "forged.html": html("Forged", `<a id="valid" href="guide/intro.html#details">Valid</a>${remote}`),
  // Records the theme the shell sends it and paints its own background, to show the shell never restyles publisher content.
  "probe.html": html("Theme probe", "", `<style>body{background:rgb(250,240,230);color:rgb(20,30,40)}</style><script>addEventListener("message",function(event){
    var data=event.data;
    if(!data||data.type!=="rendro-theme")return;
    var root=document.documentElement;
    root.dataset.themeMessage=String(data.theme);
    root.dataset.themeMessages=String(Number(root.dataset.themeMessages||0)+1);
  })</script>`),
};

/** Every page above plus the deployment-wide assets, written once per worker. */
async function writeSite(source: string) {
  for (const [name, content] of Object.entries(pages)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), content);
  }
}

export type Deployment = { organizationId: string; projectId: string; key: string; docs: string; cookies: Cookie[]; directory: string };

/**
 * A verified owner with an organization and project, a CLI-pushed deployment (written by `write`; `amend` then changes files and
 * pushes again, so the second deployment reuses the unchanged ones) and the owner's session. Provisioning is real signup, mail verification and API calls;
 * it is paid once per worker by the callers' worker-scoped fixtures.
 */
export async function provisionDeployment(browser: Browser, label: string, write: (directory: string) => Promise<void>, amend?: (directory: string) => Promise<void>): Promise<Deployment & { page: Page; close: () => Promise<void> }> {
  const origin = process.env.RENDRO_E2E_ORIGIN;
  const base = process.env.RENDRO_E2E_DIRECTORY;
  if (!origin || !base) throw new Error("Missing local E2E state");
  const context = await browser.newContext({ baseURL: origin, serviceWorkers: "block" });
  const unexpected = await guardContext(context, origin, `${label}-owner`);
  const page = await context.newPage();
  const workspace = await provision(page, label, { organizations: ["Viewer"], project: true });
  const { id: projectId, organizationId } = workspace.projects[0];
  const credential = await api<{ rawKey: string }>(page, "/api/rendro/credentials", { organizationId, projectId, name: "Viewer publisher",
    scopes: ["docs:read", "docs:write", "publications:read", "publications:write"] });
  expect(credential.status).toBeLessThan(300);
  const key = credential.body.rawKey;
  const directory = join(base, label);
  await write(directory);
  // Hundreds of files through the CLI take a while on a loaded host; the budget is the fixture's, not a timing assertion.
  await pushDocuments(directory, origin, organizationId, projectId, key, 8, 150_000);
  if (amend) {
    await amend(directory);
    await pushDocuments(directory, origin, organizationId, projectId, key, 8, 150_000);
  }
  expect([...unexpected], "Unexpected external requests while provisioning").toEqual([]);
  return { organizationId, projectId, key, directory, docs: `/organizations/${organizationId}/projects/${projectId}/docs`,
    cookies: await context.cookies(), page, close: () => context.close() };
}

export const test = base.extend<{ site: ViewerSite; asOwner: Page }, { siteState: { get(): Promise<ViewerSite> } }>({
  siteState: [async ({ browser }, use, info) => {
    const nonce = `${info.workerIndex}-${Date.now().toString(36)}-${info.project.name}`;
    let created: Promise<ViewerSite> | undefined;
    const create = async (): Promise<ViewerSite> => {
      const deployment = await provisionDeployment(browser, `viewer-${nonce}`, writeSite);
      const outsiderContext = await browser.newContext({ baseURL: process.env.RENDRO_E2E_ORIGIN, serviceWorkers: "block" });
      try {
        const { page, organizationId, projectId, key } = deployment;
        const slug = `viewer-${nonce}-${organizationId.slice(-6)}`.toLowerCase();
        for (const publication of [
          { slug: `${slug}-all`, pathPrefix: "", entryFile: "index.html", title: "Everything" },
          { slug: `${slug}-guide`, pathPrefix: "guide", entryFile: "intro.html", title: "Guide only" },
        ]) {
          const response = await page.request.post("/api/rendro/publications", { headers: { Authorization: `Bearer ${key}` },
            data: { organizationId, projectId, trackingMode: "track_active", ...publication } });
          expect(response.ok(), `publication ${publication.slug}`).toBe(true);
        }
        const unexpected = await guardContext(outsiderContext, process.env.RENDRO_E2E_ORIGIN, `viewer-outsider-${nonce}`);
        await provision(await outsiderContext.newPage(), `viewer-outsider-${nonce}`);
        expect([...unexpected], "Unexpected external requests while provisioning the outsider").toEqual([]);
        return { organizationId, projectId, key, whole: `${slug}-all`, scoped: `${slug}-guide`, docs: deployment.docs,
          owner: deployment.cookies, outsider: await outsiderContext.cookies() };
      } finally {
        await deployment.close();
        await outsiderContext.close();
      }
    };
    // Lazy: only the first test that asks pays for provisioning and the CLI push.
    await use({ get: () => (created ??= create()) });
  }, { scope: "worker", timeout: 180_000 }],
  site: [async ({ siteState }, use) => { await use(await siteState.get()); }, { timeout: 180_000 }],
  /** The owner's signed-in page, viewport-neutral. */
  asOwner: async ({ page, context, site }, use) => {
    await context.addCookies(site.owner);
    await use(page);
  },
});

export { expect };

export const content = (page: Page): FrameLocator => page.frameLocator("#content-frame");
/** The iframe's current location (opaque origin, so only Playwright can read it). */
export function documentFrame(page: Page): Frame {
  const frame = page.frames().find(candidate => candidate.parentFrame() === page.mainFrame() && candidate.name() === "content-frame");
  if (!frame) throw new Error("Missing content frame");
  return frame;
}
export const frameFile = (page: Page) => new URL(documentFrame(page).url()).pathname.replace(/^.*\/files\//, "");

/**
 * Install before navigating. A navigation typed into the address bar (or a Playwright `goto`) hands the new document user
 * activation, and so does a Playwright evaluation in Chromium; the viewer's gate treats a request with activation as the
 * reader's own. `untilInactive()` resolves once the shell's activation has lapsed (it must hold for a few of the gate's 100ms
 * polls) so the next real click starts a fresh history entry. `postWhenInactive(message)` posts to the content frame from
 * inside the shell at that moment, so nothing from the test touches the page between the lapse and the request: in Firefox
 * even a binding call or an evaluation's return grants new activation, and a Playwright evaluation in Chromium does too, so
 * `handled(n)` waits on requests the shell makes after handling each document-navigation message.
 */
export async function trackActivation(page: Page) {
  let lapsed: () => void = () => undefined;
  const acknowledged: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/__navigate-handled/")) acknowledged.push(path); });
  await page.exposeBinding("viewerInactive", () => { lapsed(); });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const host = window as unknown as { watchInactive: (message: unknown) => void; viewerInactive: () => void };
    // Each document-navigation request is acknowledged with a request of the shell's own, sent after the shell has handled it.
    let seen = 0;
    window.addEventListener("message", event => {
      const data = event.data as { type?: unknown } | null;
      if (!data || data.type !== "doc-navigate") return;
      const count = ++seen;
      setTimeout(() => { void fetch(`/__navigate-handled/${count}`).catch(() => undefined); }, 0);
    });
    host.watchInactive = message => {
      let since = -1;
      const check = () => {
        if (navigator.userActivation.isActive) since = -1;
        else if (since < 0) since = performance.now();
        else if (performance.now() - since >= 350) {
          if (message === undefined) host.viewerInactive();
          else (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow?.postMessage(message, "*");
          return;
        }
        setTimeout(check, 20);
      };
      check();
    };
  });
  return {
    /**
     * Resolves after the shell handled `count` document-navigation requests; watches requests only, never the page. The request
     * is only sent once activation has lapsed (several seconds), which a loaded host can stretch past the default timeout.
     */
    handled: (count: number) => expect.poll(() => acknowledged.length, { message: "document-navigation requests handled by the shell", timeout: 30_000 }).toBeGreaterThanOrEqual(count),
    async untilInactive() {
      const done = new Promise<void>(resolve => { lapsed = resolve; });
      await page.evaluate(() => (window as unknown as { watchInactive: (message?: unknown) => void }).watchInactive());
      await done;
    },
    /** Returns at once; the frame receives `message` after activation lapsed. */
    postWhenInactive: (message: object) => page.evaluate(message => (window as unknown as { watchInactive: (message: unknown) => void }).watchInactive(message), message),
    /** The frame receives `message` now. */
    postNow: (message: object) => page.evaluate(message => (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow?.postMessage(message, "*"), message),
  };
}
