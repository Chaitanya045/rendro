import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { authComponent } from "../convex/auth";
import { api } from "../convex/_generated/api";
import { fixture, repoAnchor } from "./helpers/comment-fixture";
import { commentErrorMessage, isDefinitiveCommentRejection } from "../src/commentor/errors";
import { publicErrorMessages, type PublicErrorCode } from "../src/shared/public-errors";

const paginationOpts = { cursor: null, numItems: 10 };
const repoPage = { repoId: 9001, path: "docs/guide.md" };
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Endpoint = { name: string; kind: "query" | "mutation"; args: (f: Fixture) => Record<string, unknown>; ids: string[] };
const thread = (f: Fixture) => ({ ...f.scope, threadId: f.threadId });
const endpoints: Endpoint[] = [
  // Repository docs (#254): the read path's internal grant calls, then the comments themselves. Their own
  // cross-repository ID, anchor and access matrix is in tests/repo-comments-convex.test.ts.
  { name: "repoCommentAccess:grant", kind: "mutation", args: () => ({ internalSecret: "wrong", repoId: 1, userId: null, epoch: 0, expiresAt: Date.now() + 1_000 }), ids: [] },
  { name: "repoCommentAccess:grantModerator", kind: "mutation", args: () => ({ internalSecret: "wrong", repoId: 1, userId: "user", role: "admin", epoch: 0, expiresAt: Date.now() + 1_000 }), ids: [] },
  { name: "repoCommentAccess:revokeUser", kind: "mutation", args: () => ({ internalSecret: "wrong", userId: "user", epoch: 1 }), ids: [] },
  { name: "repoCommentAccess:removeRepos", kind: "mutation", args: () => ({ internalSecret: "wrong", repoIds: [1] }), ids: [] },
  { name: "repoCommentAccess:purgeRepos", kind: "mutation", args: () => ({ internalSecret: "wrong", repoIds: [1] }), ids: [] },
  { name: "repoCommentAccess:restoreRepos", kind: "mutation", args: () => ({ internalSecret: "wrong", repoIds: [1] }), ids: [] },
  // The read path's first-page snapshot (#284): internal secret only.
  { name: "repoComments:threadSnapshot", kind: "query", args: () => ({ internalSecret: "wrong", ...repoPage, userId: null, epoch: 0 }), ids: [] },
  { name: "repoComments:listThreads", kind: "query", args: f => ({ ...f.scope, paginationOpts }), ids: [] },
  { name: "repoComments:listReplies", kind: "query", args: f => ({ ...thread(f), paginationOpts }), ids: ["threadId"] },
  { name: "repoComments:createThread", kind: "mutation", args: f => ({ ...f.scope, body: "Test", anchor: repoAnchor() }), ids: [] },
  { name: "repoComments:resolve", kind: "mutation", args: f => ({ ...thread(f), resolved: true }), ids: ["threadId"] },
  { name: "repoComments:archive", kind: "mutation", args: f => ({ ...thread(f), archived: true }), ids: ["threadId"] },
  { name: "repoComments:removeThread", kind: "mutation", args: thread, ids: ["threadId"] },
  { name: "repoComments:addReply", kind: "mutation", args: f => ({ ...thread(f), body: "Test" }), ids: ["threadId"] },
  { name: "repoComments:removeReply", kind: "mutation", args: f => ({ ...thread(f), replyId: f.replyId }), ids: ["threadId", "replyId"] },
  // Edits (#287): the author's alone.
  { name: "repoComments:editThread", kind: "mutation", args: f => ({ ...thread(f), body: "Edited" }), ids: ["threadId"] },
  { name: "repoComments:editReply", kind: "mutation", args: f => ({ ...thread(f), replyId: f.replyId, body: "Edited" }), ids: ["threadId", "replyId"] },
];

function call(backend: Pick<Fixture["backend"], "query" | "mutation">, endpoint: Endpoint, args: Record<string, unknown>) {
  return endpoint.kind === "query"
    ? backend.query(makeFunctionReference<"query", Record<string, unknown>, unknown>(endpoint.name), args)
    : backend.mutation(makeFunctionReference<"mutation", Record<string, unknown>, unknown>(endpoint.name), args);
}
async function failure(result: Promise<unknown>, code: PublicErrorCode) {
  const error: unknown = await result.catch((error: unknown) => error);
  return errorEnvelope(error, code);
}
function errorEnvelope(error: unknown, code: PublicErrorCode) {
  expect(error).toBeInstanceOf(ConvexError);
  const data = (error as ConvexError<{ code: string; message: string }>).data;
  expect(Object.keys(data).sort()).toEqual(["code", "message"]);
  expect(data.code).toBe(code);
  expect(data.message).toBe(publicErrorMessages[code]);
  expect((error as Error).message).toBe(publicErrorMessages[code]);
  expect((error as Error).stack).not.toMatch(/\bat |\.ts:\d|convex\//);
  expect(data.message).not.toMatch(/convex\/|\.ts:\d|stack|trace|secret|token|org-/i);
  // Include non-enumerable Error fields and any trace fields the harness adds.
  return JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(error)
    .sort().map(key => [key, Reflect.get(error as object, key)])));
}

afterEach(() => vi.unstubAllEnvs());

describe("public Convex application error contract", () => {
  it("inventories every root client-callable query and mutation", () => {
    const actual = readdirSync("convex").filter(file => file.endsWith(".ts")).flatMap(file =>
      [...readFileSync(`convex/${file}`, "utf8").matchAll(/export const (\w+) = (query|mutation)\(/g)]
        .map(match => `${file.slice(0, -3)}:${match[1]}`));
    expect(actual.sort()).toEqual(endpoints.map(endpoint => endpoint.name).sort());
  });

  it.each(endpoints)("$name safely rejects malformed argument shapes", async endpoint => {
    const f = await fixture();
    await failure(call(f.backend, endpoint, { unexpected: "private-input" }), "invalid_input");
    const args = endpoint.args(f);
    const key = Object.keys(args)[0];
    await failure(call(f.backend, endpoint, { ...args, [key]: { private: "input" } }), "invalid_input");
  });

  it.each(endpoints)("$name safely rejects unauthenticated callers", async endpoint => {
    const f = await fixture();
    vi.stubEnv("CONVEX_INTERNAL_SECRET", "correct-secret");
    const args = { ...endpoint.args(f) };
    // Internal-secret endpoints refuse a wrong secret outright, whoever calls.
    if (endpoint.name.startsWith("repoComments:") && endpoint.name !== "repoComments:threadSnapshot") {
      // Access to repository comments is decided before anything else, and reveals nothing: no grant reads as
      // an empty page and writes as "not found", exactly like a repository nobody has commented on.
      const denied = { ...args, ...repoPage };
      if (endpoint.kind === "query") expect(await call(f.backend, endpoint, denied)).toEqual({ page: [], isDone: true, continueCursor: "" });
      else await failure(call(f.backend, endpoint, denied), "not_found");
      // Where anyone may read, writing still needs a signed-in reader.
      if (endpoint.kind === "mutation") await failure(call(f.backend, endpoint, args), "unauthenticated");
      return;
    }
    await failure(call(f.backend, endpoint, args), "forbidden");
  });

  it.each(endpoints.filter(endpoint => endpoint.ids.length))("$name answers malformed, wrong-table, missing and cross-repository IDs alike", async endpoint => {
    const f = await fixture();
    const records = await f.backend.run(async ctx => {
      const base = { repoId: 9002, path: f.scope.path, blobSha: repoAnchor().blobSha, anchor: repoAnchor(), authorId: "other-author", body: "private-body", resolved: false, archived: false, createdAt: Date.now(), updatedAt: Date.now() };
      const foreignThread = await ctx.db.insert("repoThreads", base);
      const missingThread = await ctx.db.insert("repoThreads", base);
      await ctx.db.delete(missingThread);
      const reply = { repoId: 9002, threadId: foreignThread, body: "private-body", authorId: "other-author", createdAt: Date.now() };
      const foreignReply = await ctx.db.insert("repoReplies", reply);
      const missingReply = await ctx.db.insert("repoReplies", reply);
      await ctx.db.delete(missingReply);
      return { foreignThread, missingThread, foreignReply, missingReply };
    });
    for (const id of endpoint.ids) {
      const args = endpoint.args(f);
      const values = id === "replyId"
        ? ["malformed-private-id", f.threadId, records.foreignReply, records.missingReply]
        : ["malformed-private-id", f.replyId, records.foreignThread, records.missingThread];
      const answers = [];
      for (const value of values) {
        const result = call(f.viewers.author, endpoint, { ...args, [id]: value });
        answers.push(endpoint.kind === "query" ? JSON.stringify(await result) : await failure(result, "not_found"));
      }
      expect(new Set(answers).size).toBe(1);
    }
  });

  it.each(["repoComments:listThreads", "repoComments:listReplies"])("%s rejects empty cursor and endCursor", async name => {
    const f = await fixture();
    const endpoint = endpoints.find(endpoint => endpoint.name === name)!;
    for (const field of ["cursor", "endCursor"]) {
      for (const cursor of ["", " "] ) {
        await failure(call(f.viewers.author, endpoint, {
          ...endpoint.args(f), paginationOpts: { ...paginationOpts, [field]: cursor },
        }), "invalid_input");
      }
    }
  });

  it.each(endpoints.filter(endpoint => endpoint.name.startsWith("repoComments:") && endpoint.kind === "mutation"))("$name classifies actual failures as definitive without displaying diagnostics", async endpoint => {
    const f = await fixture();
    const error: unknown = await call(f.viewers.author, endpoint, { ...endpoint.args(f), path: "docs/another.md", repoId: endpoint.ids.length ? f.scope.repoId : 9001 }).catch((error: unknown) => error);
    errorEnvelope(error, "not_found");
    expect(isDefinitiveCommentRejection(error)).toBe(true);
    expect(commentErrorMessage(error, "Fallback")).toBe("This comment is unavailable. Reload the document.");
  });

  it("leaves unexpected failures unchanged for Convex runtime redaction", async () => {
    const f = await fixture();
    const error = new Error("unexpected internal failure");
    const spy = vi.spyOn(authComponent, "safeGetAuthUser").mockRejectedValueOnce(error);
    try {
      await expect(f.viewers.author.query(api.repoComments.listThreads, { ...f.scope, paginationOpts })).rejects.toThrow(error);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns safe codes for permissions, validation and author changes", async () => {
    const f = await fixture();
    await failure(f.viewers.member.mutation(api.repoComments.archive, { ...thread(f), archived: true }), "forbidden");
    await failure(f.viewers.member.mutation(api.repoComments.removeThread, thread(f)), "forbidden");
    await failure(f.viewers.member.mutation(api.repoComments.removeReply, { ...thread(f), replyId: f.replyId }), "forbidden");
    await failure(f.viewers.member.mutation(api.repoComments.editThread, { ...thread(f), body: "Edited" }), "forbidden");
    await failure(f.viewers.member.mutation(api.repoComments.editReply, { ...thread(f), replyId: f.replyId, body: "Edited" }), "forbidden");
    await failure(f.viewers.author.mutation(api.repoComments.editThread, { ...thread(f), body: " " }), "invalid_input");
    await failure(f.viewers.author.mutation(api.repoComments.editReply, { ...thread(f), replyId: f.replyId, body: " " }), "invalid_input");
    await failure(f.viewers.author.mutation(api.repoComments.createThread, { ...f.scope, body: " ", anchor: repoAnchor() }), "invalid_input");
    await failure(f.viewers.author.mutation(api.repoComments.addReply, { ...thread(f), body: " " }), "invalid_input");
    await failure(f.viewers.author.mutation(api.repoComments.resolve, { ...thread(f), resolved: true, expectedAuthorId: "another-user" }), "forbidden");
    for (const clientOperationId of [" ", "x".repeat(129)]) {
      await failure(f.viewers.author.mutation(api.repoComments.addReply, { ...thread(f), body: "Test", clientOperationId }), "invalid_input");
    }
  });
});
