import type { User } from "better-auth/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, components } from "../convex/_generated/api";
import schema from "../convex/schema";
import { registerAuth, seedIdentity, seedLegacyMember } from "./helpers/auth-identity";
import { mappedOrganization } from "../convex/legacyAccess";
import worker from "@/worker";
import * as minio from "@/minio";
import { createShareToken } from "@/share-links";
import { createLegacyViewerTicket } from "@/viewer-ticket";
import { filterDeleted, isDeleted, markDeleted } from "@/soft-delete";
import { legacyMember, legacyOrganization } from "@/legacy-access";

const modules = import.meta.glob("../convex/**/*.ts");
const scope = { orgSlug: "example", filePath: "example/index.html" };
const anchor = { kind: "element" as const, path: ["main"] };
const internalSecret = process.env.CONVEX_INTERNAL_SECRET!;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture() {
  vi.stubEnv("LEGACY_ORGANIZATION_MAP", "{}");
  const backend = convexTest(schema, modules);
  registerAuth(backend);
  // A consumer email is allowed only because of this explicit membership.
  const identity = await seedIdentity(backend, { email: "mapped@gmail.com" });
  const org = await seedLegacyMember(backend, identity.subject, "example");
  const member = backend.withIdentity(identity);
  const threadId = await member.mutation(api.threads.create, { ...scope, body: "Thread", anchor });
  const replyId = await member.mutation(api.replies.add, { ...scope, threadId, body: "Reply" });
  return { backend, identity, org, member, threadId, replyId };
}

describe("v1 mapped membership", () => {
  it.each(["same@example.com", "same@example.net", "other@gmail.com", "outsider@other.test"])("denies every RPC to %s without mapped membership", async email => {
    const f = await fixture();
    const identity = await seedIdentity(f.backend, { email });
    await seedLegacyMember(f.backend, identity.subject, "other");
    const outsider = f.backend.withIdentity(identity);
    const calls = [
      () => outsider.query(api.threads.list, scope),
      () => outsider.mutation(api.threads.create, { ...scope, body: "No", anchor }),
      () => outsider.mutation(api.threads.resolve, { threadId: f.threadId }),
      () => outsider.mutation(api.threads.archive, { threadId: f.threadId }),
      () => outsider.mutation(api.threads.remove, { threadId: f.threadId }),
      () => outsider.mutation(api.replies.add, { threadId: f.threadId, body: "No" }),
      () => outsider.mutation(api.replies.remove, { threadId: f.threadId, replyId: f.replyId }),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ data: { code: "not_found" } });
    vi.stubEnv("LEGACY_ORGANIZATION_MAP", "{}");
    for (const call of calls) await expect(call()).rejects.toMatchObject({ data: { code: "not_found" } });
    expect(await f.backend.run(ctx => ctx.db.get(f.threadId))).toMatchObject({ body: "Thread", resolved: false });
  });
  it("allows mapped members, grants live admin moderation, then denies deleted organizations", async () => {
    const f = await fixture();
    expect(await f.member.query(api.threads.list, scope)).toHaveLength(1);
    const adminIdentity = await seedIdentity(f.backend, { email: "admin@elsewhere.test" });
    await seedLegacyMember(f.backend, adminIdentity.subject, "example", "member, admin");
    const admin = f.backend.withIdentity(adminIdentity);
    expect((await admin.query(api.threads.list, scope))[0].canDelete).toBe(true);
    await admin.mutation(api.threads.archive, { threadId: f.threadId });
    await admin.mutation(api.replies.remove, { threadId: f.threadId, replyId: f.replyId });
    await admin.mutation(api.threads.remove, { threadId: f.threadId });
    expect(await f.member.query(api.threads.list, scope)).toEqual([]);
    expect(await f.backend.query(api.legacyAccess.resolve, { orgSlug: "example", internalSecret })).toBe(f.org);
    await f.backend.run(ctx => ctx.db.insert("organizationTombstones", { organizationId: f.org, deletedAt: Date.now(), deletedBy: adminIdentity.subject }));
    expect(await f.backend.query(api.legacyAccess.resolve, { orgSlug: "example", internalSecret })).toBeNull();
    await expect(f.member.query(api.threads.list, scope)).rejects.toMatchObject({ data: { code: "not_found" } });
  });
  it("rechecks persisted membership and session revocation", async () => {
    const f = await fixture();
    await f.backend.run(async ctx => {
      await ctx.runMutation(components.betterAuth.adapter.deleteMany, { input: { model: "member", where: [{ field: "userId", value: f.identity.subject }] }, paginationOpts: { cursor: null, numItems: 100 } });
    });
    await expect(f.member.query(api.threads.list, scope)).rejects.toMatchObject({ data: { code: "not_found" } });
    await seedLegacyMember(f.backend, f.identity.subject, "example");
    await f.backend.run(ctx => ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: "session", where: [{ field: "_id", value: f.identity.sessionId }] } }));
    await expect(f.member.query(api.threads.list, scope)).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  });
  it("denies unmapped, missing and malformed operator bindings", async () => {
    const f = await fixture();
    expect(await f.backend.query(api.legacyAccess.resolve, { orgSlug: "missing", internalSecret })).toBeNull();
    vi.stubEnv("LEGACY_ORGANIZATION_MAP", '{"example":"nonexistent"}');
    expect(await f.backend.query(api.legacyAccess.resolve, { orgSlug: "example", internalSecret })).toBeNull();
    await expect(f.backend.query(api.legacyAccess.resolve, { orgSlug: "example", internalSecret: "wrong" })).rejects.toThrow();
    for (const value of ["null", "[]", '"x"', "{", '{"bad/slash":"id"}', '{"example":null}', '{"example":""}', '{"example":" id "}']) {
      vi.stubEnv("LEGACY_ORGANIZATION_MAP", value);
      expect(() => mappedOrganization("example")).toThrow();
    }
    vi.stubEnv("LEGACY_ORGANIZATION_MAP", undefined);
    expect(mappedOrganization("example")).toBeNull();
    expect(mappedOrganization("toString")).toBeNull();
  });
  it("bounds aggregate listing and rejects oversized deletion atomically", async () => {
    const f = await fixture();
    await f.backend.run(async ctx => {
      for (let n = 0; n < 101; n++) await ctx.db.insert("replies", { threadId: f.threadId, body: "Reply", authorEmail: f.identity.email, authorName: "Name" });
    });
    await expect(f.member.query(api.threads.list, scope)).rejects.toMatchObject({ data: { code: "invalid_input" } });
    await expect(f.member.mutation(api.threads.remove, { threadId: f.threadId })).rejects.toMatchObject({ data: { code: "invalid_input" } });
    expect(await f.backend.run(ctx => ctx.db.get(f.threadId))).toMatchObject({ body: "Thread" });
    await f.backend.run(async ctx => {
      for (let n = 0; n < 101; n++) await ctx.db.insert("threads", { ...scope, body: "Thread", anchor, authorEmail: f.identity.email, authorName: "Name", resolved: false });
    });
    await expect(f.member.query(api.threads.list, scope)).rejects.toMatchObject({ data: { code: "invalid_input" } });
  });
});

// Exercise real Worker routes and the required-backend wrappers. The transport
// fixture models independently mutable mapping, session, membership and storage.
describe("legacy Worker authorization and persistence", () => {
  const cookie = "better-auth.session_token=mapped-member";
  const publication = { orgSlug: "example", slug: "guide", sourcePrefix: "example/guide/", entryFile: "index.html", title: "Guide", createdAt: "now", updatedAt: "now" };
  let mapped: unknown, access: unknown, deleted: unknown, failure: string, mutationResult: unknown, email: string;
  const request = (path: string, init: RequestInit = {}) => worker.request(`http://localhost:3000${path}`, { ...init,
    headers: { Cookie: cookie, Origin: "http://localhost:3000", "Content-Type": "application/json", ...init.headers } });
  beforeEach(() => {
    mapped = "org-id"; deleted = false; failure = ""; mutationResult = null; email = "same@example.com";
    access = { id: "org-id", userId: "user", member: { userId: "user", role: "owner" } };
    vi.spyOn(minio, "headObject").mockResolvedValue({ contentType: "text/html" });
    vi.spyOn(minio, "getObjectStream").mockImplementation(key => Promise.resolve(new Response(key.startsWith("__rendro/") ? JSON.stringify(publication) : "<h1>Document</h1>").body));
    vi.spyOn(minio, "listImmediate").mockResolvedValue({ entries: [], isTruncated: false });
    vi.spyOn(minio, "listAllKeys").mockImplementation(prefix => Promise.resolve(prefix.startsWith("__rendro") ? ["__rendro/publications/example/guide.json"] : ["example/guide/index.html"]));
    vi.spyOn(minio, "putObject").mockResolvedValue();
    vi.spyOn(minio, "deleteObject").mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("get-session")) return await Promise.resolve(Response.json({ user: { id: "user", email, name: "Name", emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() }, session: { id: "session", expiresAt: Date.now() + 60_000 } }));
      if (url.includes("management/access")) return access === null ? new Response(null, { status: 403 }) : Response.json(access);
      const payload = JSON.parse(init?.body as string);
      if (failure === payload.path) return new Response(null, { status: 503 });
      const value = payload.path === "legacyAccess:resolve" ? mapped : payload.path === "deletedFiles:isDeleted" ? deleted
        : payload.path === "deletedFiles:filterFn" ? payload.args[0].keys : mutationResult;
      return Response.json({ status: "success", value });
    }));
  });
  async function privatePaths() { return ["/docs/example", "/docs/example/guide/index.html", "/files/example/guide/index.html", "/api/tree/example",
    "/api/share/create?key=example/guide/index.html", "/legacy-view/example/viewer-ticket?manifestKey=example",
    "/legacy-view/example/files/guide/index.html", `/legacy-view/example/view/${await createLegacyViewerTicket("example", cookie)}/files/guide/index.html`,
    "/api/publications?org=example"]; }
  function publicPaths() { return ["/public/example/guide", "/public/example/guide/tree", "/public/example/guide/sitemap.xml", "/public/example/guide/files/index.html", `/share/${createShareToken("example/guide/index.html")}`]; }
  it("allows mapped membership regardless of email, and denies all private routes after revocation", async () => {
    email = "mapped@gmail.com";
    for (const path of await privatePaths()) expect((await request(path)).status, path).toBe(path.startsWith("/files") ? 302 : 200);
    access = null;
    for (const path of await privatePaths()) expect((await request(path)).status, path).toBe(404);
    // Anonymous links intentionally remain usable after an individual's revocation.
    for (const path of publicPaths()) expect((await request(path, { headers: { Cookie: "" } })).status, path).toBe(200);
  });
  it("denies every route for an unmapped or inactive organization without reading storage", async () => {
    mapped = null;
    for (const path of [...await privatePaths(), ...publicPaths()]) expect((await request(path)).status, path).toBe(404);
    expect(minio.getObjectStream).not.toHaveBeenCalled();
    expect(minio.headObject).not.toHaveBeenCalled();
  });
  it.each(["same@example.com", "consumer@gmail.com", "other@other.test"])("denies reads and every publication/share mutation for nonmember %s", async address => {
    email = address;
    for (const organization of ["org-id", null]) {
      mapped = organization;
      access = null;
      for (const path of await privatePaths()) expect((await request(path)).status, path).toBe(404);
      expect((await request("/api/publications?org=example", { method: "POST", body: JSON.stringify({ slug: "guide", sourcePrefix: "example/guide/", entryFile: "index.html" }) })).status).toBe(404);
      expect((await request("/api/publications/guide?org=example", { method: "DELETE" })).status).toBe(404);
      expect((await request("/api/legacy/content?key=example/guide/index.html", { method: "DELETE" })).status).toBe(404);
    }
    expect(minio.putObject).not.toHaveBeenCalled();
    expect(minio.deleteObject).not.toHaveBeenCalled();
    expect(minio.getObjectStream).not.toHaveBeenCalled();
  });
  it("returns 503 for mapping uncertainty everywhere, before content reads", async () => {
    failure = "legacyAccess:resolve";
    for (const path of [...await privatePaths(), ...publicPaths()]) expect((await request(path)).status, path).toBe(503);
    expect(minio.getObjectStream).not.toHaveBeenCalled();
  });
  it("checks deletion on anonymous content reads and fails closed on invalid metadata", async () => {
    for (const value of [true, null, {}, "false"]) {
      deleted = value;
      for (const path of [(publicPaths()).at(-1)!, "/public/example/guide/files/index.html", "/files/example/guide/index.html"]) {
        expect((await request(path)).status).toBe(value === true ? 404 : 503);
      }
    }
  });
  it("retires every legacy-key operation, including publication mutations", async () => {
    for (const [path, method] of [["/api/orgs", "POST"], ["/api/sync/upload", "POST"], ["/api/sync/delete", "DELETE"], ["/api/sync/check", "GET"], ["/api/sync/list", "GET"], ["/api/publications?org=example", "POST"], ["/api/publications/guide?org=example", "DELETE"], ["/api/publications?org=example", "GET"]]) {
      expect((await request(path, { method, headers: { Authorization: "Bearer old-key" } })).status).toBe(410);
    }
    expect(minio.putObject).not.toHaveBeenCalled();
    expect(minio.deleteObject).not.toHaveBeenCalled();
  });
  it("requires owner/admin for destructive operations and never succeeds on failed persistence", async () => {
    const content = "/api/legacy/content?key=example/guide/index.html";
    const publicationPath = "/api/publications/guide?org=example";
    access = { id: "org-id", userId: "user", member: { userId: "user", role: "member" } };
    for (const path of [content, publicationPath]) expect((await request(path, { method: "DELETE" })).status).toBe(404);
    const create = { method: "POST", body: JSON.stringify({ slug: "guide", sourcePrefix: "example/guide/", entryFile: "index.html" }) };
    expect((await request("/api/publications?org=example", create)).status).toBe(200);
    vi.mocked(minio.putObject).mockRejectedValue(new Error("storage failure"));
    expect((await request("/api/publications?org=example", create)).status).toBe(503);
    access = { id: "org-id", userId: "user", member: { userId: "user", role: "member, admin" } };
    expect((await request(content, { method: "DELETE" })).status).toBe(200);
    failure = "deletedFiles:mark";
    expect((await request(content, { method: "DELETE" })).status).toBe(503);
    failure = ""; mutationResult = false;
    expect((await request(content, { method: "DELETE" })).status).toBe(503);
    expect((await request(publicationPath, { method: "DELETE" })).status).toBe(200);
    vi.mocked(minio.deleteObject).mockRejectedValue(new Error("storage failure"));
    expect((await request(publicationPath, { method: "DELETE" })).status).toBe(503);
  });
  it("rejects malformed content/tree requests and preserves missing-document errors", async () => {
    expect((await request("/api/legacy/content", { method: "DELETE" })).status).toBe(404);
    expect((await request("/api/legacy/content?key=example", { method: "DELETE" })).status).toBe(404);
    expect((await request("/api/tree/example?prefix=other/")).status).toBe(400);
    expect((await request("/docs/example/%ZZ")).status).toBe(404);
    deleted = true;
    expect((await request("/docs/example/guide/index.html")).status).toBe(404);
    deleted = false;
    vi.mocked(minio.headObject).mockResolvedValue(null);
    expect((await request("/docs/example/guide/index.html")).status).toBe(404);
    expect(await legacyMember("example", cookie)).toBe(true);
    const { legacyRequestMember } = await import("@/legacy-access");
    const { Hono } = await import("hono");
    const app = new Hono().get("/", async c => c.json(await legacyRequestMember(c, "example")));
    expect(await (await app.request("/")).json()).toBe(false);
  });
  it("validates required authorization response shapes", async () => {
    for (mapped of [false, "", 4, {}]) await expect(legacyOrganization("example")).rejects.toThrow();
    expect(await legacyOrganization("tenants")).toBeNull();
    expect(await legacyMember("example", "")).toBe(false);
    mapped = "org-id";
    for (access of [{}, { id: "other" }, { id: "org-id", userId: "user" }, { id: "org-id", userId: "user", member: { userId: "other", role: "owner" } }]) {
      await expect(legacyMember("example", cookie)).rejects.toThrow();
    }
  });
  it("validates deletion batches and chunks large reads", async () => {
    const keys = Array.from({ length: 201 }, (_, n) => `example/${n}.html`);
    expect(await filterDeleted(keys)).toEqual(keys);
    expect(await filterDeleted([])).toEqual([]);
    const calls = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init?.body as string) as { args: Array<{ keys: string[] }> });
    expect(calls.map(call => call.args[0].keys.length)).toEqual([100, 100, 1]);
    for (const value of [null, {}, ["outside"], [keys[0], keys[0]], [4]]) {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ status: "success", value }));
      await expect(filterDeleted(keys)).rejects.toThrow();
    }
    for (const response of [new Response(null, { status: 404 }), Response.json({ status: "error" }), Response.json({ status: "success" }), new Response("bad json")]) {
      vi.mocked(fetch).mockResolvedValueOnce(response);
      await expect(isDeleted("example/index.html")).rejects.toThrow();
    }
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"));
    await expect(markDeleted("example", "example/index.html")).rejects.toThrow();
  });
});

it("bounds service deletion reads and persists deletion before reporting success", async () => {
  const backend = convexTest(schema, modules);
  const args = { orgSlug: "example", fileKey: "example/one.html", internalSecret };
  expect(await backend.query(api.deletedFiles.isDeleted, { fileKey: args.fileKey, internalSecret })).toBe(false);
  await backend.mutation(api.deletedFiles.mark, args);
  await backend.mutation(api.deletedFiles.mark, args);
  expect(await backend.query(api.deletedFiles.isDeleted, { fileKey: args.fileKey, internalSecret })).toBe(true);
  expect(await backend.query(api.deletedFiles.filterFn, { keys: [args.fileKey, "example/two.html"], internalSecret })).toEqual(["example/two.html"]);
  expect(await backend.query(api.deletedFiles.filterFn, { keys: [], internalSecret })).toEqual([]);
  await expect(backend.query(api.deletedFiles.filterFn, { keys: Array(101).fill("example/key"), internalSecret })).rejects.toThrow();
  await expect(backend.query(api.deletedFiles.isDeleted, { fileKey: args.fileKey, internalSecret: "x".repeat(internalSecret.length) })).rejects.toThrow();
});

it("cleans legacy status receipts in bounded batches", async () => {
  const { internal } = await import("../convex/_generated/api");
  const f = await fixture();
  await f.backend.run(async ctx => {
    for (let n = 0; n < 101; n++) await ctx.db.insert("legacyCommentStatusReceipts", {
      threadId: f.threadId, authorId: f.identity.subject, clientOperationId: String(n), field: "resolved", target: true, expiresAt: 0,
    });
  });
  vi.useFakeTimers();
  await f.backend.mutation(internal.threads.cleanupStatusReceipts, {});
  try { await f.backend.finishAllScheduledFunctions(() => vi.runAllTimers()); } finally { vi.useRealTimers(); }
  expect(await f.backend.run(ctx => ctx.db.query("legacyCommentStatusReceipts").collect())).toEqual([]);
});

it.each(["CONVEX_URL", "CONVEX_INTERNAL_SECRET"])("requires configured %s for backend reads", async missing => {
  vi.resetModules();
  vi.doMock("@/config", () => ({ CONVEX_URL: missing === "CONVEX_URL" ? "" : "http://backend", CONVEX_INTERNAL_SECRET: missing === "CONVEX_INTERNAL_SECRET" ? "" : "secret" }));
  try {
    const { convexQueryRequired } = await import("@/convex-internal");
    await expect(convexQueryRequired("deletedFiles:isDeleted", {})).rejects.toThrow();
  } finally { vi.doUnmock("@/config"); vi.resetModules(); }
});

it("renders empty scoped shells and safe fallback account labels", async () => {
  const { renderScopedDocumentShell } = await import("@/routes/app");
  for (const email of ["user@example.com", ""]) {
    const html = renderScopedDocumentShell({ user: { id: "user", email, name: "" } as User, namespace: "example", title: "Docs", basePath: "/docs", selectedPath: "", backHref: "/organizations" });
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-downloads"');
  }
});
