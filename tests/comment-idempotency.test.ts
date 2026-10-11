import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components } from "../convex/_generated/api";
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

  it("repeats physical removals successfully, including after parent cleanup", async () => {
    const { backend, viewers, scope, threadId, replyId } = await fixture();
    const reply = { ...scope, threadId, replyId, clientOperationId: "remove-reply" };
    await viewers.author.mutation(api.documentReplies.remove, reply);
    await viewers.author.mutation(api.documentReplies.remove, reply);
    vi.useFakeTimers();
    await viewers.author.mutation(api.documentThreads.remove, { ...scope, threadId });
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    await viewers.author.mutation(api.documentThreads.remove, { ...scope, threadId });
    await viewers.author.mutation(api.documentReplies.remove, reply);
    await expect(viewers.outsider.mutation(api.documentThreads.remove, { ...scope, threadId })).rejects.toThrow("Organization membership required");
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
    await expect(viewers.author.mutation(api.documentThreads.create, create)).rejects.toThrow("Organization membership required");
    await expect(viewers.outsider.mutation(api.documentThreads.create, { ...create, projectId: "malformed", clientOperationId: "" })).rejects.toThrow("Organization membership required");
  });
});
