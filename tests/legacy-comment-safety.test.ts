import { seedLegacyMember, registerAuth, seedIdentity } from "./helpers/auth-identity";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
const modules = import.meta.glob("../convex/**/*.ts");
const scope = { orgSlug: "example", filePath: "example/guide/index.html" };
const anchor = { kind: "element" as const, path: ["main", "h1"] };
async function fixture() {
  process.env.LEGACY_ORGANIZATION_MAP = "{}";
  const backend = convexTest(schema, modules);
  registerAuth(backend);
  const identity = await seedIdentity(backend, { email: "author@example.com", name: "Author" });
  await seedLegacyMember(backend, identity.subject, "example");
  const author = backend.withIdentity(identity);
  const memberIdentity = await seedIdentity(backend, { email: "member@example.com", name: "Member" });
  await seedLegacyMember(backend, memberIdentity.subject, "example");
  const member = backend.withIdentity(memberIdentity);
  const outsider = backend.withIdentity(await seedIdentity(backend, { email: "outsider@other.com" }));
  return { backend, author, member, outsider, authorId: identity.subject };
}
describe("legacy comment bridge backend", () => {
  it("preserves all operations with author-only archive/delete and explicit permissions", async () => {
    const { author, member, outsider } = await fixture();
    const threadId = await author.mutation(api.threads.create, { ...scope, body: "Thread", anchor });
    const replyId = await member.mutation(api.replies.add, { ...scope, threadId, body: "Reply" });
    const listed = await member.query(api.threads.list, scope);
    expect(listed[0]).toMatchObject({ canDelete: false, replies: [{ _id: replyId, canDelete: true }] });
    await expect(member.mutation(api.threads.archive, { ...scope, threadId })).rejects.toMatchObject({ data: { code: "forbidden", message: "Forbidden" } });
    await expect(member.mutation(api.threads.remove, { ...scope, threadId })).rejects.toMatchObject({ data: { code: "forbidden", message: "Forbidden" } });
    await expect(author.mutation(api.replies.remove, { ...scope, threadId, replyId })).rejects.toMatchObject({ data: { code: "forbidden", message: "Forbidden" } });
    await expect(outsider.mutation(api.replies.add, { ...scope, threadId, body: "No" })).rejects.toThrow("Comment not found");
    await member.mutation(api.threads.resolve, { ...scope, threadId, resolved: true });
    await author.mutation(api.threads.archive, { ...scope, threadId, archived: true });
    await author.mutation(api.threads.archive, { ...scope, threadId, archived: false });
    await member.mutation(api.replies.remove, { ...scope, threadId, replyId });
    expect((await author.query(api.threads.list, scope))[0]).toMatchObject({ resolved: true, archived: false, replies: [] });
    await author.mutation(api.threads.remove, { ...scope, threadId });
    expect(await author.query(api.threads.list, scope)).toEqual([]);
  });
  it("deduplicates creates/replies after retries and deletion and rejects changed sessions/scopes", async () => {
    const { author, backend, authorId } = await fixture();
    const create = { ...scope, body: "Thread", anchor, clientOperationId: "create-1", expectedAuthorId: authorId };
    const threadId = await author.mutation(api.threads.create, create);
    expect(await author.mutation(api.threads.create, create)).toBe(threadId);
    const add = { ...scope, threadId, body: "Reply", clientOperationId: "reply-1", expectedAuthorId: authorId };
    const replyId = await author.mutation(api.replies.add, add);
    expect(await author.mutation(api.replies.add, add)).toBe(replyId);
    await expect(author.mutation(api.threads.create, { ...create, expectedAuthorId: "other" })).rejects.toMatchObject({ data: { code: "forbidden", message: "Forbidden" } });
    await expect(author.mutation(api.threads.remove, { ...scope, filePath: "example/other.html", threadId })).rejects.toThrow("Comment not found");
    await author.mutation(api.threads.remove, { ...scope, threadId, clientOperationId: "remove" });
    await author.mutation(api.threads.remove, { ...scope, threadId, clientOperationId: "remove" });
    expect(await author.mutation(api.threads.create, create)).toBe(threadId);
    expect(await author.mutation(api.replies.add, add)).toBe(replyId);
    expect(await author.query(api.threads.list, scope)).toEqual([]);
    expect(await backend.run(ctx => ctx.db.get(threadId))).toMatchObject({ body: "", deletedAt: expect.any(Number) });
  });
  it("does not replay status writes over newer decisions", async () => {
    const { author } = await fixture();
    const threadId = await author.mutation(api.threads.create, { ...scope, body: "Thread", anchor });
    const operation = { ...scope, threadId, resolved: true, clientOperationId: "resolve-1" };
    await author.mutation(api.threads.resolve, operation);
    await author.mutation(api.threads.resolve, { ...operation, resolved: false, clientOperationId: "resolve-2" });
    await author.mutation(api.threads.resolve, operation);
    expect((await author.query(api.threads.list, scope))[0].resolved).toBe(false);
    await expect(author.mutation(api.threads.resolve, { ...operation, resolved: false })).rejects.toThrow("Operation arguments changed");
  });
  it("keeps pre-migration authors and replies readable and uses their stored email for ownership", async () => {
    const { backend, author, member } = await fixture();
    const threadId = await backend.run(ctx => ctx.db.insert("threads", { ...scope, body: "Old", anchor, authorEmail: "author@example.com", authorName: "Original", resolved: false }));
    expect((await author.query(api.threads.list, scope))[0].canDelete).toBe(true);
    expect((await member.query(api.threads.list, scope))[0].canDelete).toBe(false);
    await author.mutation(api.threads.archive, { threadId });
    await author.mutation(api.threads.remove, { threadId });
    expect(await author.query(api.threads.list, scope)).toEqual([]);
  });
});
