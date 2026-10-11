import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import { fixture } from "./helpers/comment-fixture";

const anchor = { kind: "element" as const, path: ["main"] };
afterEach(() => vi.useRealTimers());

describe("document comment operation identities", () => {
  it("deduplicates concurrent creates and replies, without colliding across authors, documents or organizations", async () => {
    const { backend, viewers, scope, data } = await fixture();
    const args = { ...scope, body: "Once", anchor, clientOperationId: "same-id" };
    const [first, duplicate] = await Promise.all([
      viewers.author.mutation(api.documentThreads.create, args), viewers.author.mutation(api.documentThreads.create, args),
    ]);
    expect(first).toBe(duplicate);
    const different = await viewers.author.mutation(api.documentThreads.create, { ...args, clientOperationId: "different" });
    const otherAuthor = await viewers.member.mutation(api.documentThreads.create, args);
    const otherDocument = await viewers.author.mutation(api.documentThreads.create, { ...args, documentPath: "other.html" });
    const projectId = await backend.run((ctx) => ctx.db.insert("projects", {
      organizationId: data.otherOrgId, name: "Other", slug: "other", createdBy: data.users[0].userId, createdAt: Date.now(),
    }));
    const otherOrg = await viewers.outsider.mutation(api.documentThreads.create, { ...args, organizationId: data.otherOrgId, projectId });
    expect(new Set([first, different, otherAuthor, otherDocument, otherOrg]).size).toBe(5);
    expect((await backend.run((ctx) => ctx.db.query("documentThreads").collect())).filter((t) => t.clientOperationId)).toHaveLength(5);
    const reply = { ...scope, threadId: first, body: "Reply once", clientOperationId: "same-id" };
    const [r1, r2] = await Promise.all([
      viewers.author.mutation(api.documentReplies.add, reply), viewers.author.mutation(api.documentReplies.add, reply),
    ]);
    expect(r1).toBe(r2);
    const r3 = await viewers.author.mutation(api.documentReplies.add, { ...reply, clientOperationId: "different" });
    const r4 = await viewers.member.mutation(api.documentReplies.add, reply);
    const r5 = await viewers.author.mutation(api.documentReplies.add, { ...reply, threadId: different });
    const r6 = await viewers.outsider.mutation(api.documentReplies.add, { ...reply, organizationId: data.otherOrgId, projectId, threadId: otherOrg });
    expect(new Set([r1, r3, r4, r5, r6]).size).toBe(5);
    expect((await backend.run((ctx) => ctx.db.query("documentReplies").collect())).filter((r) => r.clientOperationId)).toHaveLength(5);
  });

  it("sets both status targets idempotently and keeps permission checks", async () => {
    const { backend, viewers, scope, threadId } = await fixture();
    for (const target of [true, false]) {
      for (let i = 0; i < 2; i++) {
        await viewers.member.mutation(api.documentThreads.resolve, { ...scope, threadId, resolved: target, clientOperationId: `resolve-${target}` });
        await viewers.author.mutation(api.documentThreads.archive, { ...scope, threadId, archived: target, clientOperationId: `archive-${target}` });
      }
      expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ resolved: target, archived: target });
    }
    await expect(viewers.member.mutation(api.documentThreads.archive, { ...scope, threadId, archived: false, clientOperationId: "archive-false" })).rejects.toThrow("Only the comment author");
  });

  it("retains dedup keys after deletion so late creates cannot resurrect comments", async () => {
    const { backend, viewers, scope } = await fixture();
    const create = { ...scope, body: "Delete me", anchor, clientOperationId: "create" };
    const threadId = await viewers.author.mutation(api.documentThreads.create, create);
    const reply = { ...scope, threadId, body: "Delete reply", clientOperationId: "reply" };
    const replyId = await viewers.author.mutation(api.documentReplies.add, reply);
    const removeReply = { ...scope, threadId, replyId, clientOperationId: "remove-reply" };
    await viewers.author.mutation(api.documentReplies.remove, removeReply);
    await viewers.author.mutation(api.documentReplies.remove, removeReply);
    expect(await viewers.author.mutation(api.documentReplies.add, reply)).toBe(replyId);
    expect((await viewers.author.query(api.documentReplies.list, { ...scope, threadId, paginationOpts: { cursor: null, numItems: 20 } })).page).toEqual([]);
    await expect(viewers.member.mutation(api.documentReplies.remove, removeReply)).rejects.toThrow("Only the comment author");
    vi.useFakeTimers();
    const remove = { ...scope, threadId, clientOperationId: "remove" };
    await viewers.author.mutation(api.documentThreads.remove, remove);
    await viewers.author.mutation(api.documentThreads.remove, remove);
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    await viewers.author.mutation(api.documentThreads.remove, remove);
    await viewers.author.mutation(api.documentReplies.remove, removeReply);
    expect(await viewers.author.mutation(api.documentThreads.create, create)).toBe(threadId);
    expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ deletedAt: expect.any(Number), body: "" });
    await expect(viewers.member.mutation(api.documentThreads.remove, remove)).rejects.toThrow("Only the comment author");
  });

  it("retains scrubbed legacy records for authorized deletion retries after cleanup", async () => {
    const { backend, viewers, scope, threadId, replyId } = await fixture();
    const reply = { ...scope, threadId, replyId, clientOperationId: "remove-reply" };
    await viewers.author.mutation(api.documentReplies.remove, reply);
    await viewers.author.mutation(api.documentReplies.remove, reply);
    vi.useFakeTimers();
    await viewers.author.mutation(api.documentThreads.remove, { ...scope, threadId });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    await viewers.author.mutation(api.documentThreads.remove, { ...scope, threadId });
    await viewers.author.mutation(api.documentReplies.remove, reply);
    expect(await backend.run(ctx => ctx.db.get(threadId))).toMatchObject({ deletedAt: expect.any(Number), body: "" });
    expect(await backend.run(ctx => ctx.db.get(replyId))).toMatchObject({ deletedAt: expect.any(Number), body: "" });
    await expect(viewers.member.mutation(api.documentThreads.remove, { ...scope, threadId })).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(viewers.member.mutation(api.documentReplies.remove, reply)).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(viewers.outsider.mutation(api.documentThreads.remove, { ...scope, threadId })).rejects.toThrow("Comment not found");
  });

  it("validates operation ID bounds and authorizes before dedup, even for previously successful operations", async () => {
    const { backend, viewers, scope, data, threadId } = await fixture();
    for (const clientOperationId of ["", " ", "x".repeat(129)]) {
      await expect(viewers.author.mutation(api.documentThreads.create, { ...scope, body: "No", anchor, clientOperationId })).rejects.toThrow("Client operation ID");
      await expect(viewers.author.mutation(api.documentReplies.add, { ...scope, threadId, body: "No", clientOperationId })).rejects.toThrow("Client operation ID");
      await expect(viewers.author.mutation(api.documentThreads.resolve, { ...scope, threadId, resolved: true, clientOperationId })).rejects.toThrow("Client operation ID");
    }
    const create = { ...scope, body: "Once", anchor, clientOperationId: "once" };
    await viewers.author.mutation(api.documentThreads.create, create);
    await backend.run((ctx) => ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: "member", where: [{ field: "_id", value: data.users.find((u) => u.name === "author")!.memberId }] },
    }));
    await expect(viewers.author.mutation(api.documentThreads.create, create)).rejects.toThrow("Comment not found");
    await expect(viewers.outsider.mutation(api.documentThreads.create, { ...create, projectId: "malformed", clientOperationId: "" })).rejects.toThrow("Comment not found");
  });
});


describe("status operation receipts", () => {
  it.each(["resolved", "archived"] as const)("replaying %s cannot undo a newer opposite action, even with changed arguments", async (field) => {
    const { backend, viewers, scope, threadId } = await fixture();
    const fn = field === "resolved" ? api.documentThreads.resolve : api.documentThreads.archive;
    const op1 = { ...scope, threadId, [field]: true, clientOperationId: "op1" };
    expect(await viewers.author.mutation(fn, op1)).toBe(true);
    expect(await viewers.admin.mutation(fn, { ...op1, [field]: false, clientOperationId: "op2" })).toBe(false);
    expect(await viewers.author.mutation(fn, op1)).toBe(true);
    expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ [field]: false });
    await expect(viewers.author.mutation(fn, { ...op1, [field]: false })).rejects.toThrow("Operation arguments changed");
    // Author scoping: another authorized author can use the same opaque ID.
    await viewers.admin.mutation(fn, op1);
    expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ [field]: true });
    expect(await backend.run((ctx) => ctx.db.query("commentStatusReceipts").collect())).toHaveLength(3);
    await expect(viewers.outsider.mutation(fn, op1)).rejects.toThrow("Comment not found");
    await expect(viewers.author.mutation(fn, { ...op1, documentPath: "other.html" })).rejects.toThrow("Comment not found");
  });

  it.each(["resolved", "archived"] as const)("preserves legacy %s toggles and requires a target with an ID", async (field) => {
    const { backend, viewers, scope, threadId } = await fixture();
    const fn = field === "resolved" ? api.documentThreads.resolve : api.documentThreads.archive;
    for (const target of [true, false]) {
      await viewers.author.mutation(fn, { ...scope, threadId });
      expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ [field]: target });
    }
    await expect(viewers.author.mutation(fn, { ...scope, threadId, clientOperationId: "missing-target" })).rejects.toThrow("explicit status target");
    expect(await backend.run((ctx) => ctx.db.query("commentStatusReceipts").collect())).toHaveLength(0);
  });

  it("cleans expired receipts in bounded batches while retaining live receipts", async () => {
    const { backend, scope, threadId } = await fixture();
    vi.useFakeTimers();
    await backend.run(async (ctx) => {
      for (let i = 0; i < 102; i++) await ctx.db.insert("commentStatusReceipts", {
        ...scope, threadId, authorId: "author", clientOperationId: String(i), field: "resolved", target: true,
        expiresAt: Date.now() + (i === 101 ? 60_000 : -1),
      });
    });
    await backend.mutation(internal.documentThreads.cleanupStatusReceipts, {});
    expect(await backend.run((ctx) => ctx.db.query("commentStatusReceipts").collect())).toHaveLength(2);
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run((ctx) => ctx.db.query("commentStatusReceipts").collect())).toMatchObject([{ clientOperationId: "101" }]);
  });

  it("rejects queued writes if token refresh changes the authenticated author", async () => {
    const { viewers, scope, data, threadId, replyId } = await fixture();
    const expectedAuthorId = data.users.find((user) => user.name === "author")!.userId;
    const args = { ...scope, expectedAuthorId, clientOperationId: "queued" };
    const writes = [
      () => viewers.admin.mutation(api.documentThreads.create, { ...args, body: "Private", anchor }),
      () => viewers.admin.mutation(api.documentReplies.add, { ...args, threadId, body: "Private" }),
      () => viewers.admin.mutation(api.documentThreads.resolve, { ...args, threadId, resolved: true }),
      () => viewers.admin.mutation(api.documentThreads.archive, { ...args, threadId, archived: true }),
      () => viewers.admin.mutation(api.documentThreads.remove, { ...args, threadId }),
      () => viewers.admin.mutation(api.documentReplies.remove, { ...args, threadId, replyId }),
    ];
    for (const write of writes) await expect(write()).rejects.toThrow("comment session changed");
  });
});
