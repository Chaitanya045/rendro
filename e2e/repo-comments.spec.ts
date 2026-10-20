import { randomBytes } from "node:crypto";
import { test, expect } from "./fixtures";
import {
  anchorOn, card, collaborator, comment, commit, convexCallWith, convexSocket, createThread, journeyDoc, open, openDrawer, pin, publicThreads, repoIds, repos,
  select, sessionToken, ui, unique,
} from "./comment-helpers";
import { desktop, signInSeeded } from "./shell-helpers";
import { commentDocs } from "./repo-fixtures";

/**
 * Comments on repository docs (#254), end to end: the repository shell holds the one Convex connection, the document
 * frame runs the widget under its own policy, Convex decides access from the grant the read path records, and the
 * control Worker (P5) revokes it with the reader's epoch. Each test resets the page it uses with its own commit and
 * writes comments with a body of its own, so tests stay independent across retries and shards.
 */
test.use({ viewport: desktop });

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

test("the first comments carry the signed-in author's Archive and Delete before the live page, and nobody else's", async ({ page, secondContext, seed, baseURL }) => {
  test.setTimeout(120_000);
  const { comments, commentsPrivate } = repos();
  // Idempotent start: the owner is a collaborator of the private repository (a retry of another spec may have removed them).
  expect(await collaborator("added")).toBe(202);
  const doc = await journeyDoc("first-actions");
  await signInSeeded(page.context(), baseURL, seed, "owner");
  await open(page, comments, doc.path, doc.commit);
  const body = unique("Mine from the start");
  await createThread(await sessionToken(page), { repoId: repoIds.comments, path: doc.path }, body, await anchorOn(page, "quick brown"));

  // Only the shell's first access answer can show comments: the Convex socket carries nothing the page sends (#303).
  const firstPaint = async (reader: typeof page, repo: { owner: string; name: string }, path: string, commitSha?: string) => {
    const socket = await convexSocket(reader);
    socket.hold(true);
    // Not `open`: with the socket held the live page stays loading, which is the point.
    const response = await reader.goto(`/r/${repo.owner}/${repo.name}${commitSha ? `/@${commitSha}` : ""}?doc=${encodeURIComponent(path)}`);
    expect(response?.status()).toBe(200);
    await expect(ui(reader).getByTestId("commentor-dock")).toBeAttached();
    await openDrawer(reader);
    return socket;
  };
  const author = await page.context().newPage();
  const socket = await firstPaint(author, comments, doc.path, doc.commit);
  await expect(card(author, body)).toBeVisible();
  // The author's actions are there with the first paint of the thread; nothing has come from the live subscription.
  await expect(card(author, body).getByTestId("commentor-archive-btn")).toBeVisible();
  await expect(card(author, body).getByTestId("commentor-delete-btn")).toBeVisible();
  // The page's subscription is held on its way out: it is asked for, and never answered while the test looks.
  await expect.poll(() => socket.heldMessage("repoComments:listThreads")).toBe(true);
  await expect(card(author, body).getByTestId("commentor-delete-btn")).toBeVisible();
  await author.close();

  // An anonymous reader of the same public page sees the thread with neither.
  const anonymous = await secondContext.newPage();
  await firstPaint(anonymous, comments, doc.path, doc.commit);
  await expect(card(anonymous, body)).toBeVisible();
  await expect(card(anonymous, body).getByTestId("commentor-archive-btn")).toHaveCount(0);
  await expect(card(anonymous, body).getByTestId("commentor-delete-btn")).toHaveCount(0);

  // A private repository's first page was already its reader's, and still is.
  await open(page, commentsPrivate, "docs/private.md");
  const secret = unique("Private and mine");
  await comment(page, "Only collaborators", secret);
  const privateReader = await page.context().newPage();
  await firstPaint(privateReader, commentsPrivate, "docs/private.md");
  await expect(card(privateReader, secret).getByTestId("commentor-delete-btn")).toBeVisible();
  await expect(card(privateReader, secret).getByTestId("commentor-archive-btn")).toBeVisible();
});
