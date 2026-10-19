import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FrameLocator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { convexCallWith } from "./comment-helpers";
import { desktop, signInSeeded } from "./shell-helpers";
import { commentDocs, type RepoFixtures } from "./repo-fixtures";

/**
 * Comments on repository docs (#254), end to end: the repository shell holds the one Convex connection, the document
 * frame runs the widget under its own policy, Convex decides access from the grant the read path records, and the
 * control Worker (P5) revokes it with the reader's epoch. Each test resets the page it uses with its own commit and
 * writes comments with a body of its own, so tests stay independent across retries and shards.
 */
test.use({ viewport: desktop });

const repos = (): RepoFixtures => JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
const ui = (page: Page): FrameLocator => page.frameLocator("#content-frame");
const unique = (label: string) => `${label} ${randomBytes(4).toString("hex")}`;

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${repos().control}${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
  expect(response.status, path).toBe(200);
  return await response.json() as T;
}

/** Push a commit to comment-docs (null deletes a file); it is ingested before this returns. */
const commit = async (changes: Record<string, string | null>) => (await control<{ commit: string }>("/commit/comments", { changes })).commit;
const collaborator = async (action: "added" | "removed") => (await control<{ status: number }>(`/collaborator/${action}`)).status;

/** The page at one commit, once the widget has its first snapshot. */
async function open(page: Page, repo: { owner: string; name: string }, doc: string, commitSha?: string) {
  const response = await page.goto(`/r/${repo.owner}/${repo.name}${commitSha ? `/@${commitSha}` : ""}?doc=${encodeURIComponent(doc)}`);
  expect(response?.status()).toBe(200);
  await expect(ui(page).getByTestId("commentor-dock")).toBeAttached();
  await expect(ui(page).locator('[data-testid="commentor-load-older-threads"][aria-busy="true"]')).toHaveCount(0);
}

/** Select `text` inside the rendered page, as a reader dragging over it would. */
async function select(page: Page, text: string) {
  await ui(page).locator("article").evaluate((article, needle) => {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const index = node.data.indexOf(needle);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`No ${needle} on the page`);
  }, text);
}

const pin = (page: Page, body: string) => ui(page).locator(`[data-testid="commentor-pin"][data-tip*="${body}"]`);
const card = (page: Page, body: string) => ui(page).locator(".drawer-thread", { hasText: body });

async function comment(page: Page, quote: string, body: string) {
  await select(page, quote);
  const chip = ui(page).getByTestId("commentor-selection-action");
  await expect(chip).toHaveAttribute("data-state", "open");
  await chip.click();
  await ui(page).getByTestId("commentor-composer-textarea").fill(body);
  await ui(page).getByTestId("commentor-composer-post").click();
  await expect(pin(page, body)).toBeVisible();
}

async function openDrawer(page: Page) {
  const panel = ui(page).getByTestId("commentor-panel-btn");
  if (await panel.getAttribute("aria-expanded") !== "true") await panel.click();
  await expect(ui(page).getByTestId("commentor-drawer")).toHaveAttribute("aria-hidden", "false");
}

type Listed = { _id: string; body: string; resolved: boolean; replies: Array<{ body: string }> };
/** What anyone may read of a public repository's page, straight from Convex (no session). */
async function publicThreads(path: string): Promise<Listed[]> {
  const result = await convexCallWith<{ page: Listed[] }>(undefined, "query", "repoComments:listThreads", { repoId: 9004, path, paginationOpts: { numItems: 20, cursor: null } });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.value!.page;
}

test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

test("a reader creates, replies to and resolves a comment on a repository doc", async ({ page, seed, baseURL }) => {
  const { comments } = repos();
  const head = await commit({ "docs/guide.md": commentDocs()["docs/guide.md"] });
  await signInSeeded(page.context(), baseURL, seed, "owner");
  await open(page, comments, "docs/guide.md", head);
  const body = unique("Pin the version");
  await comment(page, "pnpm install", body);

  await pin(page, body).click();
  const bubble = ui(page).getByTestId("commentor-thread-bubble");
  await bubble.getByTestId("commentor-reply-input").fill("Agreed, pinned.");
  await bubble.getByTestId("commentor-reply-send").click();
  await expect(bubble).toContainText("Agreed, pinned.");
  await bubble.getByTestId("commentor-resolve-btn").click();
  await expect.poll(async () => (await publicThreads("docs/guide.md")).find(thread => thread.body === body))
    .toMatchObject({ resolved: true, replies: [{ body: "Agreed, pinned." }] });
});

test("a comment keeps its anchor across an unrelated commit and a nearby edit", async ({ page, seed, baseURL }) => {
  const { comments } = repos();
  const base = await commit({ "docs/survive.md": commentDocs()["docs/survive.md"] });
  await signInSeeded(page.context(), baseURL, seed, "owner");
  await open(page, comments, "docs/survive.md", base);
  const body = unique("Survives");
  await comment(page, "survives unrelated commits", body);

  // Another file changes: this page's blob is the same, so the anchor holds exactly.
  const unrelated = await commit({ "docs/other.md": `# Other\n\nVersion ${randomBytes(4).toString("hex")}.\n` });
  await open(page, comments, "docs/survive.md", unrelated);
  await expect(pin(page, body)).toBeVisible();
  // This page changes around the passage: a new blob, re-anchored by heading and quote.
  const edited = await commit({ "docs/survive.md": "# Survive\n\n## Notes\n\nA new opening line.\n\nThis sentence survives unrelated commits.\n" });
  await open(page, comments, "docs/survive.md", edited);
  await expect(pin(page, body)).toBeVisible();
  await openDrawer(page);
  await expect(card(page, body)).not.toHaveClass(/is-orphan/);
  // Reached through the sidebar (hovering warms the page in a hidden frame the shell then adopts, #245):
  // the comments follow the reader into whichever frame is shown.
  await open(page, comments, "docs/index.md", edited);
  const link = page.locator(".tree-link", { hasText: "Survive" });
  await link.hover();
  await link.click();
  await expect(page).toHaveURL(/\?doc=docs%2Fsurvive\.md$/);
  await expect(pin(page, body)).toBeVisible();
});

test("a comment whose text was deleted becomes an orphan in the drawer, never pinned elsewhere", async ({ page, seed, baseURL }) => {
  const { comments } = repos();
  const base = await commit({ "docs/orphan.md": commentDocs()["docs/orphan.md"] });
  await signInSeeded(page.context(), baseURL, seed, "owner");
  await open(page, comments, "docs/orphan.md", base);
  const body = unique("Doomed");
  await comment(page, "will be deleted", body);

  const deleted = await commit({ "docs/orphan.md": "# Orphan\n\n## Notes\n\nAnother paragraph stays.\n" });
  await open(page, comments, "docs/orphan.md", deleted);
  await openDrawer(page);
  await expect(card(page, body)).toHaveClass(/is-orphan/);
  await expect(card(page, body)).toContainText("Anchor no longer found");
  await expect(pin(page, body)).toBeHidden();
});

test("a reader who loses repository access loses its comments at once", async ({ page, seed, baseURL }) => {
  const { commentsPrivate } = repos();
  // Idempotent start: the owner is a collaborator (a retry may have removed them).
  expect(await collaborator("added")).toBe(202);
  try {
    await signInSeeded(page.context(), baseURL, seed, "owner");
    await open(page, commentsPrivate, "docs/private.md");
    const body = unique("Collaborators only");
    await comment(page, "Only collaborators", body);

    // GitHub removes the collaborator: the mirror denies, the epoch moves, and Convex drops the grant.
    expect(await collaborator("removed")).toBe(202);
    await expect(pin(page, body)).toHaveCount(0);
    const access = await page.request.post(`/r/${commentsPrivate.owner}/${commentsPrivate.name}/comment-access`, { headers: { Origin: baseURL! } });
    expect(access.status()).toBe(404);
    expect((await page.goto(`/r/${commentsPrivate.owner}/${commentsPrivate.name}?doc=docs%2Fprivate.md`))?.status()).toBe(404);
  } finally {
    expect(await collaborator("added")).toBe(202);
  }
});

test("an anonymous reader of a public repository sees its comments but cannot post", async ({ page, secondContext, seed, baseURL }) => {
  const { comments } = repos();
  const head = await commit({ "docs/guide.md": commentDocs()["docs/guide.md"] });
  await signInSeeded(page.context(), baseURL, seed, "owner");
  await open(page, comments, "docs/guide.md", head);
  const body = unique("Visible to all");
  await comment(page, "Call the API", body);

  const anonymous = await secondContext.newPage();
  await open(anonymous, comments, "docs/guide.md", head);
  await expect(pin(anonymous, body)).toBeVisible();
  await expect(ui(anonymous).getByTestId("commentor-comment-btn")).toBeDisabled();
  await select(anonymous, "before anything else");
  // Two frames later the chip would have opened for a reader who may write.
  await ui(anonymous).locator("article").evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(ui(anonymous).getByTestId("commentor-selection-action")).toHaveAttribute("data-state", "closed");
  // Convex refuses an anonymous write outright.
  const forged = await convexCallWith(undefined, "mutation", "repoComments:createThread", {
    repoId: 9004, path: "docs/guide.md", body: "Drive-by",
    anchor: { kind: "repo-text", blobSha: "a".repeat(40), headingSlug: "usage", prefix: "", exact: "Call", suffix: "", offset: 0 },
  });
  expect(forged).toMatchObject({ ok: false, code: "unauthenticated" });
});
