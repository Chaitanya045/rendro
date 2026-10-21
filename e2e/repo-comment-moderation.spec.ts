import type { Page } from "@playwright/test";
import { test, expect } from "./actor-fixtures";
import {
  addReply, anchorOn, card, convexCallWith, createThread, journeyDoc, memberRole, open, openDrawer, repoIds, repos, sessionToken, threadsAs, ui, unique, writeThread,
} from "./comment-helpers";
import { desktop } from "./shell-helpers";

/**
 * Maintainers moderate a repository's comments (#259) on the real Worker, the local Convex and the real control Worker,
 * against the harness's fake GitHub. The role is GitHub's: the member's role on comment-docs changes through the
 * `member` webhook GitHub would send, and what the widget offers and what Convex allows follow it. Every write is also
 * forged with the member's own session token, because the widget is not the boundary.
 */
test.use({ viewport: desktop });

test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

/** What the open drawer offers on the thread with this text: its status actions and its replies' delete buttons. */
async function offers(page: Page, body: string) {
  await openDrawer(page);
  const thread = card(page, body);
  await expect(thread).toBeVisible();
  const has = async (testId: string) => await thread.getByTestId(testId).count() > 0;
  return { resolve: await has("commentor-resolve-btn"), archive: await has("commentor-archive-btn"), delete: await has("commentor-delete-btn"), deleteReply: await has("commentor-delete-reply-btn") };
}

test("a maintainer archives and deletes other readers' comments; a writer cannot, and a demotion takes the rights back at once", async ({ actor, seeded }) => {
  test.setTimeout(300_000);
  const { comments } = repos();
  const doc = await journeyDoc("moderation");
  const scope = { repoId: repoIds.comments, path: doc.path };
  expect(await memberRole("none")).toBe(202);
  try {
    const author = await actor("moderation");
    await open(author.page, comments, doc.path, doc.commit);
    const authorToken = await sessionToken(author.page);
    const anchor = await anchorOn(author.page, "quick brown");
    const rude = unique("Rude remark");
    const noisy = unique("Noisy remark");
    const spam = unique("Spam remark");
    const rudeId = await createThread(authorToken, scope, rude, anchor);
    const noisyId = await createThread(authorToken, scope, noisy, anchor);
    const spamId = await createThread(authorToken, scope, spam, anchor);
    const replyText = unique("Spam reply");
    const replyId = await addReply(authorToken, scope, spamId, replyText);

    // A signed-in reader with no role may resolve and reply, never archive or delete: the widget offers neither, and the
    // same requests forged with their own token are refused.
    const member = await seeded("member");
    await open(member, comments, doc.path, doc.commit);
    const memberToken = await sessionToken(member);
    expect(await offers(member, rude)).toEqual({ resolve: true, archive: false, delete: false, deleteReply: false });
    for (const [label, result] of [
      ["archive", await writeThread(memberToken, scope, "archive", rudeId, { archived: true })],
      ["remove", await writeThread(memberToken, scope, "removeThread", rudeId)],
      ["remove reply", await convexCallWith(memberToken, "mutation", "repoComments:removeReply", { ...scope, threadId: spamId, replyId })],
    ] as const) expect(result, label).toMatchObject({ ok: false, code: "forbidden" });

    // Write (GitHub's `push`) and triage are triage roles here, not moderation: nothing changes.
    for (const role of ["write", "triage"] as const) {
      expect(await memberRole(role)).toBe(202);
      await open(member, comments, doc.path, doc.commit);
      expect(await offers(member, rude), role).toEqual({ resolve: true, archive: false, delete: false, deleteReply: false });
      expect(await writeThread(await sessionToken(member), scope, "archive", rudeId, { archived: true }), role).toMatchObject({ ok: false, code: "forbidden" });
    }

    // No request can say which role the reader holds: the Worker asks GitHub's mirror. A claimed role in the comment-access
    // request, and a forged call to the internal grant, change nothing.
    const forged = await member.request.post(`/r/${comments.owner}/${comments.name}/comment-access?path=${encodeURIComponent(doc.path)}&role=admin&moderator=true`, {
      headers: { Origin: new URL(member.url()).origin, "X-Rendro-Role": "admin" }, data: { role: "admin", moderator: true },
    });
    expect(forged.status()).toBe(200);
    expect(await convexCallWith(memberToken, "mutation", "repoCommentAccess:grantModerator", {
      internalSecret: "guessed", repoId: repoIds.comments, userId: "anyone", role: "admin", epoch: 0, expiresAt: Date.now() + 60_000,
    })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await writeThread(memberToken, scope, "archive", rudeId, { archived: true })).toMatchObject({ ok: false, code: "forbidden" });

    // A maintainer is offered Archive and Delete on everyone's comments, and Delete on their replies, and can use them.
    expect(await memberRole("maintain")).toBe(202);
    await open(member, comments, doc.path, doc.commit);
    expect(await offers(member, rude)).toEqual({ resolve: true, archive: true, delete: true, deleteReply: false });
    expect(await offers(member, spam)).toEqual({ resolve: true, archive: true, delete: true, deleteReply: true });
    await card(member, rude).getByTestId("commentor-archive-btn").click();
    await expect.poll(async () => (await threadsAs(authorToken, scope)).find(thread => thread._id === rudeId)?.archived).toBe(true);
    // The author's open page follows, and the History view holds it.
    await expect.poll(async () => await ui(author.page).locator(".content-head .count").getAttribute("aria-label")).toBe("2 active comments");
    expect((await writeThread(await sessionToken(member), scope, "archive", rudeId, { archived: false })).ok).toBe(true);
    // Deleting a comment is undoable for a moderator exactly as for an author: the write happens when the window ends.
    await card(member, noisy).getByTestId("commentor-delete-btn").click();
    await expect.poll(async () => (await threadsAs(authorToken, scope)).map(thread => thread._id), { timeout: 20_000 }).not.toContain(noisyId);
    await card(member, spam).getByTestId("commentor-delete-reply-btn").click();
    await expect.poll(async () => (await threadsAs(authorToken, scope)).find(thread => thread._id === spamId)?.replies.map(reply => reply.body), { timeout: 20_000 }).toEqual([]);
    expect(replyText).toBeTruthy();
    // Editing stays the author's: a maintainer cannot put words in someone else's mouth.
    expect(await convexCallWith(await sessionToken(member), "mutation", "repoComments:editThread", { ...scope, threadId: rudeId, body: "Rewritten" })).toMatchObject({ ok: false, code: "forbidden" });
    expect((await threadsAs(authorToken, scope)).find(thread => thread._id === rudeId)?.body).toBe(rude);

    // The role is withdrawn on GitHub: the webhook ends the grant, and the page that was open offers nothing more, with
    // no reload. Whatever the stale page or a forged call tries next is refused.
    expect(await memberRole("write")).toBe(202);
    await expect(card(member, rude).getByTestId("commentor-archive-btn")).toHaveCount(0);
    await expect(card(member, rude).getByTestId("commentor-delete-btn")).toHaveCount(0);
    expect(await writeThread(await sessionToken(member), scope, "removeThread", rudeId)).toMatchObject({ ok: false });
    await open(member, comments, doc.path, doc.commit);
    expect(await offers(member, rude)).toEqual({ resolve: true, archive: false, delete: false, deleteReply: false });
    expect(await writeThread(await sessionToken(member), scope, "removeThread", rudeId)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await writeThread(await sessionToken(member), scope, "archive", spamId, { archived: true })).toMatchObject({ ok: false, code: "forbidden" });
    expect((await threadsAs(authorToken, scope)).map(thread => thread._id).sort()).toEqual([rudeId, spamId].sort());
  } finally {
    expect(await memberRole("none")).toBe(202);
  }
});
