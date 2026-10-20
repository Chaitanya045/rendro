import type { Page } from "@playwright/test";
import { test, expect, fullOrganization, join } from "./org-fixtures";
import { api } from "./shell-helpers";
import { addReply, commentSite, convexCall, convexCallWith, convexSocket, createThread, heading, intro, openDocument, pauseClock, removeReply, sessionToken, startSelectionComment, threadsOf, widget, writeThread } from "./comment-helpers";
import { withKey } from "./project-helpers";

/**
 * Who may do what with comments (#115): the controls the widget offers to each role and what the server accepts when the
 * same request is forged. Roles are real organization members; the share viewer and public publication are real
 * anonymous visitors. Server refusals are public error codes (never message text).
 */
type Offer = { resolve: boolean; archive: boolean; delete: boolean; replies: Record<string, boolean> };

/** The actions the open drawer offers on each thread and reply, keyed by the comment's text. */
async function offers(page: Page): Promise<Record<string, Offer>> {
  const ui = widget(page);
  const panel = ui.getByTestId("commentor-panel-btn");
  if (await panel.getAttribute("aria-expanded") !== "true") await panel.click();
  await expect(ui.locator(".drawer-thread").first()).toBeVisible();
  return ui.locator(".drawer-thread").evaluateAll(cards => Object.fromEntries(cards.map(card => {
    const has = (id: string) => card.querySelector(`.thread-view > .head [data-testid="${id}"]`) !== null;
    return [card.querySelector(".thread-view > .body")?.textContent ?? "", {
      resolve: has("commentor-resolve-btn"), archive: has("commentor-archive-btn"), delete: has("commentor-delete-btn"),
      replies: Object.fromEntries([...card.querySelectorAll(".reply")].map(reply => [[...reply.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim(), reply.querySelector('[data-testid="commentor-delete-reply-btn"]') !== null])),
    }];
  })));
}
const everything: Offer = { resolve: true, archive: true, delete: true, replies: {} };

async function team(actor: Parameters<typeof commentSite>[0]) {
  const site = await commentSite(actor, "roles");
  const admin = await actor("admin");
  const first = await actor("first");
  const second = await actor("second");
  await join(site.owner, site.organizationId, admin, "admin");
  await join(site.owner, site.organizationId, first, "member");
  await join(site.owner, site.organizationId, second, "member");
  return { site, admin, first, second };
}

test.describe("roles", () => {
  test("each role is offered exactly the actions it may perform, and forged requests are refused by the server", async ({ actor }) => {
    test.setTimeout(240_000);
    const { site, admin, first, second } = await team(actor);
    const mine = await createThread(first.page, site, "First member's thread", heading);
    await addReply(first.page, site, mine, "Reply by the first member");
    const theirReply = await addReply(second.page, site, mine, "Reply by the second member");
    const theirs = await createThread(second.page, site, "Second member's thread", intro);

    // Owners and admins moderate everything; a member moderates only their own comments but triages everyone's.
    const moderator = (replies: string[]): Offer => ({ ...everything, replies: Object.fromEntries(replies.map(text => [text, true])) });
    const both = ["Reply by the first member", "Reply by the second member"];
    const expected = new Map<Page, Record<string, Offer>>([
      [site.owner.page, { "First member's thread": moderator(both), "Second member's thread": moderator([]) }],
      [admin.page, { "First member's thread": moderator(both), "Second member's thread": moderator([]) }],
      [first.page, {
        "First member's thread": { ...everything, replies: { "Reply by the first member": true, "Reply by the second member": false } },
        "Second member's thread": { resolve: true, archive: false, delete: false, replies: {} },
      }],
      [second.page, {
        "First member's thread": { resolve: true, archive: false, delete: false, replies: { "Reply by the first member": false, "Reply by the second member": true } },
        "Second member's thread": everything,
      }],
    ]);
    for (const [page, offered] of expected) {
      await openDocument(page, site);
      await expect(widget(page).getByTestId("commentor-comment-btn")).toBeEnabled();
      expect(await offers(page)).toEqual(offered);
      await expect(widget(page).getByTestId("commentor-reply-input").first()).toBeEnabled();
    }

    // Forged requests: what the UI hides, the server refuses with a public code, and nothing changes.
    const before = JSON.stringify((await threadsOf(site.owner.page, site)).map(thread => [thread._id, thread.archived, thread.resolved, thread.replies.length]));
    for (const [label, result] of [
      ["archive", await writeThread(second.page, site, "archive", mine, { archived: true })],
      ["remove", await writeThread(second.page, site, "remove", mine)],
      ["reply removal", await removeReply(first.page, site, mine, theirReply)],
      ["other member's archive", await writeThread(first.page, site, "archive", theirs, { archived: true })],
    ] as const) {
      expect(result, label).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(JSON.stringify((await threadsOf(site.owner.page, site)).map(thread => [thread._id, thread.archived, thread.resolved, thread.replies.length]))).toBe(before);
    // Triage is open to every member, and it is reversible.
    expect((await writeThread(second.page, site, "resolve", mine, { resolved: true })).ok).toBe(true);
    expect((await threadsOf(site.owner.page, site)).find(thread => thread._id === mine)?.resolved).toBe(true);
    expect((await writeThread(second.page, site, "resolve", mine, { resolved: false })).ok).toBe(true);
    // An admin may remove another person's reply and thread.
    expect((await removeReply(admin.page, site, mine, theirReply)).ok).toBe(true);
    expect((await writeThread(admin.page, site, "remove", theirs)).ok).toBe(true);
    await expect.poll(async () => (await threadsOf(site.owner.page, site)).map(thread => thread._id)).toEqual([mine]);
  });

  test("an outsider and an anonymous visitor can neither read nor write comments, and share and public viewers offer none", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(240_000);
    const site = await commentSite(actor, "visitors");
    const thread = await createThread(site.owner.page, site, "Private thread", heading);
    const outsider = await actor("outsider", { organizations: ["Elsewhere"], project: true });
    const anonymous = await secondContext.newPage();

    // The outsider (a member of another organization) is refused by the server for every operation, and the shell denies the document.
    const scope = { organizationId: site.organizationId, projectId: site.projectId, documentPath: "index.html" };
    for (const [label, result] of [
      ["list", await convexCall(outsider.page, "query", "documentThreads:list", { ...scope, paginationOpts: { numItems: 20, cursor: null } })],
      ["create", await convexCall(outsider.page, "mutation", "documentThreads:create", { ...scope, body: "Intruder", anchor: heading })],
      ["resolve", await writeThread(outsider.page, site, "resolve", thread, { resolved: true })],
      ["remove", await writeThread(outsider.page, site, "remove", thread)],
      ["reply", await convexCall(outsider.page, "mutation", "documentReplies:add", { ...scope, threadId: thread, body: "Intruder" })],
    ] as const) {
      expect(result, label).toMatchObject({ ok: false, code: "not_found" });
    }
    const denied = await outsider.page.goto(`${site.docs}?doc=index.html`);
    expect(denied?.status()).toBeGreaterThanOrEqual(400);
    await expect(outsider.page.locator("#content-frame")).toHaveCount(0);

    // An anonymous caller has no session token at all.
    await anonymous.goto("/");
    for (const [label, result] of [
      ["list", await convexCall(anonymous, "query", "documentThreads:list", { ...scope, paginationOpts: { numItems: 20, cursor: null } })],
      ["create", await convexCall(anonymous, "mutation", "documentThreads:create", { ...scope, body: "Anonymous", anchor: heading })],
    ] as const) {
      expect(result, label).toMatchObject({ ok: false, code: "unauthenticated" });
    }
    expect((await anonymous.request.get(site.docs)).url()).not.toContain("/docs");

    // A private share and a public publication show the document with no comment surface and no widget script.
    const share = await api<{ url: string }>(site.owner.page, "/api/rendro/shares", { organizationId: site.organizationId, projectId: site.projectId, documentPath: "index.html", expiresInSeconds: 3600 });
    expect(share.status).toBe(201);
    const slug = `visitors-${site.organizationId.slice(-8)}`.toLowerCase();
    const published = await withKey(site.key, "/api/rendro/publications", { organizationId: site.organizationId, projectId: site.projectId, slug, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: "Public" });
    expect(published.status).toBeLessThan(300);
    for (const url of [new URL(share.body.url, baseURL).pathname, `/p/${slug}`]) {
      await anonymous.goto(url);
      const frame = anonymous.frameLocator("#content-frame");
      await expect(frame.getByRole("heading", { name: "Quarterly report" })).toBeVisible();
      await expect(frame.locator("#commentor-host")).toHaveCount(0);
      await expect(frame.getByTestId("commentor-dock")).toHaveCount(0);
      expect(await anonymous.frames().find(candidate => candidate !== anonymous.mainFrame())!.evaluate(() => "COMMENTOR" in window)).toBe(false);
      expect(await anonymous.evaluate(() => Object.keys(window).filter(key => /commentor/i.test(key)))).toEqual([]);
    }
    // Nothing was written by any of the refused callers.
    expect((await threadsOf(site.owner.page, site)).map(entry => entry.body)).toEqual(["Private thread"]);
  });

  test("a role change reaches an open document, and a removed member loses the comments", async ({ actor }) => {
    test.setTimeout(240_000);
    const { site, admin, first } = await team(actor);
    await createThread(first.page, site, "Member's thread", heading);
    await openDocument(admin.page, site);
    expect(await offers(admin.page)).toEqual({ "Member's thread": everything });

    // Demoted while the drawer is open: the moderation controls go away without a reload, and the server agrees.
    const members = await fullOrganization(site.owner.page, site.organizationId);
    const memberId = members.body.members.find(entry => entry.user.email === admin.email)!.id;
    expect((await api(site.owner.page, "/api/auth/organization/update-member-role", { memberId, role: "member", organizationId: site.organizationId })).status).toBe(200);
    await expect.poll(() => offers(admin.page)).toEqual({ "Member's thread": { resolve: true, archive: false, delete: false, replies: {} } });
    const [thread] = await threadsOf(site.owner.page, site);
    expect(await writeThread(admin.page, site, "remove", thread._id)).toMatchObject({ ok: false, code: "forbidden" });

    // Removed from the organization: every operation is refused as if the project did not exist.
    expect((await api(site.owner.page, "/api/auth/organization/remove-member", { memberIdOrEmail: memberId, organizationId: site.organizationId })).status).toBe(200);
    expect(await writeThread(admin.page, site, "resolve", thread._id, { resolved: true })).toMatchObject({ ok: false, code: "not_found" });
    expect((await threadsOf(site.owner.page, site))[0].resolved).toBe(false);
  });
});

test.describe("write limits", () => {
  test("a writer over the comment limit gets a friendly error with a retry hint, keeps the draft and can post once it lapses", async ({ actor }) => {
    test.setTimeout(180_000);
    const site = await commentSite(actor, "limits");
    const { page } = site.owner;
    // The widget's countdown runs on the page clock, which only the test advances, so the notice can be inspected before it
    // ends. The server's allowance refills in real time and is spent through the API, so the widget's request is held on
    // its way out until the allowance is empty: the refusal does not depend on who wins a race for a refilled token.
    await page.clock.install();
    const socket = await convexSocket(page);
    await openDocument(page, site);
    const ui = widget(page);
    await startSelectionComment(page);
    await ui.getByTestId("commentor-composer-textarea").fill("Over the limit");
    await pauseClock(page);
    socket.hold(true);
    const post = ui.getByTestId("commentor-composer-post");
    await post.click();
    // Optimistic (#284): the thread shows at once as sending while the write is held.
    await expect(ui.locator(".drawer-thread.is-sending")).toHaveCount(1);
    await expect.poll(() => socket.heldMessage("documentThreads:create")).toBe(true);

    // Spend the signed-in person's allowance (thirty a minute, shared by threads and replies), one write at a time since
    // concurrent writers to a bucket conflict with each other rather than with the limit, until the next token is a while off.
    const token = await sessionToken(page);
    const fill = () => convexCallWith(token, "mutation", "documentThreads:create", { organizationId: site.organizationId, projectId: site.projectId, documentPath: "index.html", body: "Filler", anchor: heading });
    let allowed = 0;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const result = await fill();
      if (result.ok) { allowed += 1; continue; }
      expect(result).toMatchObject({ ok: false, code: "RateLimited", retryAfter: expect.any(Number) });
      if ((result.retryAfter ?? 0) > 1_000) break;
    }
    expect(allowed).toBeGreaterThanOrEqual(25);
    socket.release();
    await expect(ui.locator(".comment-quota")).toContainText(/Too many comments right now; try again in [1-9]\d* seconds?\./);
    // The thread is taken back and the composer reopens with the draft, its Post held until the limit lapses.
    await expect(ui.locator(".drawer-thread.is-sending")).toHaveCount(0);
    await expect(post).toBeDisabled();
    await expect(ui.getByTestId("commentor-composer-textarea")).toHaveValue("Over the limit");
    // The reason is announced politely once, rather than on every countdown tick.
    await expect(ui.locator(".quota-live")).toHaveText(/Too many comments right now; try again in [1-9]\d* seconds?\./);
    expect((await threadsOf(page, site)).some(thread => thread.body === "Over the limit")).toBe(false);

    // When the wait ends the end is announced and the same draft posts. The server's allowance refills in real time, so a
    // retry that arrives early is refused with a fresh notice and the person simply tries again.
    await expect(async () => {
      await page.clock.runFor(2_500);
      await expect(ui.locator(".quota-live")).toHaveText("You can post comments again now.", { timeout: 2_000 });
      await expect(post).toBeEnabled();
      await post.click();
      // The page clock is paused, so the widget's own timers advance only when the test moves them.
      await expect.poll(async () => {
        await page.clock.runFor(100);
        // The composer closes at once (#284); the post has landed once its optimistic thread has settled too.
        if (await ui.getByTestId("commentor-composer").count() === 0 && await ui.locator(".drawer-thread.is-sending").count() === 0) return "posted";
        return /^Too many comments/.test(await ui.locator(".quota-live").innerText()) ? "refused" : "pending";
      }, { timeout: 15_000 }).not.toBe("pending");
      await expect(ui.getByTestId("commentor-composer")).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 90_000 });
    expect((await threadsOf(page, site)).filter(thread => thread.body === "Over the limit")).toHaveLength(1);
  });
});
