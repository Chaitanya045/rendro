import { readFileSync } from "node:fs";
import type { Frame, FrameLocator, Page } from "@playwright/test";
import { test as base, expect } from "./fixtures";
import { signInSeeded } from "./shell-helpers";
import type { RepoFixtures } from "./repo-fixtures";

/**
 * The public `viewer-docs` repository (e2e/repo-fixtures.ts, `viewerDocs`) read through /r/: long Markdown pages with
 * sections, links between them, a nested folder and one external link. Every viewer chrome and link spec reads it as the
 * seeded outsider, who may read public repositories only: every read needs a signed-in reader (#354).
 */
export type ViewerSite = { owner: string; name: string; commit: string; /** `/r/<owner>/<name>`. */ docs: string };

/** `?doc=` value of a page in the repository: its path from the repository root. */
export const doc = (path: string) => `docs/${path}`;

export const test = base.extend<{ site: ViewerSite; privateSite: ViewerSite }>({
  context: async ({ context, baseURL, seed }, use) => {
    await signInSeeded(context, baseURL, seed, "outsider");
    await use(context);
  },
  // eslint-disable-next-line no-empty-pattern -- fixtures.ts uses the same Playwright idiom for zero dependencies
  site: async ({}, use) => {
    const { viewer } = JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
    await use({ ...viewer, docs: `/r/${viewer.owner}/${viewer.name}` });
  },
  /** The same pages in a private repository, whose readers may comment (#353). */
  // eslint-disable-next-line no-empty-pattern -- as above
  privateSite: async ({}, use) => {
    const { viewerPrivate } = JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
    await use({ ...viewerPrivate, docs: `/r/${viewerPrivate.owner}/${viewerPrivate.name}` });
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
