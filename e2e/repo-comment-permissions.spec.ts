import type { Page } from "@playwright/test";
import { test, expect } from "./actor-fixtures";
import {
  anchorOn, card, collaborator, comment, convexCallWith, convexSocket, createThread, journeyDoc, open, openDrawer, pauseClock, pin, repoIds, repos,
  sessionToken, startComment, threadsAs, ui, unique, writeThread, type CallResult,
} from "./comment-helpers";
import { desktop, signInSeeded } from "./shell-helpers";

/**
 * Who may do what with comments on repository docs (#302, ported from the project-document permission spec #286
 * removed): what the widget offers each reader, and what Convex answers when the same request is forged. Refusals are
 * public error codes, never message text. Each signed-in writer here is a fresh account, so spending one's write
 * allowance never slows another test down.
 */
test.use({ viewport: desktop });

test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

type Offer = { resolve: boolean; archive: boolean; delete: boolean; reply: boolean };
/** The actions the open drawer offers on each thread, keyed by the comment's text. */
async function offers(page: Page): Promise<Record<string, Offer>> {
  await openDrawer(page);
  await expect(ui(page).locator(".drawer-thread").first()).toBeVisible();
  return ui(page).locator(".drawer-thread").evaluateAll(cards => Object.fromEntries(cards.map(card => {
    const has = (selector: string) => card.querySelector(selector) !== null;
    return [card.querySelector(".thread-view > .body")?.textContent ?? "", {
      resolve: has('.thread-view > .head [data-testid="commentor-resolve-btn"]'), archive: has('.thread-view > .head [data-testid="commentor-archive-btn"]'),
      delete: has('.thread-view > .head [data-testid="commentor-delete-btn"]'), reply: has('[data-testid="commentor-reply-input"]'),
    }];
  })));
}

/** Every write a reader could forge against one thread, with its result. */
async function forgedWrites(token: string | undefined, scope: { repoId: number; path: string }, threadId: string, anchor: Awaited<ReturnType<typeof anchorOn>>): Promise<Array<[string, CallResult]>> {
  return [
    ["create", await convexCallWith(token, "mutation", "repoComments:createThread", { ...scope, body: "Intruder", anchor })],
    ["reply", await convexCallWith(token, "mutation", "repoComments:addReply", { ...scope, threadId, body: "Intruder" })],
    ["resolve", await writeThread(token, scope, "resolve", threadId, { resolved: true })],
    ["archive", await writeThread(token, scope, "archive", threadId, { archived: true })],
    ["remove", await writeThread(token, scope, "removeThread", threadId)],
  ];
}

test("an outsider is refused a private repository's comments, and anonymous readers read a public one's but cannot write", async ({ page, secondContext, seeded, seed, baseURL }) => {
  test.setTimeout(240_000);
  const { comments, commentsPrivate } = repos();
  // Idempotent start: the owner is a collaborator (a retry of another spec may have removed them).
  expect(await collaborator("added")).toBe(202);
  await signInSeeded(page.context(), baseURL, seed, "owner");
  await open(page, commentsPrivate, "docs/private.md");
  const secret = unique("Collaborators only");
  await comment(page, "Only collaborators", secret);
  const privateScope = { repoId: repoIds.commentsPrivate, path: "docs/private.md" };
  const ownerToken = await sessionToken(page);
  const privateThread = (await threadsAs(ownerToken, privateScope)).find(thread => thread.body === secret)!;
  const privateAnchor = await anchorOn(page, "Only collaborators");

  // The outsider (signed in, linked to GitHub, no access to the repository) gets the read path's plain 404 for the page and
  // for comment access, an empty page from Convex, and "not found" for every write: nothing tells the thread exists.
  const outsider = await seeded("outsider");
  const url = `/r/${commentsPrivate.owner}/${commentsPrivate.name}`;
  expect((await outsider.goto(`${url}?doc=docs%2Fprivate.md`))?.status()).toBe(404);
  expect((await outsider.request.post(`${url}/comment-access?path=docs%2Fprivate.md`, { headers: { Origin: baseURL! } })).status()).toBe(404);
  const outsiderToken = await sessionToken(outsider);
  expect(outsiderToken).toBeTruthy();
  expect(await threadsAs(outsiderToken, privateScope)).toEqual([]);
  expect(await convexCallWith(outsiderToken, "query", "repoComments:listReplies", { ...privateScope, threadId: privateThread._id, paginationOpts: { numItems: 20, cursor: null } }))
    .toMatchObject({ ok: true, value: { page: [], isDone: true } });
  for (const [label, result] of await forgedWrites(outsiderToken, privateScope, privateThread._id, privateAnchor)) {
    expect(result, label).toMatchObject({ ok: false, code: "not_found" });
  }
  // An anonymous visitor is refused the same way.
  const anonymous = await secondContext.newPage();
  expect((await anonymous.goto(`${url}?doc=docs%2Fprivate.md`))?.status()).toBe(404);
  expect(await threadsAs(undefined, privateScope)).toEqual([]);
  for (const [label, result] of await forgedWrites(undefined, privateScope, privateThread._id, privateAnchor)) {
    expect(result, label).toMatchObject({ ok: false, code: "not_found" });
  }
  // Nothing was written by any of the refused callers.
  expect((await threadsAs(ownerToken, privateScope)).find(thread => thread._id === privateThread._id)).toMatchObject({ body: secret, resolved: false, archived: false, replies: [] });

  // A public repository's comments are anyone's to read: the anonymous reader sees the thread and its reply, and is
  // offered no way to write, resolve, archive or delete.
  const doc = await journeyDoc("anonymous");
  const scope = { repoId: repoIds.comments, path: doc.path };
  await open(page, comments, doc.path, doc.commit);
  await comment(page, "quick brown", "Visible to everyone");
  await pin(page, "Visible to everyone").click();
  const bubble = ui(page).getByTestId("commentor-thread-bubble");
  await bubble.getByTestId("commentor-reply-input").fill("A reply anyone reads");
  await bubble.getByTestId("commentor-reply-send").click();
  await expect(bubble.locator(".reply:not(.is-sending)")).toContainText("A reply anyone reads");
  const [thread] = await threadsAs(ownerToken, scope);
  await open(anonymous, comments, doc.path, doc.commit);
  await expect(pin(anonymous, "Visible to everyone")).toBeVisible();
  await expect(ui(anonymous).getByTestId("commentor-comment-btn")).toBeDisabled();
  expect(await offers(anonymous)).toEqual({ "Visible to everyone": { resolve: false, archive: false, delete: false, reply: false } });
  await expect(card(anonymous, "Visible to everyone").locator(".reply")).toContainText("A reply anyone reads");
  // Convex refuses every anonymous write outright.
  for (const [label, result] of await forgedWrites(undefined, scope, thread._id, await anchorOn(page, "quick brown"))) {
    expect(result, label).toMatchObject({ ok: false, code: "unauthenticated" });
  }

  // A signed-in reader who is not the author may triage (resolve, reply) but not archive or delete; forging those is refused.
  const member = await seeded("member");
  await open(member, comments, doc.path, doc.commit);
  expect(await offers(member)).toEqual({ "Visible to everyone": { resolve: true, archive: false, delete: false, reply: true } });
  const memberToken = await sessionToken(member);
  expect(await writeThread(memberToken, scope, "archive", thread._id, { archived: true })).toMatchObject({ ok: false, code: "forbidden" });
  expect(await writeThread(memberToken, scope, "removeThread", thread._id)).toMatchObject({ ok: false, code: "forbidden" });
  expect((await threadsAs(undefined, scope))).toEqual([expect.objectContaining({ _id: thread._id, resolved: false, archived: false, replies: [expect.objectContaining({ body: "A reply anyone reads" })] })]);
});

test("a writer over the comment limit sees the post as sending, gets it back with the draft and a countdown, and posts once it lapses", async ({ actor }) => {
  test.setTimeout(240_000);
  const { comments } = repos();
  const doc = await journeyDoc("limits");
  const scope = { repoId: repoIds.comments, path: doc.path };
  const writer = await actor("limits");
  const { page } = writer;
  // The page clock runs as usual except while the test inspects a countdown, which it pauses so the notice cannot end
  // first. The writer's request is held on its way out until the allowance is spent through the API, so the refusal never
  // depends on who wins a race for a refilled token.
  await page.clock.install();
  const socket = await convexSocket(page);
  await open(page, comments, doc.path, doc.commit);
  const token = await sessionToken(page);
  const me = ui(page);
  const quota = me.locator(".comment-quota");
  const announced = me.locator(".quota-live");
  const overLimit = /Too many comments right now; try again in [1-9]\d* seconds?\./;
  // Fillers go to a page of their own, so this page only shows what the writer posts through the widget.
  const fillerScope = { repoId: repoIds.comments, path: `${doc.path.replace(/\.md$/, "")}-filler.md` };
  const anchor = await anchorOn(page, "quick brown");
  /** Spend the writer's allowance (thirty a minute, shared by threads and replies), one write at a time, until the next token is a while off. */
  const spend = async () => {
    let allowed = 0;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const result = await convexCallWith(token, "mutation", "repoComments:createThread", { ...fillerScope, body: "Filler", anchor });
      if (result.ok) { allowed += 1; continue; }
      expect(result).toMatchObject({ ok: false, code: "RateLimited", retryAfter: expect.any(Number) });
      if ((result.retryAfter ?? 0) > 1_000) return allowed;
    }
    throw new Error("The comment allowance was never spent");
  };
  /** When the wait ends the end is announced and `send` posts. The server's allowance refills in real time, so a retry that
   * arrives early is refused with a fresh notice and the writer simply tries again. */
  const retryOnceLapsed = async (send: () => Promise<void>, settled: () => Promise<boolean>) => {
    await expect(async () => {
      await expect(announced).toHaveText("You can post comments again now.", { timeout: 5_000 });
      await send();
      await expect.poll(async () => await settled() ? "posted" : overLimit.test(await announced.innerText()) ? "refused" : "pending", { timeout: 15_000 }).not.toBe("pending");
      expect(await settled()).toBe(true);
    }).toPass({ timeout: 90_000 });
  };

  // A reply shows at once in its thread as sending, with the reply input locked and empty.
  const threadId = await createThread(token, scope, "Reply target", anchor);
  await openDrawer(page);
  const target = card(page, "Reply target");
  const replyInput = target.getByTestId("commentor-reply-input");
  const replySend = target.getByTestId("commentor-reply-send");
  await replyInput.fill("A reply over the limit");
  socket.hold(true);
  await replySend.click();
  const sendingReply = target.locator(".reply.is-sending");
  await expect(sendingReply).toHaveCount(1);
  await expect(sendingReply).toContainText("A reply over the limit");
  await expect(sendingReply.getByTestId("commentor-sending")).toHaveText("Sending…");
  await expect(replyInput).toHaveValue("");
  await expect(replyInput).toBeDisabled();
  await expect.poll(() => socket.heldMessage("repoComments:addReply")).toBe(true);
  expect(await spend()).toBeGreaterThanOrEqual(25);
  await pauseClock(page);
  socket.release();
  // Refused: the reply is taken back and its text returns to the input, which waits out the countdown.
  await expect(quota).toContainText(overLimit);
  await expect(target.locator(".reply")).toHaveCount(0);
  await expect(replyInput).toHaveValue("A reply over the limit");
  await expect(replySend).toBeDisabled();
  // The reason is announced politely once, rather than on every countdown tick.
  await expect(announced).toHaveText(overLimit);
  expect((await threadsAs(token, scope)).find(thread => thread._id === threadId)?.replies).toEqual([]);
  await page.clock.resume();
  await retryOnceLapsed(() => replySend.click(), async () => await target.locator(".reply:not(.is-sending)").count() === 1);
  await expect.poll(async () => (await threadsAs(token, scope)).find(thread => thread._id === threadId)?.replies.map(reply => reply.body)).toEqual(["A reply over the limit"]);

  // A new thread shows at once as sending: the composer closes, and the thread is pinned and listed with no actions yet.
  const composer = me.getByTestId("commentor-composer");
  const post = me.getByTestId("commentor-composer-post");
  await startComment(page, "lazy dog");
  await me.getByTestId("commentor-composer-textarea").fill("A thread over the limit");
  socket.hold(true);
  await post.click();
  await expect(composer).toHaveCount(0);
  const sendingThread = me.locator(".drawer-thread.is-sending");
  await expect(sendingThread).toHaveCount(1);
  await expect(sendingThread).toContainText("A thread over the limit");
  await expect(sendingThread.getByTestId("commentor-sending")).toHaveText("Sending…");
  await expect(sendingThread.getByTestId("commentor-resolve-btn")).toHaveCount(0);
  await expect(me.locator('[data-testid="commentor-pin"].is-sending')).toHaveCount(1);
  await expect.poll(() => socket.heldMessage("repoComments:createThread")).toBe(true);
  await spend();
  await pauseClock(page);
  socket.release();
  // Refused: the thread is taken back and the composer reopens with the draft, its Post held until the limit lapses.
  await expect(quota).toContainText(overLimit);
  await expect(sendingThread).toHaveCount(0);
  await expect(me.locator('[data-testid="commentor-pin"].is-sending')).toHaveCount(0);
  await expect(me.getByTestId("commentor-composer-textarea")).toHaveValue("A thread over the limit");
  await expect(post).toBeDisabled();
  await expect(announced).toHaveText(overLimit);
  expect((await threadsAs(token, scope)).some(thread => thread.body === "A thread over the limit")).toBe(false);
  await page.clock.resume();
  await retryOnceLapsed(() => post.click(), async () => await composer.count() === 0 && await sendingThread.count() === 0);
  await expect(pin(page, "A thread over the limit")).toBeVisible();
  await expect.poll(async () => (await threadsAs(token, scope)).filter(thread => thread.body === "A thread over the limit")).toHaveLength(1);
});
