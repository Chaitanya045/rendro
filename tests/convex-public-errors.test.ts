import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { authComponent } from "../convex/auth";
import { api } from "../convex/_generated/api";
import { fixture } from "./helpers/comment-fixture";
import { publicErrorMessages, type PublicErrorCode } from "../src/shared/public-errors";

const anchor = { kind: "element" as const, path: ["main"] };
const paginationOpts = { cursor: null, numItems: 10 };
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Endpoint = { name: string; kind: "query" | "mutation"; args: (f: Fixture) => Record<string, unknown>; ids: string[] };
const document = (f: Fixture) => ({ ...f.scope });
const thread = (f: Fixture) => ({ ...f.scope, threadId: f.threadId });
const endpoints: Endpoint[] = [
  { name: "documentThreads:list", kind: "query", args: f => ({ ...document(f), paginationOpts }), ids: ["projectId"] },
  { name: "documentThreads:create", kind: "mutation", args: f => ({ ...document(f), body: "Test", anchor }), ids: ["projectId"] },
  ...["resolve", "archive", "remove"].map(name => ({ name: `documentThreads:${name}`, kind: "mutation" as const, args: thread, ids: ["projectId", "threadId"] })),
  { name: "documentReplies:list", kind: "query", args: f => ({ ...thread(f), paginationOpts }), ids: ["projectId", "threadId"] },
  { name: "documentReplies:add", kind: "mutation", args: f => ({ ...thread(f), body: "Test" }), ids: ["projectId", "threadId"] },
  { name: "documentReplies:remove", kind: "mutation", args: f => ({ ...thread(f), replyId: f.replyId }), ids: ["projectId", "threadId", "replyId"] },
  { name: "threads:list", kind: "query", args: () => ({ orgSlug: "example", filePath: "index.html" }), ids: [] },
  { name: "threads:create", kind: "mutation", args: () => ({ orgSlug: "example", filePath: "index.html", body: "Test", anchor }), ids: [] },
  ...["resolve", "archive", "remove"].map(name => ({ name: `threads:${name}`, kind: "mutation" as const, args: () => ({}), ids: ["threadId"] })),
  { name: "replies:add", kind: "mutation", args: () => ({ body: "Test" }), ids: ["threadId"] },
  { name: "apiKeys:create", kind: "mutation", args: () => ({ orgSlug: "example", keyHash: "hash", internalSecret: "wrong" }), ids: [] },
  { name: "apiKeys:validate", kind: "query", args: () => ({ keyHash: "hash", internalSecret: "wrong" }), ids: [] },
  { name: "deletedFiles:mark", kind: "mutation", args: () => ({ orgSlug: "example", fileKey: "key", internalSecret: "wrong" }), ids: [] },
  ...["isDeleted", "unmark"].map(name => ({ name: `deletedFiles:${name}`, kind: name === "isDeleted" ? "query" as const : "mutation" as const, args: () => ({ fileKey: "key", internalSecret: "wrong" }), ids: [] })),
  { name: "deletedFiles:filterFn", kind: "query", args: () => ({ keys: [], internalSecret: "wrong" }), ids: [] },
];

function call(backend: Pick<Fixture["backend"], "query" | "mutation">, endpoint: Endpoint, args: Record<string, unknown>) {
  return endpoint.kind === "query"
    ? backend.query(makeFunctionReference<"query", Record<string, unknown>, unknown>(endpoint.name), args)
    : backend.mutation(makeFunctionReference<"mutation", Record<string, unknown>, unknown>(endpoint.name), args);
}
async function failure(result: Promise<unknown>, code: PublicErrorCode) {
  const error: unknown = await result.catch((error: unknown) => error);
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
    const service = endpoint.name.startsWith("apiKeys:") || endpoint.name.startsWith("deletedFiles:");
    const args = { ...endpoint.args(f) };
    if (!endpoint.name.startsWith("document") && endpoint.ids.length) args.threadId = "malformed";
    await failure(call(f.backend, endpoint, args), service ? "forbidden" : "unauthenticated");
  });

  it.each(endpoints.filter(endpoint => endpoint.ids.length))("$name covers every ID with malformed, wrong-table, missing and cross-org values", async endpoint => {
    const f = await fixture();
    const legacy = !endpoint.name.startsWith("document");
    const viewer = legacy ? f.backend.withIdentity({ subject: "legacy", email: "author@example.test" }) : f.viewers.author;
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
      return { projectId, missingProject, foreignThread, missingThread, foreignReply, missingReply, foreignLegacy, missingLegacy };
    });
    for (const id of endpoint.ids) {
      const args = endpoint.args(f);
      const missing = id === "projectId" ? records.missingProject : id === "replyId" ? records.missingReply : legacy ? records.missingLegacy : records.missingThread;
      const foreign = id === "projectId" ? records.projectId : id === "replyId" ? records.foreignReply : legacy ? records.foreignLegacy : records.foreignThread;
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
