import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, components } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";

const modules = import.meta.glob("../convex/**/*.ts");

async function fixture() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const now = Date.now();
  const data = await backend.run(async (ctx) => {
    const org = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "organization", data: { name: "Comments", slug: "comments", createdAt: now } },
    });
    const otherOrg = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "organization", data: { name: "Other", slug: "other", createdAt: now } },
    });
    const users = await Promise.all([
      ["author", "member"], ["member", "member"], ["admin", "admin"], ["owner", "owner"],
      ["multiRole", "member, admin"], ["outsider", "owner"],
    ].map(async ([name, role]) => {
      const user = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: "user", data: { name, email: name + "@example.test", emailVerified: true, createdAt: now, updatedAt: now } },
      });
      const session = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: "session", data: { token: name, userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000 } },
      });
      const membership = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: "member", data: { organizationId: name === "outsider" ? otherOrg._id : org._id, userId: user._id, role, createdAt: now } },
      });
      return { name, userId: user._id, sessionId: session._id, memberId: membership._id };
    }));
    const projectId = await ctx.db.insert("projects", {
      organizationId: org._id, name: "Docs", slug: "docs", createdBy: users[0].userId, createdAt: now,
    });
    return { organizationId: org._id, otherOrgId: otherOrg._id, projectId, users };
  });
  const viewers = Object.fromEntries(data.users.map((user) => [
    user.name, backend.withIdentity({ subject: user.userId, sessionId: user.sessionId }),
  ]));
  const scope = { organizationId: data.organizationId, projectId: data.projectId, documentPath: "guide.html" };
  const threadId = await viewers.author.mutation(api.documentThreads.create, {
    ...scope, body: "Thread", anchor: { kind: "element", path: ["main"] },
  });
  const replyId = await viewers.author.mutation(api.documentReplies.add, { ...scope, threadId, body: "Reply" });
  const memberReplyId = await viewers.member.mutation(api.documentReplies.add, { ...scope, threadId, body: "Member reply" });
  return { backend, data, viewers, scope, threadId, replyId, memberReplyId };
}

afterEach(() => vi.useRealTimers());

describe("project comment permissions", () => {
  it.each(["author", "admin", "owner", "multiRole"])("%s can delete authorized threads and replies", async (name) => {
    const { backend, viewers, scope, threadId, replyId, memberReplyId } = await fixture();
    const viewer = viewers[name];
    await viewer.mutation(api.documentReplies.remove, { ...scope, threadId, replyId });
    expect(await backend.run((ctx) => ctx.db.get(replyId))).toBeNull();
    expect(await backend.run((ctx) => ctx.db.get(memberReplyId))).not.toBeNull();
    await viewer.mutation(api.documentThreads.archive, { ...scope, threadId });
    await viewer.mutation(api.documentThreads.archive, { ...scope, threadId });
    vi.useFakeTimers();
    await viewer.mutation(api.documentThreads.remove, { ...scope, threadId });
    expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ deletedAt: expect.any(Number) });
    expect((await viewer.query(api.documentThreads.list, {
      ...scope, paginationOpts: { cursor: null, numItems: 20 },
    })).page).toEqual([]);
    await expect(viewer.mutation(api.documentReplies.remove, {
      ...scope, threadId, replyId: memberReplyId,
    })).rejects.toThrow("Comment not found");
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await backend.run((ctx) => ctx.db.get(threadId))).toBeNull();
    expect(await backend.run((ctx) => ctx.db.get(memberReplyId))).toBeNull();
  });

  it.each(["member", "outsider"])("denies %s deletion and archive without changing records or scheduling cleanup", async (name) => {
    const { backend, viewers, scope, threadId, replyId } = await fixture();
    const viewer = viewers[name];
    const error = name === "member" ? "Only the comment author" : "Organization membership required";
    await expect(viewer.mutation(api.documentThreads.remove, { ...scope, threadId })).rejects.toThrow(error);
    await expect(viewer.mutation(api.documentThreads.archive, { ...scope, threadId })).rejects.toThrow(error);
    await expect(viewer.mutation(api.documentReplies.remove, { ...scope, threadId, replyId })).rejects.toThrow(error);
    expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ body: "Thread", archived: false });
    expect((await backend.run((ctx) => ctx.db.get(threadId)))?.deletedAt).toBeUndefined();
    expect(await backend.run((ctx) => ctx.db.get(replyId))).not.toBeNull();
    expect(await backend.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  it("lets a reply author delete their reply on another member's thread", async () => {
    const { backend, viewers, scope, threadId, memberReplyId } = await fixture();
    await viewers.member.mutation(api.documentReplies.remove, { ...scope, threadId, replyId: memberReplyId });
    expect(await backend.run((ctx) => ctx.db.get(memberReplyId))).toBeNull();
    expect(await backend.run((ctx) => ctx.db.get(threadId))).not.toBeNull();
  });

  it("rechecks a moderator's current role after permissions were loaded", async () => {
    const { backend, data, viewers, scope, threadId, replyId } = await fixture();
    const paginationOpts = { cursor: null, numItems: 20 };
    expect((await viewers.admin.query(api.documentThreads.list, { ...scope, paginationOpts })).page[0].canDelete).toBe(true);
    await backend.run((ctx) => ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "member",
        where: [{ field: "_id", value: data.users.find((user) => user.name === "admin")!.memberId }],
        update: { role: "member" },
      },
    }));
    await expect(viewers.admin.mutation(api.documentThreads.remove, { ...scope, threadId })).rejects.toThrow("Only the comment author");
    await expect(viewers.admin.mutation(api.documentThreads.archive, { ...scope, threadId })).rejects.toThrow("Only the comment author");
    await expect(viewers.admin.mutation(api.documentReplies.remove, { ...scope, threadId, replyId })).rejects.toThrow("Only the comment author");
    expect((await viewers.admin.query(api.documentThreads.list, { ...scope, paginationOpts })).page[0].canDelete).toBe(false);
    expect((await viewers.admin.query(api.documentReplies.list, { ...scope, threadId, paginationOpts })).page[0].canDelete).toBe(false);
  });

  it("denies a former member deletion of their own comments", async () => {
    const { backend, data, viewers, scope, threadId, replyId } = await fixture();
    await backend.run((ctx) => ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: {
        model: "member",
        where: [{ field: "_id", value: data.users.find((user) => user.name === "author")!.memberId }],
      },
    }));
    await expect(viewers.author.mutation(api.documentThreads.remove, { ...scope, threadId })).rejects.toThrow("Organization membership required");
    await expect(viewers.author.mutation(api.documentReplies.remove, { ...scope, threadId, replyId })).rejects.toThrow("Organization membership required");
    expect((await backend.run((ctx) => ctx.db.get(threadId)))?.deletedAt).toBeUndefined();
    expect(await backend.run((ctx) => ctx.db.get(replyId))).not.toBeNull();
  });

  it.each(["author", "member", "admin", "owner", "multiRole"])("returns accurate %s permissions in thread previews and reply pages", async (name) => {
    const { viewers, scope, threadId, replyId, memberReplyId } = await fixture();
    const paginationOpts = { cursor: null, numItems: 20 };
    const page = await viewers[name].query(api.documentThreads.list, { ...scope, paginationOpts });
    expect(page.page[0].canDelete).toBe(name !== "member");
    const replies = await viewers[name].query(api.documentReplies.list, { ...scope, threadId, paginationOpts });
    for (const rows of [page.page[0].replies, replies.page]) {
      expect(rows.find((reply) => reply._id === replyId)?.canDelete).toBe(name !== "member");
      expect(rows.find((reply) => reply._id === memberReplyId)?.canDelete).toBe(name !== "author");
    }
  });

  it("rejects forged document, project, organization, and reply-parent scopes even for admins", async () => {
    const { backend, data, viewers, scope, threadId, replyId } = await fixture();
    const otherThreadId = await viewers.author.mutation(api.documentThreads.create, {
      ...scope, body: "Other thread", anchor: { kind: "element", path: ["main"] },
    });
    const otherProjectId = await backend.run((ctx) => ctx.db.insert("projects", {
      organizationId: scope.organizationId, name: "Other", slug: "other", createdBy: data.users[0].userId, createdAt: Date.now(),
    }));
    for (const wrongScope of [
      { ...scope, documentPath: "other.html" },
      { ...scope, organizationId: data.otherOrgId },
      { ...scope, projectId: otherProjectId },
    ]) {
      const error = wrongScope.organizationId === scope.organizationId ? "Comment not found" : "Organization membership required";
      await expect(viewers.admin.mutation(api.documentThreads.remove, { ...wrongScope, threadId })).rejects.toThrow(error);
      await expect(viewers.admin.mutation(api.documentReplies.remove, { ...wrongScope, threadId, replyId })).rejects.toThrow(error);
    }
    await expect(viewers.admin.mutation(api.documentReplies.remove, {
      ...scope, threadId: otherThreadId, replyId,
    })).rejects.toThrow("Comment not found");
  });

  it("allows members to resolve and reopen others' threads but rejects cross-org status changes and replies", async () => {
    const { backend, viewers, scope, threadId } = await fixture();
    await viewers.member.mutation(api.documentThreads.resolve, { ...scope, threadId });
    expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ resolved: true });
    await viewers.member.mutation(api.documentThreads.resolve, { ...scope, threadId });
    expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ resolved: false });
    await expect(viewers.outsider.mutation(api.documentThreads.resolve, { ...scope, threadId })).rejects.toThrow("Organization membership required");
    await expect(viewers.outsider.mutation(api.documentReplies.add, { ...scope, threadId, body: "No" })).rejects.toThrow("Organization membership required");
    await expect(viewers.outsider.mutation(api.documentThreads.create, {
      ...scope, body: "No", anchor: { kind: "element", path: ["main"] },
    })).rejects.toThrow("Organization membership required");
  });
});
