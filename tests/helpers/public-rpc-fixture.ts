// Loaded only by the isolated local-runtime test, never by the app deployment.
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
