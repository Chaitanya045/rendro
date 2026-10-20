import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { authComponent } from "../convex/auth";
import { api } from "../convex/_generated/api";
import { fixture as projectFixture } from "./helpers/comment-fixture";
import { commentErrorMessage, isDefinitiveCommentRejection } from "../src/commentor/errors";
import { publicErrorMessages, type PublicErrorCode } from "../src/shared/public-errors";

const anchor = { kind: "element" as const, path: ["main"] };
const paginationOpts = { cursor: null, numItems: 10 };
const repoPage = { repoId: 9001, path: "docs/guide.md" };
const repoAnchor = { kind: "repo-text" as const, blobSha: "a".repeat(40), headingSlug: "", prefix: "", exact: "Test", suffix: "", offset: 0 };
async function fixture() {
  const f = await projectFixture();
  vi.stubEnv("LEGACY_ORGANIZATION_MAP", JSON.stringify({ example: f.data.organizationId }));
  const legacyIdentity = { subject: f.data.users[0].userId, sessionId: f.data.users[0].sessionId, email: "author@example.test" };
  const memberIdentity = { subject: f.data.users[1].userId, sessionId: f.data.users[1].sessionId, email: "member@example.test" };
  const legacy = await f.backend.run(async ctx => {
    const legacyThreadId = await ctx.db.insert("threads", { orgSlug: "example", filePath: "index.html", body: "Thread", anchor, authorId: legacyIdentity.subject, authorEmail: "author@example.test", authorName: "Author", resolved: false });
    const legacyReplyId = await ctx.db.insert("replies", { threadId: legacyThreadId, body: "Reply", authorId: legacyIdentity.subject, authorEmail: "author@example.test", authorName: "Author" });
    return { legacyThreadId, legacyReplyId };
  });
  return { ...f, ...legacy, legacyIdentity, memberIdentity };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Endpoint = { name: string; kind: "query" | "mutation"; args: (f: Fixture) => Record<string, unknown>; ids: string[] };
const document = (f: Fixture) => ({ ...f.scope });
const thread = (f: Fixture) => ({ ...f.scope, threadId: f.threadId });
const endpoints: Endpoint[] = [
  { name: "legacyAccess:resolve", kind: "query", args: () => ({ orgSlug: "example", internalSecret: "wrong" }), ids: [] },
  { name: "projects:activeDeployment", kind: "query", args: f => ({ organizationId: f.scope.organizationId, projectId: f.scope.projectId }), ids: ["projectId"] },
  { name: "documentThreads:list", kind: "query", args: f => ({ ...document(f), paginationOpts }), ids: ["projectId"] },
  { name: "documentThreads:create", kind: "mutation", args: f => ({ ...document(f), body: "Test", anchor }), ids: ["projectId"] },
  ...["resolve", "archive", "remove"].map(name => ({ name: `documentThreads:${name}`, kind: "mutation" as const, args: thread, ids: ["projectId", "threadId"] })),
  { name: "documentReplies:list", kind: "query", args: f => ({ ...thread(f), paginationOpts }), ids: ["projectId", "threadId"] },
  { name: "documentReplies:add", kind: "mutation", args: f => ({ ...thread(f), body: "Test" }), ids: ["projectId", "threadId"] },
  { name: "documentReplies:remove", kind: "mutation", args: f => ({ ...thread(f), replyId: f.replyId }), ids: ["projectId", "threadId", "replyId"] },
  { name: "threads:list", kind: "query", args: () => ({ orgSlug: "example", filePath: "index.html" }), ids: [] },
  { name: "threads:create", kind: "mutation", args: () => ({ orgSlug: "example", filePath: "index.html", body: "Test", anchor }), ids: [] },
  ...["resolve", "archive", "remove"].map(name => ({ name: `threads:${name}`, kind: "mutation" as const, args: (f: Fixture) => ({ threadId: f.legacyThreadId }), ids: ["threadId"] })),
  { name: "replies:add", kind: "mutation", args: f => ({ threadId: f.legacyThreadId, body: "Test" }), ids: ["threadId"] },
  { name: "replies:remove", kind: "mutation", args: f => ({ threadId: f.legacyThreadId, replyId: f.legacyReplyId }), ids: ["threadId", "replyId"] },
  { name: "deletedFiles:mark", kind: "mutation", args: () => ({ orgSlug: "example", fileKey: "key", internalSecret: "wrong" }), ids: [] },
  ...["isDeleted"].map(name => ({ name: `deletedFiles:${name}`, kind: name === "isDeleted" ? "query" as const : "mutation" as const, args: () => ({ fileKey: "key", internalSecret: "wrong" }), ids: [] })),
  { name: "deletedFiles:filterFn", kind: "query", args: () => ({ keys: [], internalSecret: "wrong" }), ids: [] },
  // Repository docs (#254): the read path's internal grant calls, then the comments themselves. Their own
  // cross-repository ID, anchor and access matrix is in tests/repo-comments-convex.test.ts.
  { name: "repoCommentAccess:grant", kind: "mutation", args: () => ({ internalSecret: "wrong", repoId: 1, userId: null, epoch: 0, expiresAt: Date.now() + 1_000 }), ids: [] },
  { name: "repoCommentAccess:revokeUser", kind: "mutation", args: () => ({ internalSecret: "wrong", userId: "user", epoch: 1 }), ids: [] },
  { name: "repoCommentAccess:removeRepos", kind: "mutation", args: () => ({ internalSecret: "wrong", repoIds: [1] }), ids: [] },
  { name: "repoCommentAccess:purgeRepos", kind: "mutation", args: () => ({ internalSecret: "wrong", repoIds: [1] }), ids: [] },
  { name: "repoCommentAccess:restoreRepos", kind: "mutation", args: () => ({ internalSecret: "wrong", repoIds: [1] }), ids: [] },
  // The read path's first-page snapshot (#284): internal secret only.
  { name: "repoComments:threadSnapshot", kind: "query", args: () => ({ internalSecret: "wrong", ...repoPage, userId: null, epoch: 0 }), ids: [] },
  { name: "repoComments:listThreads", kind: "query", args: () => ({ ...repoPage, paginationOpts }), ids: [] },
  { name: "repoComments:listReplies", kind: "query", args: f => ({ ...repoPage, threadId: f.threadId, paginationOpts }), ids: [] },
  { name: "repoComments:createThread", kind: "mutation", args: () => ({ ...repoPage, body: "Test", anchor: repoAnchor }), ids: [] },
  { name: "repoComments:resolve", kind: "mutation", args: f => ({ ...repoPage, threadId: f.threadId, resolved: true }), ids: [] },
  { name: "repoComments:archive", kind: "mutation", args: f => ({ ...repoPage, threadId: f.threadId, archived: true }), ids: [] },
  { name: "repoComments:removeThread", kind: "mutation", args: f => ({ ...repoPage, threadId: f.threadId }), ids: [] },
  { name: "repoComments:addReply", kind: "mutation", args: f => ({ ...repoPage, threadId: f.threadId, body: "Test" }), ids: [] },
  { name: "repoComments:removeReply", kind: "mutation", args: f => ({ ...repoPage, threadId: f.threadId, replyId: f.replyId }), ids: [] },
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
    const key = Object.keys(args)[0] ?? "threadId";
    await failure(call(f.backend, endpoint, { ...args, [key]: { private: "input" } }), "invalid_input");
  });

  it.each(endpoints)("$name safely rejects unauthenticated callers", async endpoint => {
    const f = await fixture();
    vi.stubEnv("CONVEX_INTERNAL_SECRET", "correct-secret");
    // Internal-secret endpoints refuse a wrong secret outright, whoever calls.
    const service = /^(legacyAccess|deletedFiles|repoCommentAccess):|^repoComments:threadSnapshot$/.test(endpoint.name);
    const args = { ...endpoint.args(f) };
    if (!/^(document|projects:)/.test(endpoint.name) && endpoint.ids.length) args.threadId = "malformed";
    if (endpoint.name.startsWith("repoComments:") && !service) {
      // Access to repository comments is decided before anything else, and reveals nothing: no grant reads as
      // an empty page and writes as "not found", exactly like a repository nobody has commented on.
      if (endpoint.kind === "query") expect(await call(f.backend, endpoint, args)).toEqual({ page: [], isDone: true, continueCursor: "" });
      else await failure(call(f.backend, endpoint, args), "not_found");
      return;
    }
    await failure(call(f.backend, endpoint, args), service ? "forbidden" : endpoint.name === "projects:activeDeployment" ? "not_found" : "unauthenticated");
  });

  it.each(endpoints.filter(endpoint => endpoint.ids.length))("$name covers every ID with malformed, wrong-table, missing and cross-org values", async endpoint => {
    const f = await fixture();
    const legacy = !/^(document|projects:)/.test(endpoint.name);
    const viewer = legacy ? f.backend.withIdentity(f.legacyIdentity) : f.viewers.author;
    const records = await f.backend.run(async ctx => {
      const project = { organizationId: f.data.otherOrgId, slug: "other", name: "Other", createdBy: "author", createdAt: Date.now() };
      const projectId = await ctx.db.insert("projects", project);
      const missingProject = await ctx.db.insert("projects", project);
      await ctx.db.delete(missingProject);
      const base = { organizationId: f.data.otherOrgId, projectId, documentPath: "guide.html", body: "private-body", authorId: "other-author", anchor, resolved: false, archived: false, createdAt: Date.now(), updatedAt: Date.now() };
      const foreignThread = await ctx.db.insert("documentThreads", base);
      const missingThread = await ctx.db.insert("documentThreads", base);
      await ctx.db.delete(missingThread);
      const reply = { organizationId: f.data.otherOrgId, threadId: foreignThread, body: "private-body", authorId: "other-author", createdAt: Date.now(), updatedAt: Date.now() };
      const foreignReply = await ctx.db.insert("documentReplies", reply);
      const missingReply = await ctx.db.insert("documentReplies", reply);
      await ctx.db.delete(missingReply);
      const old = { orgSlug: "other", filePath: "index.html", body: "private-body", authorEmail: "other@other.test", authorName: "Other", anchor, resolved: false };
      const foreignLegacy = await ctx.db.insert("threads", old);
      const missingLegacy = await ctx.db.insert("threads", old);
      await ctx.db.delete(missingLegacy);
      const oldReply = { threadId: foreignLegacy, body: "private-body", authorEmail: "other@other.test", authorName: "Other" };
      const foreignLegacyReply = await ctx.db.insert("replies", oldReply);
      const missingLegacyReply = await ctx.db.insert("replies", oldReply);
      await ctx.db.delete(missingLegacyReply);
      return { foreignLegacyReply, missingLegacyReply, projectId, missingProject, foreignThread, missingThread, foreignReply, missingReply, foreignLegacy, missingLegacy };
    });
    for (const id of endpoint.ids) {
      const args = endpoint.args(f);
      const missing = id === "projectId" ? records.missingProject : id === "replyId" ? (legacy ? records.missingLegacyReply : records.missingReply) : legacy ? records.missingLegacy : records.missingThread;
      const foreign = id === "projectId" ? records.projectId : id === "replyId" ? (legacy ? records.foreignLegacyReply : records.foreignReply) : legacy ? records.foreignLegacy : records.foreignThread;
      const wrongTable = id === "projectId" ? f.threadId : f.scope.projectId;
      for (const value of ["malformed-private-id", wrongTable]) {
        await failure(call(viewer, endpoint, { ...args, [id]: value }), "invalid_id");
      }
      const inaccessible = await failure(call(viewer, endpoint, { ...args, [id]: foreign }), "not_found");
      const absent = await failure(call(viewer, endpoint, { ...args, [id]: missing }), "not_found");
      expect(absent).toBe(inaccessible);
    }
    if (!legacy) {
      for (const organizationId of ["malformed", f.scope.projectId, records.missingProject, f.data.otherOrgId]) {
        await failure(call(viewer, endpoint, { ...endpoint.args(f), organizationId }), "not_found");
      }
    }
  });

  it.each(["documentThreads:list", "documentReplies:list"])("%s rejects empty cursor and endCursor", async name => {
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


  describe("legacy producer and widget error contract", () => {
    it.each(endpoints.filter(endpoint => /^(threads|replies):/.test(endpoint.name)))("$name classifies actual failures as definitive without displaying diagnostics", async endpoint => {
      const f = await fixture();
      const viewer = f.backend.withIdentity(f.legacyIdentity);
      const args = endpoint.args(f);
      const denied = endpoint.ids.length ? { ...args, filePath: "another-document.html" } : { ...args, orgSlug: "other" };
      const code = "not_found";
      const error: unknown = await call(viewer, endpoint, denied).catch((error: unknown) => error);
      errorEnvelope(error, code);
      expect(isDefinitiveCommentRejection(error)).toBe(true);
      expect(commentErrorMessage(error, "Fallback")).toBe("This comment is unavailable. Reload the document.");
    });

    it("rejects legacy validation, author changes, status receipt conflicts and tombstoned records safely", async () => {
      const f = await fixture();
      const author = f.backend.withIdentity(f.legacyIdentity);
      const member = f.backend.withIdentity(f.memberIdentity);
      const scope = { orgSlug: "example", filePath: "index.html" };
      const thread = { ...scope, threadId: f.legacyThreadId };
      const reply = { ...thread, replyId: f.legacyReplyId };
      const create = { ...scope, body: "Test", anchor };
      for (const body of [" ", "x".repeat(10_001)]) {
        await failure(author.mutation(api.threads.create, { ...create, body }), "invalid_input");
        await failure(author.mutation(api.replies.add, { ...thread, body }), "invalid_input");
      }
      for (const filePath of ["", "../private.html", "a//b", "a\\b"]) {
        await failure(author.mutation(api.threads.create, { ...create, filePath }), "invalid_input");
      }
      await failure(author.mutation(api.threads.create, { ...create, anchor: { kind: "element", path: [] } }), "invalid_input");
      for (const endpoint of endpoints.filter(endpoint => /^(threads|replies):/.test(endpoint.name) && endpoint.kind === "mutation")) {
        await failure(call(author, endpoint, { ...endpoint.args(f), expectedAuthorId: "changed" }), "forbidden");
        for (const clientOperationId of [" ", "x".repeat(129)]) {
          await failure(call(author, endpoint, { ...endpoint.args(f), clientOperationId }), "invalid_input");
        }
      }
      await failure(member.mutation(api.threads.archive, thread), "forbidden");
      await failure(member.mutation(api.threads.remove, thread), "forbidden");
      await failure(member.mutation(api.replies.remove, reply), "forbidden");
      for (const field of ["resolved", "archived"] as const) {
        const endpoint = field === "resolved" ? api.threads.resolve : api.threads.archive;
        await failure(author.mutation(endpoint, { ...thread, clientOperationId: field }), "invalid_input");
        await author.mutation(endpoint, { ...thread, clientOperationId: field, [field]: true });
        await failure(author.mutation(endpoint, { ...thread, clientOperationId: field, [field]: false }), "conflict");
      }
      await failure(author.mutation(api.threads.archive, { ...thread, clientOperationId: "resolved", archived: true }), "conflict");
      const anotherThread = await author.mutation(api.threads.create, create);
      const inaccessible = await failure(author.mutation(api.replies.remove, { ...reply, threadId: anotherThread }), "not_found");
      await f.backend.run(ctx => ctx.db.delete(f.legacyReplyId));
      expect(await failure(author.mutation(api.replies.remove, { ...reply, threadId: anotherThread }), "not_found")).toBe(inaccessible);
      await author.mutation(api.threads.remove, thread);
      await failure(author.mutation(api.threads.resolve, thread), "not_found");
      await failure(author.mutation(api.threads.archive, thread), "not_found");
      await failure(author.mutation(api.replies.add, { ...thread, body: "Test" }), "not_found");
    });
  });

  it("safely rejects missing, malformed, wrong-table session identities", async () => {
    const f = await fixture();
    for (const sessionId of [undefined, "malformed", f.scope.projectId]) {
      const viewer = f.backend.withIdentity({ subject: f.data.users[0].userId, ...(sessionId === undefined ? {} : { sessionId }) });
      await failure(viewer.query(api.documentThreads.list, { ...f.scope, paginationOpts }), "unauthenticated");
    }
  });

  it("leaves unexpected failures unchanged for Convex runtime redaction", async () => {
    const f = await fixture();
    const error = new Error("unexpected internal failure");
    const spy = vi.spyOn(authComponent, "safeGetAuthUser").mockRejectedValueOnce(error);
    try {
      await expect(f.viewers.author.query(api.documentThreads.list, { ...f.scope, paginationOpts })).rejects.toThrow(error);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns safe codes for permissions, validation, author changes and receipt conflicts", async () => {
    const f = await fixture();
    await failure(f.viewers.member.mutation(api.documentThreads.archive, { ...f.scope, threadId: f.threadId }), "forbidden");
    await failure(f.viewers.member.mutation(api.documentReplies.remove, { ...f.scope, threadId: f.threadId, replyId: f.replyId }), "forbidden");
    await failure(f.viewers.author.mutation(api.documentThreads.create, { ...f.scope, body: " ", anchor }), "invalid_input");
    await failure(f.viewers.author.mutation(api.documentReplies.add, { ...f.scope, threadId: f.threadId, body: " " }), "invalid_input");
    await failure(f.viewers.author.mutation(api.documentThreads.resolve, { ...f.scope, threadId: f.threadId, expectedAuthorId: "another-user" }), "forbidden");
    const operation = { ...f.scope, threadId: f.threadId, clientOperationId: "receipt", resolved: true };
    await f.viewers.author.mutation(api.documentThreads.resolve, operation);
    await failure(f.viewers.author.mutation(api.documentThreads.resolve, { ...operation, resolved: false }), "conflict");
  });
});
