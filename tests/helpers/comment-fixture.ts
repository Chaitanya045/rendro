import rateLimiterTest from "../convex-rate-limiter";
import { convexTest } from "convex-test";
import { api, components } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import betterAuthSchema from "../../convex/betterAuth/schema";
const modules = import.meta.glob("../../convex/**/*.ts");

/** A public repository's comments (#254) whose readers hold a grant, with one thread and two replies. */
export const REPO_ID = 9101;
export const BLOB_SHA = "b".repeat(40);
export const repoAnchor = (exact = "pnpm install") => ({
  kind: "repo-text" as const, blobSha: BLOB_SHA, headingSlug: "install", prefix: "Run ", exact, suffix: " first", offset: 4,
});

export async function fixture() {
  const backend = convexTest(schema, modules);
  rateLimiterTest.register(backend);
  backend.registerComponent("betterAuth", betterAuthSchema, import.meta.glob("../../convex/betterAuth/**/*.ts"));
  const now = Date.now();
  const users = await backend.run(async (ctx) => Promise.all(["author", "member", "outsider"].map(async (name) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: { name, email: name + "@example.test", emailVerified: true, createdAt: now, updatedAt: now } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: { token: name, userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 3_600_000 } },
    });
    return { name, userId: user._id as string, sessionId: session._id as string };
  })));
  // The read path records a public repository's grant once, for every reader (userId null).
  await backend.mutation(api.repoCommentAccess.grant, {
    internalSecret: process.env.CONVEX_INTERNAL_SECRET!, repoId: REPO_ID, userId: null, epoch: 0, expiresAt: now + 60_000,
  });
  const viewers = Object.fromEntries(users.map((user) => [
    user.name, backend.withIdentity({ subject: user.userId, sessionId: user.sessionId }),
  ]));
  const scope = { repoId: REPO_ID, path: "docs/guide.md" };
  const threadId = await viewers.author.mutation(api.repoComments.createThread, { ...scope, body: "Thread", anchor: repoAnchor() });
  const replyId = await viewers.author.mutation(api.repoComments.addReply, { ...scope, threadId, body: "Reply" });
  const memberReplyId = await viewers.member.mutation(api.repoComments.addReply, { ...scope, threadId, body: "Member reply" });
  return { backend, data: { users }, viewers, scope, threadId, replyId, memberReplyId };
}
