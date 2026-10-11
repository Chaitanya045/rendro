import { convexTest } from "convex-test";
import { api, components } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import betterAuthSchema from "../../convex/betterAuth/schema";
const modules = import.meta.glob("../../convex/**/*.ts");

export async function fixture() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../../convex/betterAuth/**/*.ts"));
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
