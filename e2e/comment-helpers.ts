import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FrameLocator, Page, WebSocketRoute } from "@playwright/test";
import { expect } from "./fixtures";
import { assertLoopback } from "./backend";
import type { RepoFixtures } from "./repo-fixtures";

/**
 * Helpers for the repository comment specs (#254): server state is re-read through the same Convex functions the widget
 * subscribes to, authenticated by the person's own session token.
 */
export type CallResult<T = unknown> = { ok: boolean; value?: T; code?: string; retryAfter?: number; message?: string };

/** Convex function call authenticated by `token` (the widget's JWT), never an ambient cookie. */
export async function convexCallWith<T = unknown>(token: string | undefined, kind: "query" | "mutation", path: string, args: unknown): Promise<CallResult<T>> {
  const origin = process.env.RENDRO_E2E_CONVEX;
  if (!origin) throw new Error("Missing local Convex origin");
  assertLoopback(origin);
  const response = await fetch(`${origin}/api/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ path, args, format: "json" }) });
  const body = await response.json() as { status: string; value?: T; errorMessage?: string; errorData?: { code?: string; kind?: string; retryAfter?: number } };
  if (body.status === "success") return { ok: true, value: body.value };
  return { ok: false, code: body.errorData?.code ?? body.errorData?.kind, retryAfter: body.errorData?.retryAfter, message: body.errorMessage };
}

/** The short-lived Convex JWT the shell would fetch for the page's signed-in person; absent without a session. */
export async function sessionToken(page: Page) {
  const response = await page.request.get("/api/auth/convex/token");
  return response.ok() ? ((await response.json()) as { token?: string }).token : undefined;
}

/** Drafts the parent shell keeps for the signed-in person (sessionStorage, per tab). */
export const storedDrafts = (page: Page) => page.evaluate(() => Object.entries(sessionStorage)
  .filter(([key]) => key.startsWith("commentor-operations:"))
  .flatMap(([, value]) => Object.values((JSON.parse(value as string) as { drafts: Record<string, { body: string }> }).drafts).map(draft => draft.body)));

export const repos = (): RepoFixtures => JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
/** GitHub's IDs of the comment fixtures (`repositoryWorld`): Convex scopes comments by them. */
export const repoIds = { comments: 9004, commentsPrivate: 9005 } as const;
export const ui = (page: Page): FrameLocator => page.frameLocator("#content-frame");
export const unique = (label: string) => `${label} ${randomBytes(4).toString("hex")}`;

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${repos().control}${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
  expect(response.status, path).toBe(200);
  return await response.json() as T;
}

/** Push a commit to comment-docs (null deletes a file); it is ingested before this returns. */
export const commit = async (changes: Record<string, string | null>) => (await control<{ commit: string }>("/commit/comments", { changes })).commit;
/** The member's GitHub role on comment-docs (#259), applied through GitHub's `member` webhook; `none` removes it. */
export const memberRole = async (role: "admin" | "maintain" | "write" | "triage" | "read" | "none") => (await control<{ status: number }>(`/role/${role}`)).status;
export const collaborator = async (action: "added" | "removed") => (await control<{ status: number }>(`/collaborator/${action}`)).status;

/** A page of comment-docs of its own (a new path per call), so a journey starts with no comments even on a retry. */
export async function journeyDoc(label: string) {
  const path = `docs/journeys/${label}-${randomBytes(4).toString("hex")}.md`;
  const head = await commit({ [path]: "# Journey\n\n## Notes\n\nThe quick brown fox jumps over the lazy dog.\n\nA second paragraph keeps the page longer.\n" });
  return { path, commit: head };
}

/** The page at one commit, once the widget has its first snapshot. */
export async function open(page: Page, repo: { owner: string; name: string }, doc: string, commitSha?: string) {
  const response = await page.goto(`/r/${repo.owner}/${repo.name}${commitSha ? `/@${commitSha}` : ""}?doc=${encodeURIComponent(doc)}`);
  expect(response?.status()).toBe(200);
  await expect(ui(page).getByTestId("commentor-dock")).toBeAttached();
  await expect(ui(page).locator('[data-testid="commentor-load-older-threads"][aria-busy="true"]')).toHaveCount(0);
}

/** Select `text` inside the rendered page, as a reader dragging over it would. */
export async function select(page: Page, text: string) {
  await ui(page).locator("article").evaluate((article, needle) => {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const index = node.data.indexOf(needle);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const selection = getSelection();
      if (!selection) throw new Error("No selection in the page");
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`No ${needle} on the page`);
  }, text);
}

// Saved pins only: the reader's own thread shows at once as sending (#284), before it is saved.
export const pin = (page: Page, body: string) => ui(page).locator(`[data-testid="commentor-pin"]:not(.is-sending)[data-tip*="${body}"]`);
export const card = (page: Page, body: string) => ui(page).locator(".drawer-thread", { hasText: body });

/** Open the composer on `quote` from the selection chip. */
export async function startComment(page: Page, quote: string) {
  await select(page, quote);
  const chip = ui(page).getByTestId("commentor-selection-action");
  await expect(chip).toHaveAttribute("data-state", "open");
  await chip.click();
  await expect(ui(page).getByTestId("commentor-composer-textarea")).toBeFocused();
}

export async function comment(page: Page, quote: string, body: string) {
  await startComment(page, quote);
  await ui(page).getByTestId("commentor-composer-textarea").fill(body);
  await ui(page).getByTestId("commentor-composer-post").click();
  await expect(pin(page, body)).toBeVisible();
}

export async function openDrawer(page: Page) {
  const panel = ui(page).getByTestId("commentor-panel-btn");
  if (await panel.getAttribute("aria-expanded") !== "true") await panel.click();
  await expect(ui(page).getByTestId("commentor-drawer")).toHaveAttribute("aria-hidden", "false");
}

export type Listed = { _id: string; body: string; resolved: boolean; archived: boolean; clientOperationId?: string; replies: Array<{ _id: string; body: string }>; repliesHasMore: boolean };
type Scope = { repoId: number; path: string };

/** The first page of a repository page's live threads, as `token`'s person (undefined: anonymous) sees it. */
export async function threadsAs(token: string | undefined, scope: Scope): Promise<Listed[]> {
  const result = await convexCallWith<{ page: Listed[] }>(token, "query", "repoComments:listThreads", { ...scope, paginationOpts: { numItems: 20, cursor: null } });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result.value as { page: Listed[] }).page;
}

/** What anyone may read of a public repository's page, straight from Convex (no session). */
export const publicThreads = (path: string) => threadsAs(undefined, { repoId: repoIds.comments, path });

/** An anchor on `exact` in the page's Notes section. The offset is left for the reader to find by quote (#254). */
export async function anchorOn(page: Page, exact: string, headingSlug = "notes") {
  const config = JSON.parse(await ui(page).locator("script[data-commentor-config]").getAttribute("data-commentor-config") as string) as { blobSha: string };
  return { kind: "repo-text" as const, blobSha: config.blobSha, headingSlug, prefix: "", exact, suffix: "", offset: 0 };
}
type Anchor = Awaited<ReturnType<typeof anchorOn>>;

export async function createThread(token: string | undefined, scope: Scope, body: string, anchor: Anchor) {
  const result = await convexCallWith<string>(token, "mutation", "repoComments:createThread", { ...scope, body, anchor });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.value as string;
}
export async function addReply(token: string | undefined, scope: Scope, threadId: string, body: string) {
  const result = await convexCallWith<string>(token, "mutation", "repoComments:addReply", { ...scope, threadId, body });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.value as string;
}
/** A write by `token`'s person whose outcome (success or the public error code) the caller asserts. */
export const writeThread = (token: string | undefined, scope: Scope, method: "resolve" | "archive" | "removeThread", threadId: string, extra: Record<string, unknown> = {}) =>
  convexCallWith(token, "mutation", `repoComments:${method}`, { ...scope, threadId, ...extra });

/** Stop page timers (undo window, quota countdown) until the test advances them. Call after the widget is ready. */
export async function pauseClock(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
}

/**
 * Sits between one page (the shell, which holds the only Convex client) and its Convex socket. `hold` keeps the page's
 * own messages back until `release`, so the test decides what the server looks like at the moment a request arrives;
 * replies and subscription updates keep flowing. Register it before the page opens.
 */
export async function convexSocket(page: Page) {
  const origin = process.env.RENDRO_E2E_CONVEX?.replace("http:", "ws:");
  if (!origin) throw new Error("Missing local Convex origin");
  let holding = false;
  const held: Array<{ server: WebSocketRoute; message: string | Buffer }> = [];
  await page.routeWebSocket(url => url.origin === origin, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => { if (holding) held.push({ server, message }); else server.send(message); });
    server.onMessage(message => { ws.send(message); });
  });
  return {
    hold(on: boolean) { holding = on; },
    /** Whether the page has tried to send a message mentioning `needle` (for example a function path) while held. */
    heldMessage: (needle: string) => held.some(entry => typeof entry.message === "string" && entry.message.includes(needle)),
    release() { holding = false; for (const { server, message } of held.splice(0)) server.send(message); },
  };
}

