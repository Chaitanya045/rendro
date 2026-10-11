import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, components, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";

// Exercise the real session/membership path in addition to the larger HTTP
// matrix's mocked session authorization. All records live in convex-test.
async function fixture() {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const now = Date.now();
  const token = "test-session-token";
  const seeded = await backend.run(async ctx => {
    const organization = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "organization", data: { name: "Test", slug: "test", createdAt: now },
    } });
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "user", data: { name: "Owner", email: "owner@example.test", emailVerified: true, createdAt: now, updatedAt: now },
    } });
    const member = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "member", data: { organizationId: organization._id, userId: user._id, role: "owner", createdAt: now },
    } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "session", data: { userId: user._id, token, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
    } });
    const team = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "team", data: { organizationId: organization._id, name: "Test team", createdAt: now },
    } });
    return {
      organizationId: organization._id as string,
      userId: user._id as string,
      sessionId: session._id as string,
      memberId: member._id as string,
      teamId: team._id as string,
    };
  });
  const project = await backend.mutation(internal.projects.createInternal, { organizationId: seeded.organizationId, name: "Docs", slug: "docs", actorId: seeded.userId });
  if (!project) throw new Error("Missing project");
  const signature = createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64");
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  return { backend, projectId: project._id, cookie, ...seeded };
}

describe("real-session ID boundaries", () => {
  it("keeps valid sessions working and rejects malformed project IDs in the fallback and credential creation", async () => {
    const f = await fixture();
    const headers = { cookie: f.cookie };
    const query = new URLSearchParams({ organizationId: f.organizationId, projectId: f.projectId });
    const valid = await f.backend.fetch(`/api/rendro/deployments/active?${query}`, { headers });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ principal: { kind: "session", userId: f.userId } });
    for (const projectId of ["not-an-id", f.memberId]) {
      query.set("projectId", projectId);
      const response = await f.backend.fetch(`/api/rendro/deployments/active?${query}`, { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Project not found" });
      const credential = await f.backend.fetch("/api/rendro/credentials", { method: "POST", headers, body: JSON.stringify({ organizationId: f.organizationId, projectId, name: "test", scopes: ["docs:read"] }) });
      expect(credential.status).toBe(404);
      expect(await credential.json()).toEqual({ error: "Project not found" });
    }
  });

  it("normalizes team IDs in the component and keeps the valid-team path working", async () => {
    const f = await fixture();
    for (const teamId of [f.teamId, "not-an-id", f.memberId]) {
      for (const cookie of [f.cookie, "better-auth.session_token=invalid"]) {
        const query = new URLSearchParams({ organizationId: f.organizationId, teamId });
        const response = await f.backend.fetch(`/api/rendro/management/team-members?${query}`, { headers: { cookie } });
        expect(response.status).toBe(cookie !== f.cookie ? 403 : teamId === f.teamId ? 200 : 404);
        expect(await response.text()).not.toMatch(/ConvexError|ArgumentValidationError|\.ts:\d/);
      }
    }
  });

  it("rejects unknown organization identities through membership checks before ID lookups", async () => {
    const f = await fixture();
    for (const organizationId of ["not-an-id", f.memberId]) {
      for (const cookie of [f.cookie, "better-auth.session_token=invalid"]) {
        const query = new URLSearchParams({ organizationId, projectId: f.projectId, teamId: f.teamId });
        for (const path of ["projects", "projects/get", "credentials", "deployments", "deployments/active", "shares", "publications", "management/access", "management/members", "management/team-members", "management/recent-deployment"]) {
          const response = await f.backend.fetch(`/api/rendro/${path}?${query}`, { headers: { cookie } });
          expect([401, 403]).toContain(response.status);
          expect(await response.text()).not.toMatch(/ConvexError|ArgumentValidationError|\.ts:\d/);
        }
      }
    }
  });
});

describe("Better Auth organization mutation IDs", () => {
  it.each([
    { route: "remove-member", field: "memberIdOrEmail", extra: {}, code: "MEMBER_NOT_FOUND" },
    { route: "update-member-role", field: "memberId", extra: { role: "member" }, code: "MEMBER_NOT_FOUND" },
    { route: "cancel-invitation", field: "invitationId", extra: {}, code: "INVITATION_NOT_FOUND" },
  ])("returns controlled $route errors for malformed and wrong-table IDs", async ({ route, field, extra, code }) => {
    const f = await fixture();
    for (const id of ["not-an-id", f.teamId, f.projectId]) {
      for (const cookie of [f.cookie, "better-auth.session_token=invalid"]) {
        const response = await f.backend.fetch(`/api/auth/organization/${route}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: process.env.SITE_URL! },
          body: JSON.stringify({ organizationId: f.organizationId, [field]: id, ...extra }),
        });
        expect(response.status).toBe(cookie === f.cookie ? 400 : 401);
        const body = await response.text();
        expect(body).not.toMatch(/ConvexError|ArgumentValidationError|\.ts:\d|stack|schema-generation/);
        expect(JSON.parse(body).code).toBe(cookie === f.cookie ? code : "UNAUTHORIZED");
      }
    }
    expect(await f.backend.query(components.betterAuth.adapter.findOne, { model: "member", where: [{ field: "_id", value: f.memberId }] })).toMatchObject({ role: "owner" });
  });

  it("guards adapter reads and writes while preserving valid selectors", async () => {
    const f = await fixture();
    for (const id of ["not-an-id", f.teamId]) {
      const where = [{ field: "_id" as const, value: id }];
      expect(await f.backend.query(components.betterAuth.adapter.findOne, { model: "member", where })).toBeNull();
      expect(await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: { model: "member", where, update: { role: "admin" } } })).toBeNull();
      await f.backend.mutation(components.betterAuth.adapter.deleteOne, { input: { model: "member", where } });
      expect(await f.backend.mutation(components.betterAuth.adapter.updateMany, { input: { model: "member", where, update: { role: "admin" } }, paginationOpts: { numItems: 10, cursor: null } })).toMatchObject({ count: 0 });
      expect(await f.backend.mutation(components.betterAuth.adapter.deleteMany, { input: { model: "member", where }, paginationOpts: { numItems: 10, cursor: null } })).toMatchObject({ count: 0 });
    }
    const result = await f.backend.query(components.betterAuth.adapter.findMany, {
      model: "member", where: [{ field: "_id", operator: "in", value: [f.memberId, f.teamId, "not-an-id"] }], paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page.map((row: { _id: string }) => row._id)).toEqual([f.memberId]);
    expect(await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: { model: "team", where: [{ field: "_id", value: f.teamId }], update: { name: "Renamed" } } })).toMatchObject({ name: "Renamed" });
  });
});

async function commentFixture() {
  const f = await fixture();
  const scope = { organizationId: f.organizationId, projectId: f.projectId, documentPath: "index.html" };
  const records = await f.backend.run(async ctx => {
    const now = Date.now();
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Outsider", email: "outsider@elsewhere.test", emailVerified: true, createdAt: now, updatedAt: now } } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "session", data: { token: "outsider", userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000 } } });
    const ownOrg = await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "organization", data: { name: "Other", slug: "other", createdAt: now } } });
    await ctx.runMutation(components.betterAuth.adapter.create, { input: { model: "member", data: { organizationId: ownOrg._id, userId: user._id, role: "member", createdAt: now } } });
    const threadData = { ...scope, authorId: f.userId, body: "test", anchor: { kind: "element" as const, path: ["main"] }, resolved: false, archived: false, createdAt: now, updatedAt: now };
    const threadId = await ctx.db.insert("documentThreads", threadData);
    const absentThreadId = await ctx.db.insert("documentThreads", threadData);
    await ctx.db.delete(absentThreadId);
    const replyData = { threadId, organizationId: f.organizationId, authorId: f.userId, body: "test", createdAt: now, updatedAt: now };
    const replyId = await ctx.db.insert("documentReplies", replyData);
    const absentReplyId = await ctx.db.insert("documentReplies", replyData);
    await ctx.db.delete(absentReplyId);
    const legacyData = { orgSlug: "example", filePath: "index.html", authorEmail: "owner@example.test", authorName: "Owner", body: "test", anchor: threadData.anchor, resolved: false, archived: false };
    const legacyId = await ctx.db.insert("threads", legacyData);
    const absentLegacyId = await ctx.db.insert("threads", legacyData);
    await ctx.db.delete(absentLegacyId);
    return { threadId, absentThreadId, replyId, absentReplyId, legacyId, absentLegacyId, ownOrg: ownOrg._id as string, outsiderId: user._id as string, outsiderSessionId: session._id as string };
  });
  return {
    ...f, ...records, scope,
    member: f.backend.withIdentity({ subject: f.userId, sessionId: f.sessionId, email: "owner@example.test" }),
    outsider: f.backend.withIdentity({ subject: records.outsiderId, sessionId: records.outsiderSessionId, email: "outsider@elsewhere.test" }),
  };
}

describe("comment authorization before record existence", () => {
  it.each(["anonymous", "outsider", "outsider-own-org"] as const)("hides absent and inaccessible document records from %s", async principal => {
    const f = await commentFixture();
    const caller = principal === "anonymous" ? f.backend : f.outsider;
    const scope = { ...f.scope, organizationId: principal === "outsider-own-org" ? f.ownOrg : f.organizationId };
    const expected = principal === "anonymous" ? "Unauthenticated" : principal === "outsider" ? "Organization membership required" : "Comment not found";
    for (const threadId of [f.absentThreadId, f.threadId]) {
      const args = { ...scope, threadId };
      const calls = [
        ...[api.documentThreads.resolve, api.documentThreads.archive, api.documentThreads.remove].map(fn => () => caller.mutation(fn, args)),
        () => caller.query(api.documentReplies.list, { ...args, paginationOpts: { numItems: 10, cursor: null } }),
        () => caller.mutation(api.documentReplies.add, { ...args, body: "test" }),
        ...[f.absentReplyId, f.replyId].map(replyId => () => caller.mutation(api.documentReplies.remove, { ...args, replyId })),
      ];
      for (const call of calls) await expect(call()).rejects.toMatchObject({ data: expected });
    }
    for (const projectId of [f.projectId, await f.backend.run(async ctx => {
      const id = await ctx.db.insert("projects", { organizationId: f.organizationId, name: "Absent", slug: "absent", createdBy: f.userId, createdAt: Date.now() });
      await ctx.db.delete(id);
      return id;
    })]) {
      const expectedProject = principal === "outsider-own-org" ? "Project not found" : expected;
      await expect(caller.query(api.documentThreads.list, { ...scope, projectId, paginationOpts: { numItems: 10, cursor: null } })).rejects.toMatchObject({ data: expectedProject });
      await expect(caller.mutation(api.documentThreads.create, { ...scope, projectId, body: "test", anchor: { kind: "element", path: ["main"] } })).rejects.toMatchObject({ data: expectedProject });
    }
  });

  it.each([false, true])("hides legacy record existence with authenticated=%s", async authenticated => {
    const f = await commentFixture();
    const caller = authenticated ? f.outsider : f.backend;
    for (const threadId of [f.absentLegacyId, f.legacyId]) {
      for (const fn of [api.threads.resolve, api.threads.archive, api.threads.remove]) {
        await expect(caller.mutation(fn, { threadId })).rejects.toMatchObject({ data: authenticated ? "Comment not found" : "Unauthenticated" });
      }
      await expect(caller.mutation(api.replies.add, { threadId, body: "test" })).rejects.toMatchObject({ data: authenticated ? "Comment not found" : "Unauthenticated" });
    }
  });

  it.each([false, true])("returns safe malformed/wrong-table ID errors with authenticated=%s", async authenticated => {
    const f = await commentFixture();
    const caller = authenticated ? f.member : f.backend;
    const expected = authenticated ? "Invalid ID" : "Unauthenticated";
    const page = { paginationOpts: { numItems: 10, cursor: null } };
    for (const badId of ["not-an-id", f.teamId]) {
      const calls = [
        () => caller.query(api.documentThreads.list, { ...f.scope, ...page, projectId: badId }),
        () => caller.mutation(api.documentThreads.create, { ...f.scope, projectId: badId, body: "test", anchor: { kind: "element", path: ["main"] } }),
        ...[api.documentThreads.resolve, api.documentThreads.archive, api.documentThreads.remove].flatMap(fn => [
          () => caller.mutation(fn, { ...f.scope, threadId: badId }),
          () => caller.mutation(fn, { ...f.scope, projectId: badId, threadId: f.threadId }),
        ]),
        ...[{ ...f.scope, threadId: badId }, { ...f.scope, projectId: badId, threadId: f.threadId }].flatMap(args => [
          () => caller.query(api.documentReplies.list, { ...args, ...page }),
          () => caller.mutation(api.documentReplies.add, { ...args, body: "test" }),
          () => caller.mutation(api.documentReplies.remove, { ...args, replyId: f.replyId }),
        ]),
        () => caller.mutation(api.documentReplies.remove, { ...f.scope, threadId: f.threadId, replyId: badId }),
        ...[api.threads.resolve, api.threads.archive, api.threads.remove].map(fn => () => caller.mutation(fn, { threadId: badId })),
        () => caller.mutation(api.replies.add, { threadId: badId, body: "test" }),
      ];
      for (const call of calls) await expect(call()).rejects.toMatchObject({ data: expected });
    }
  });
});
