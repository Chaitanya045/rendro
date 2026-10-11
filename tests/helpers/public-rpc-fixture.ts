// Loaded only by the isolated local-runtime test, never by the app deployment.
import * as threads from "../../convex/threads";
import * as replies from "../../convex/replies";
import { v } from "convex/values";
import { query, mutation } from "../../convex/publicFunctions";
import { publicError } from "../../convex/publicErrors";
import { publicPaginate } from "../../convex/publicPagination";
import { publicErrorMessages, type PublicErrorCode } from "../../src/shared/public-errors";

const failure = {
  args: { missing: v.boolean(), code: v.string() },
  handler: (_ctx: unknown, args: { missing: boolean; code: string }) => {
    if (!Object.hasOwn(publicErrorMessages, args.code)) throw new Error("Unexpected failure");
    if (args.missing) publicError(args.code as PublicErrorCode);
    return inaccessible(args.code as PublicErrorCode);
  },
};
function inaccessible(code: PublicErrorCode): never {
  publicError(code);
}
export const queryFailure = query(failure);
export const mutationFailure = mutation(failure);
export const diagnostics = query({ args: {}, handler: () => {
  const limit = Error.stackTraceLimit;
  try { publicError("not_found"); } catch { /* Exercise restoration within one invocation. */ }
  if (Error.stackTraceLimit !== limit) throw new Error("Stack limit was not restored");
  throw new Error("Unexpected failure still has frames");
} });
export const seed = mutation({ args: {}, handler: async ctx => {
  const projectId = await ctx.db.insert("projects", {
    organizationId: "org", name: "Test", slug: "test", createdBy: "author", createdAt: 1,
  });
  for (let i = 0; i < 3; i++) {
    const threadId = await ctx.db.insert("documentThreads", {
      projectId, organizationId: "org", documentPath: "test.html", authorId: "author", body: "test",
      anchor: { kind: "element", path: ["main"] }, resolved: false, archived: false, createdAt: i, updatedAt: i,
    });
    await ctx.db.insert("documentReplies", {
      threadId, organizationId: "org", authorId: "author", body: "test", createdAt: i, updatedAt: i,
    });
  }
  const thread = { orgSlug: "example", filePath: "index.html", body: "Test", authorId: "author", authorEmail: "author@example.test", authorName: "Author", anchor: { kind: "element" as const, path: ["main"] }, resolved: false };
  const threadId = await ctx.db.insert("threads", thread);
  const foreignThreadId = await ctx.db.insert("threads", { ...thread, orgSlug: "other" });
  const missingThreadId = await ctx.db.insert("threads", thread);
  await ctx.db.delete(missingThreadId);
  const reply = { threadId, body: "Test", authorId: "author", authorEmail: "author@example.test", authorName: "Author" };
  const foreignReplyId = await ctx.db.insert("replies", { ...reply, threadId: foreignThreadId });
  const missingReplyId = await ctx.db.insert("replies", reply);
  await ctx.db.delete(missingReplyId);
  return { threadId, foreignThreadId, missingThreadId, foreignReplyId, missingReplyId };
} });
export const page = query({
  args: {
    table: v.union(v.literal("documentThreads"), v.literal("documentReplies")),
    cursor: v.union(v.null(), v.string()), endCursor: v.optional(v.string()),
  },
  handler: (ctx, args) => publicPaginate(ctx.db.query(args.table), {
    cursor: args.cursor, endCursor: args.endCursor, numItems: 1,
  }),
});

// Exercise the actual registered legacy handlers and real database lookups.
// Only authentication is synthetic; no deployment/session credentials are used.
const legacyAuth = { getUserIdentity: async () => ({ subject: "author", email: "author@example.test", tokenIdentifier: "test|author", issuer: "test" }) };
export const legacyList = query({
  args: { orgSlug: v.string() },
  handler: (ctx, args) => threads.list._handler({ ...ctx, auth: legacyAuth }, { ...args, filePath: "index.html" }),
});
export const legacyMutation = mutation({
  args: { method: v.string(), orgSlug: v.string(), threadId: v.string(), replyId: v.string() },
  handler: (ctx, args) => {
    const context = { ...ctx, auth: legacyAuth };
    if (args.method === "threads:create") return threads.create._handler(context, { orgSlug: args.orgSlug, filePath: "index.html", body: "Test", anchor: { kind: "element", path: ["main"] } });
    if (args.method === "threads:resolve") return threads.resolve._handler(context, { threadId: args.threadId });
    if (args.method === "threads:archive") return threads.archive._handler(context, { threadId: args.threadId });
    if (args.method === "threads:remove") return threads.remove._handler(context, { threadId: args.threadId });
    if (args.method === "replies:add") return replies.add._handler(context, { threadId: args.threadId, body: "Test" });
    if (args.method === "replies:remove") return replies.remove._handler(context, { threadId: args.threadId, replyId: args.replyId });
    throw new Error("Unknown probe method");
  },
});
