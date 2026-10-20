import type { Frame, Page } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import { COMMENTOR_PARENT_READY, COMMENTOR_PARENT_REQUEST, COMMENTOR_PROTOCOL_VERSION } from "@/commentor/parent-protocol";
import type { ShellFrameTrust } from "./fixtures/shell-frame-trust-browser";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

/*
 * The shell answers only a document it loaded into its frame (#296), in Chromium with the real comment host and
 * ticket renewal. A document the frame loads by itself keeps the frame's `src`, so the address alone cannot tell it
 * apart: it gets no comment announcement, no ticket and no answer to a comment write, until the shell loads a page
 * again. Each document records what the shell sends it and asks for a ticket and a write as soon as it has one.
 */
const harness = createBrowserHarness();
const base = `/r/octo/secret/@${"c0ffee".padEnd(40, "0")}`;
const tickets: string[] = [];

function documentHtml(name: string): string {
  return `<!doctype html><html><body><h1>${name}</h1><script>
    window.received = [];
    addEventListener("message", event => { if (event.source === parent) window.received.push(event.data); });
    window.ask = () => {
      parent.postMessage({ type: "viewer-renew", manifestKey: "c0ffee", requestId: "renew-${name}" }, location.origin);
      parent.postMessage({ type: "${COMMENTOR_PARENT_REQUEST}", protocolVersion: ${COMMENTOR_PROTOCOL_VERSION}, requestId: "subscribe-${name}", method: "subscribe", args: { documentPath: "guide.md" } }, location.origin);
      parent.postMessage({ type: "${COMMENTOR_PARENT_REQUEST}", protocolVersion: ${COMMENTOR_PROTOCOL_VERSION}, requestId: "write-${name}", method: "thread.resolve", args: { threadId: "thread-1", resolved: true } }, location.origin);
    };
  </script></body></html>`;
}

beforeAll(async () => {
  const assets = new Map([["/shell.js", await bundleBrowserAsset("tests/fixtures/shell-frame-trust-browser.ts")]]);
  await harness.start((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/r/octo/secret") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><iframe id="content-frame" sandbox="allow-scripts" src="about:blank"></iframe><script src="/shell.js"></script></body></html>`);
    } else if (url.pathname === `${base}/files/guide.md` || url.pathname === "/elsewhere") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(documentHtml(url.pathname === "/elsewhere" ? "stray" : "guide"));
    } else if (url.pathname === `${base}/viewer-ticket`) {
      tickets.push(url.search);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ prefix: `${base}/view/t${tickets.length}/files/` }));
    } else {
      response.writeHead(404).end();
    }
  }, assets);
});

const shell = <T>(page: Page, read: (shell: ShellFrameTrust) => T) => page.evaluate(`(${read.toString()})(window.shell)`) as Promise<T>;
const frame = (page: Page) => page.frames().find(candidate => candidate !== page.mainFrame())!;
const received = (content: Frame) => content.evaluate(() => (window as unknown as { received: Array<{ type: string; requestId?: string }> }).received);

async function loaded(page: Page, heading: string): Promise<Frame> {
  await expect.poll(() => frame(page).locator("h1").textContent().catch(() => null)).toBe(heading);
  return frame(page);
}

describe("a frame document the shell did not load (#296)", () => {
  it("gets no comment announcement, ticket or answer to a write, until the shell loads a page again", async () => {
    tickets.length = 0;
    const page = await harness.newPage();
    await browserStep("open the shell", () => page.goto(`${harness.origin}/r/octo/secret`));
    await shell(page, s => s.navigate("guide.md"));
    // The page the shell loaded is announced to, served and renewed.
    let content = await loaded(page, "guide");
    await expect.poll(async () => (await received(content)).some(message => message.type === COMMENTOR_PARENT_READY)).toBe(true);
    await content.evaluate(() => (window as unknown as { ask(): void }).ask());
    await expect.poll(async () => (await received(content)).map(message => message.requestId ?? message.type).sort())
      .toEqual(expect.arrayContaining(["renew-guide", "subscribe-guide", "write-guide"]));
    expect(tickets).toHaveLength(1);
    expect(await shell(page, s => s.calls.map(call => call.method))).toEqual(["subscribe", "thread.resolve"]);

    // The document goes somewhere by itself; the frame's src still names the guide.
    await content.evaluate(() => { location.href = "/elsewhere"; });
    content = await loaded(page, "stray");
    expect(await page.locator("#content-frame").getAttribute("src")).toBe(`${base}/files/guide.md`);
    await content.evaluate(() => (window as unknown as { ask(): void }).ask());
    // A round trip the shell would have answered by now.
    await page.waitForTimeout(500);
    expect(await received(content)).toEqual([]);
    expect(tickets).toHaveLength(1);
    expect(await shell(page, s => s.calls.map(call => call.method))).toEqual(["subscribe", "thread.resolve"]);

    // The reader picks the page again: the shell loaded it, so it is served as before.
    await shell(page, s => s.navigate("guide.md"));
    content = await loaded(page, "guide");
    await expect.poll(async () => (await received(content)).some(message => message.type === COMMENTOR_PARENT_READY)).toBe(true);
    await page.close();
  });
});
