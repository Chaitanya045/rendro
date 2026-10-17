import type { FrameLocator, Page, WebSocketRoute } from "@playwright/test";
import { expect } from "./fixtures";
import { assertLoopback } from "./backend";
import type { Actor } from "./org-fixtures";
import { commitStaged, createKey, startDeployment, uploadStaged } from "./project-helpers";

/**
 * Helpers for the comment and recovery journeys (#115). People are `actor` contexts; documents are published through the
 * deployment API (the journey under test is the comment UI, not the push); server state is re-read through the same
 * Convex functions the widget subscribes to, authenticated by the person's own session.
 */
export const commentDoc = (title = "Quarterly report") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:16px/24px sans-serif}main{padding:24px;width:520px}p{margin:0 0 16px}</style></head><body><main><h1 id="title">${title}</h1><p id="intro">The quick brown fox jumps over the lazy dog.</p><p id="second">Second paragraph for element comments.</p></main></body></html>`;

export type Site = { owner: Actor; organizationId: string; projectId: string; key: string; docs: string };

export async function publish(site: Site, files: Record<string, string>) {
  const staging = await startDeployment(site.key, site.organizationId, site.projectId, files);
  await uploadStaged(site.key, site.organizationId, site.projectId, staging);
  const committed = await commitStaged(site.key, site.organizationId, site.projectId, staging);
  expect(committed.status, JSON.stringify(committed.body)).toBeLessThan(300);
}

/** An owner with a project whose active deployment holds the given documents. */
export async function commentSite(actor: (label: string, options?: { organizations?: string[]; project?: boolean }) => Promise<Actor>, label: string, files: Record<string, string> = { "index.html": commentDoc() }): Promise<Site> {
  const owner = await actor(label, { organizations: ["Comments"], project: true });
  const organizationId = owner.organizations[0].id;
  const projectId = owner.projects[0].id;
  const { rawKey } = await createKey(owner.page, organizationId, projectId);
  const site = { owner, organizationId, projectId, key: rawKey, docs: `/organizations/${organizationId}/projects/${projectId}/docs` };
  await publish(site, files);
  return site;
}

export const widget = (page: Page): FrameLocator => page.frameLocator("#content-frame");

/** Open a document and wait until the widget is hydrated and its subscription delivered a snapshot. */
export async function openDocument(page: Page, site: Site, path = "index.html") {
  await page.goto(`${site.docs}?doc=${encodeURIComponent(path)}`);
  await widgetReady(page);
}

export type CallResult<T = unknown> = { ok: boolean; value?: T; code?: string; retryAfter?: number; message?: string };

/** Convex function call authenticated by the person's own session (the widget's JWT), never an ambient cookie. */
export async function convexCall<T = unknown>(page: Page, kind: "query" | "mutation", path: string, args: unknown): Promise<CallResult<T>> {
  return convexCallWith<T>(await sessionToken(page), kind, path, args);
}
export async function convexCallWith<T = unknown>(token: string | undefined, kind: "query" | "mutation", path: string, args: unknown): Promise<CallResult<T>> {
  const origin = process.env.RENDRO_E2E_CONVEX;
  if (!origin) throw new Error("Missing local Convex origin");
  assertLoopback(origin);
  const response = await fetch(`${origin}/api/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ path, args, format: "json" }) });
  const body = await response.json() as { status: string; value?: T; errorMessage?: string; errorData?: { code?: string; kind?: string; retryAfter?: number } };
  if (body.status === "success") return { ok: true, value: body.value };
  return { ok: false, code: body.errorData?.code ?? body.errorData?.kind, retryAfter: body.errorData?.retryAfter, message: body.errorMessage };
}
/** The short-lived Convex JWT the parent shell would fetch; absent without a session. */
export async function sessionToken(page: Page) {
  const response = await page.request.get("/api/auth/convex/token");
  return response.ok() ? ((await response.json()) as { token?: string }).token : undefined;
}

type Anchor = { kind: "element"; path: string[] } | { kind: "text-range"; quote: string; path: string[]; startOffset: number; endOffset: number };
export const heading: Anchor = { kind: "element", path: ["main", "h1"] };
export const intro: Anchor = { kind: "text-range", quote: "quick brown", path: ["main", "p:nth-of-type(1)"], startOffset: 4, endOffset: 15 };
export type Thread = { _id: string; body: string; anchor: Anchor; resolved: boolean; archived: boolean; canDelete: boolean; authorName: string; clientOperationId?: string; replies: Array<{ _id: string; body: string; canDelete: boolean }>; repliesHasMore: boolean };

const scope = (site: Site, path = "index.html") => ({ organizationId: site.organizationId, projectId: site.projectId, documentPath: path });

/** The server's current first page of active threads, as the signed-in person sees it. */
export async function threadsOf(page: Page, site: Site, path = "index.html") {
  const result = await convexCall<{ page: Thread[] }>(page, "query", "documentThreads:list", { ...scope(site, path), paginationOpts: { numItems: 20, cursor: null } });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result.value as { page: Thread[] }).page;
}
export async function createThread(page: Page, site: Site, body: string, anchor: Anchor = heading, path = "index.html") {
  const result = await convexCall<string>(page, "mutation", "documentThreads:create", { ...scope(site, path), body, anchor });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.value as string;
}
export async function addReply(page: Page, site: Site, threadId: string, body: string, path = "index.html") {
  const result = await convexCall<string>(page, "mutation", "documentReplies:add", { ...scope(site, path), threadId, body });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.value as string;
}
/** A write by the person's own session whose outcome (success or the public error code) the caller asserts. */
export const writeThread = (page: Page, site: Site, method: "resolve" | "archive" | "remove", threadId: string, extra: Record<string, unknown> = {}, path = "index.html") =>
  convexCall(page, "mutation", `documentThreads:${method}`, { ...scope(site, path), threadId, ...extra });
export const removeReply = (page: Page, site: Site, threadId: string, replyId: string, path = "index.html") =>
  convexCall(page, "mutation", "documentReplies:remove", { ...scope(site, path), threadId, replyId });

/** The widget finished its first subscription: the shadow dock exists and no first page is loading. */
export async function widgetReady(page: Page) {
  await expect(widget(page).getByTestId("commentor-dock")).toBeAttached();
  await expect(widget(page).locator('[data-testid="commentor-load-older-threads"][aria-busy="true"]')).toHaveCount(0);
}

/** Stop page timers (undo window, quota countdown) until the test advances them. Call after the widget is ready. */
export async function pauseClock(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
}

/**
 * Sits between one page and its Convex socket. Requests always reach the server; while blackholed no reply or
 * subscription update reaches the page, which is how a lost response looks to a reader. `drop` closes the live socket
 * so the client reconnects (and resends whatever it has not seen answered) through the same route. `hold` keeps the page's
 * own messages back until `release`, so the test decides what the server looks like at the moment a request arrives.
 */
export async function convexSocket(page: Page) {
  const origin = process.env.RENDRO_E2E_CONVEX?.replace("http:", "ws:");
  if (!origin) throw new Error("Missing local Convex origin");
  const open = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>();
  let blackholed = false;
  let holding = false;
  const held: Array<{ server: WebSocketRoute; message: string | Buffer }> = [];
  await page.routeWebSocket(url => url.origin === origin, ws => {
    const server = ws.connectToServer();
    const pair = { page: ws, server };
    open.add(pair);
    ws.onMessage(message => { if (holding) held.push({ server, message }); else server.send(message); });
    server.onMessage(message => { if (!blackholed) ws.send(message); });
    ws.onClose(() => { open.delete(pair); });
  });
  return {
    blackhole(on: boolean) { blackholed = on; },
    hold(on: boolean) { holding = on; },
    /** Whether the page has tried to send a message mentioning `needle` (for example a function path) while held. */
    heldMessage: (needle: string) => held.some(entry => typeof entry.message === "string" && entry.message.includes(needle)),
    release() { holding = false; for (const { server, message } of held.splice(0)) server.send(message); },
    async drop() { for (const { page: ws, server } of [...open]) { await server.close(); await ws.close(); } },
    connections: () => open.size,
  };
}

/** Drafts the parent shell keeps for the signed-in person (sessionStorage, per tab). */
export const storedDrafts = (page: Page) => page.evaluate(() => Object.entries(sessionStorage)
  .filter(([key]) => key.startsWith("commentor-operations:"))
  .flatMap(([, value]) => Object.values((JSON.parse(value as string) as { drafts: Record<string, { body: string }> }).drafts).map(draft => draft.body)));
export const storedOperations = (page: Page) => page.evaluate(() => Object.entries(sessionStorage)
  .filter(([key]) => key.startsWith("commentor-operations:"))
  .flatMap(([, value]) => Object.values((JSON.parse(value as string) as { operations: Record<string, { method: string; clientOperationId: string }> }).operations)));

/** Select a word of the intro paragraph with the pointer, open the composer from the chip and return the selected text. */
export async function startSelectionComment(page: Page) {
  const ui = widget(page);
  await ui.locator("#intro").dblclick({ position: { x: 60, y: 8 } });
  const chip = ui.getByTestId("commentor-selection-action");
  await expect(chip).toHaveAttribute("data-state", "open");
  const quote = (await ui.locator("#intro").evaluate(() => String(getSelection()))).trim();
  await chip.click();
  await expect(ui.getByTestId("commentor-composer-textarea")).toBeFocused();
  return quote;
}
