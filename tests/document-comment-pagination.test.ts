import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, components, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("../convex/**/*.ts");

async function commentFixture(transactionLimits = false) {
  const backend = transactionLimits
    ? convexTest({ schema, modules, transactionLimits: true })
    : convexTest(schema, modules);
  backend.registerComponent(
    "betterAuth",
    betterAuthSchema,
    import.meta.glob("../convex/betterAuth/**/*.ts"),
  );
  const now = Date.now();
  const seeded = await backend.run(async (ctx) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: { name: "Comment member", email: "member@example.test", emailVerified: true, createdAt: now, updatedAt: now } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: { token: "comment-session", userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000 } },
    });
    const outsider = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: { name: "Outsider", email: "outsider@example.test", emailVerified: true, createdAt: now, updatedAt: now } },
    });
    const outsiderSession = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: { token: "outsider-session", userId: outsider._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000 } },
    });
    const organization = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "organization", data: { name: "Comment org", slug: "comment-org", createdAt: now } },
    });
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "member", data: { organizationId: organization._id, userId: user._id, role: "member", createdAt: now } },
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: organization._id,
      name: "Docs",
      slug: "docs",
      createdBy: user._id,
      createdAt: now,
    });
    return {
      organizationId: organization._id,
      projectId,
      userId: user._id,
      sessionId: session._id,
      outsiderId: outsider._id,
      outsiderSessionId: outsiderSession._id,
      now,
    };
  });
  return {
    backend,
    seeded,
    member: backend.withIdentity({
      subject: seeded.userId,
      sessionId: seeded.sessionId,
      email: "member@example.test",
      name: "Comment member",
    }),
    outsider: backend.withIdentity({
      subject: seeded.outsiderId,
      sessionId: seeded.outsiderSessionId,
      email: "outsider@example.test",
      name: "Outsider",
    }),
  };
}

describe("document comment pagination", () => {
  it("loads complete large thread and reply histories through bounded scoped pages", async () => {
    const { backend, seeded, member, outsider } = await commentFixture();
    const scope = {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "large-history.html",
    };
    const { threadIds, replyThreadId } = await backend.run(async (ctx) => {
      const ids = [];
      for (let index = 0; index < 45; index += 1) {
        ids.push(await ctx.db.insert("documentThreads", {
          ...scope,
          authorId: seeded.userId,
          body: `thread-${index}`,
          anchor: { kind: "element", path: ["main", `section:nth-of-type(${index + 1})`] },
          resolved: false,
          archived: false,
          createdAt: seeded.now + index,
          updatedAt: seeded.now + index,
        }));
      }
      const selected = ids[0]!;
      for (let index = 0; index < 55; index += 1) {
        await ctx.db.insert("documentReplies", {
          threadId: selected,
          organizationId: seeded.organizationId,
          authorId: seeded.userId,
          body: `reply-${index}`,
          createdAt: seeded.now + index,
          updatedAt: seeded.now + index,
        });
      }
      return { threadIds: ids, replyThreadId: selected };
    });

    const first = await member.query(api.documentThreads.list, {
      ...scope,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(first.page).toHaveLength(20);
    expect(first.page.map((thread) => thread.body)).toEqual(
      Array.from({ length: 20 }, (_, offset) => `thread-${44 - offset}`),
    );
    await expect(outsider.query(api.documentThreads.list, {
      ...scope,
      paginationOpts: { numItems: 20, cursor: first.continueCursor },
    })).rejects.toThrow("Comment not found");
    const crossDocumentCursor = await member.query(api.documentThreads.list, {
      ...scope,
      documentPath: "another-document.html",
      paginationOpts: { numItems: 20, cursor: first.continueCursor },
    });
    expect(crossDocumentCursor.page).toEqual([]);

    const seenThreads = [...first.page];
    let threadPage = first;
    while (!threadPage.isDone) {
      threadPage = await member.query(api.documentThreads.list, {
        ...scope,
        paginationOpts: { numItems: 20, cursor: threadPage.continueCursor },
      });
      seenThreads.push(...threadPage.page);
    }
    expect(seenThreads).toHaveLength(threadIds.length);
    expect(new Set(seenThreads.map((thread) => thread._id)).size).toBe(threadIds.length);

    const selected = seenThreads.find((thread) => thread._id === replyThreadId);
    expect(selected?.repliesHasMore).toBe(true);
    expect(selected?.replies.map((reply) => reply.body)).toEqual(
      Array.from({ length: 10 }, (_, offset) => `reply-${45 + offset}`),
    );

    const seenReplies = [];
    let replyCursor: string | null = null;
    let repliesDone = false;
    while (!repliesDone) {
      const result: {
        page: Array<{ _id: string; body: string }>;
        continueCursor: string;
        isDone: boolean;
      } = await member.query(api.documentReplies.list, {
        ...scope,
        threadId: replyThreadId,
        paginationOpts: { numItems: 20, cursor: replyCursor },
      });
      seenReplies.push(...result.page);
      replyCursor = result.continueCursor;
      repliesDone = result.isDone;
    }
    expect(seenReplies).toHaveLength(55);
    expect(new Set(seenReplies.map((reply) => reply._id)).size).toBe(55);
    expect(seenReplies.map((reply) => reply.body)).toEqual(
      Array.from({ length: 55 }, (_, offset) => `reply-${54 - offset}`),
    );
  }, 30_000);

  it("keeps a grown reactive page bounded with max-valid multibyte content", async () => {
    const { backend, seeded, member } = await commentFixture(true);
    const scope = {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "multibyte-history.html",
    };
    const maxBody = "界".repeat(10_000);
    const verboseAuthorId = await backend.run(async (ctx) => {
      const verboseAuthor = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "user",
          data: {
            name: "界".repeat(60_000),
            email: `${"e".repeat(5_000)}@example.test`,
            emailVerified: true,
            createdAt: seeded.now,
            updatedAt: seeded.now,
          },
        },
      });
      for (let threadIndex = 0; threadIndex < 21; threadIndex += 1) {
        const threadId = await ctx.db.insert("documentThreads", {
          ...scope,
          authorId: verboseAuthor._id,
          body: threadIndex === 20 ? maxBody : `thread-${threadIndex}`,
          anchor: threadIndex === 20
            ? { kind: "element" as const, path: Array.from({ length: 64 }, () => "界".repeat(256)) }
            : { kind: "element" as const, path: ["main"] },
          resolved: false,
          archived: false,
          createdAt: seeded.now + threadIndex,
          updatedAt: seeded.now + threadIndex,
        });
        for (let replyIndex = 0; replyIndex < 10; replyIndex += 1) {
          await ctx.db.insert("documentReplies", {
            threadId,
            organizationId: seeded.organizationId,
            authorId: verboseAuthor._id,
            body: maxBody,
            createdAt: seeded.now + replyIndex,
            updatedAt: seeded.now + replyIndex,
          });
        }
      }
      return String(verboseAuthor._id);
    });
    const initial = await member.query(api.documentThreads.list, {
      ...scope,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(initial.page).toHaveLength(20);
    expect(initial.isDone).toBe(false);

    await backend.run(async (ctx) => {
      for (let threadIndex = 21; threadIndex < 25; threadIndex += 1) {
        const threadId = await ctx.db.insert("documentThreads", {
          ...scope,
          authorId: verboseAuthorId,
          body: `thread-${threadIndex}`,
          anchor: { kind: "element", path: ["main"] },
          resolved: false,
          archived: false,
          createdAt: seeded.now + threadIndex,
          updatedAt: seeded.now + threadIndex,
        });
        for (let replyIndex = 0; replyIndex < 10; replyIndex += 1) {
          await ctx.db.insert("documentReplies", {
            threadId,
            organizationId: seeded.organizationId,
            authorId: verboseAuthorId,
            body: maxBody,
            createdAt: seeded.now + replyIndex,
            updatedAt: seeded.now + replyIndex,
          });
        }
      }
    });
    const grownPage = await member.query(api.documentThreads.list, {
      ...scope,
      paginationOpts: {
        numItems: 20,
        cursor: null,
        endCursor: initial.continueCursor,
      },
    });
    expect(grownPage.page).toHaveLength(24);
    expect(grownPage.page.every((thread) => thread.authorName.length <= 200)).toBe(true);
    expect(grownPage.page.every((thread) => thread.authorEmail.length <= 320)).toBe(true);
    expect(grownPage.page.every((thread) => thread.replies.every((reply) => (
      reply.authorName.length <= 200 && reply.authorEmail.length <= 320
    )))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(grownPage), "utf8")).toBeLessThan(12 * 1024 * 1024);
  }, 30_000);

  it("tombstones immediately and scrubs a large reply history in bounded cleanup jobs", async () => {
    const { backend, seeded, member } = await commentFixture(true);
    const scope = {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "cleanup.html",
    };
    const threadId = await backend.run(async (ctx) => {
      const id = await ctx.db.insert("documentThreads", {
        ...scope,
        authorId: seeded.userId,
        body: "Delete this thread",
        anchor: { kind: "element", path: ["main"] },
        resolved: false,
        archived: false,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      });
      for (let index = 0; index < 251; index += 1) {
        await ctx.db.insert("documentReplies", {
          threadId: id,
          organizationId: seeded.organizationId,
          authorId: seeded.userId,
          body: `reply-${index}`,
          createdAt: seeded.now + index,
          updatedAt: seeded.now + index,
        });
      }
      return id;
    });

    vi.useFakeTimers();
    try {
      await member.mutation(api.documentThreads.remove, { ...scope, threadId });
      const hidden = await member.query(api.documentThreads.list, {
        ...scope,
        paginationOpts: { numItems: 20, cursor: null },
      });
      expect(hidden.page).toEqual([]);
      await expect(member.mutation(api.documentReplies.add, {
        ...scope,
        threadId,
        body: "Too late",
      })).rejects.toThrow("Comment not found");

      await backend.mutation(internal.documentThreads.cleanupDeletedThread, { threadId });
      const afterOneBatch = await backend.run(async (ctx) => ({
        thread: await ctx.db.get(threadId),
        replies: await ctx.db
          .query("documentReplies")
          .withIndex("by_thread", (index) => index.eq("threadId", threadId))
          .collect(),
      }));
      expect(afterOneBatch.thread?.deletedAt).toEqual(expect.any(Number));
      expect(afterOneBatch.replies.filter(reply => reply.deletedAt === undefined)).toHaveLength(151);
      expect(afterOneBatch.replies.filter(reply => reply.deletedAt !== undefined).every(reply => reply.body === "")).toBe(true);

      await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
      expect(await backend.run((ctx) => ctx.db.get(threadId))).toMatchObject({ deletedAt: expect.any(Number), body: "", anchor: { kind: "element", path: [] } });
      const retained = await backend.run((ctx) => ctx.db
        .query("documentReplies")
        .withIndex("by_thread", (index) => index.eq("threadId", threadId))
        .collect());
      expect(retained).toHaveLength(251);
      expect(retained.every(reply => reply.deletedAt !== undefined && reply.body === "")).toBe(true);
      expect(await backend.run((ctx) => ctx.db
        .query("documentReplies")
        .withIndex("by_active_thread", (index) => index.eq("threadId", threadId).eq("deletedAt", undefined))
        .collect())).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized anchor payloads while preserving valid cross-node offsets", async () => {
    const { seeded, member } = await commentFixture();
    const scope = {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "anchors.html",
    };
    const create = (anchor:
      | { kind: "element"; path: string[] }
      | { kind: "text-range"; quote: string; path: string[]; startOffset: number; endOffset: number },
    ) => member.mutation(api.documentThreads.create, { ...scope, body: "Anchor", anchor });

    await expect(create({
      kind: "text-range",
      quote: "selection across nodes",
      path: ["main"],
      startOffset: 8,
      endOffset: 2,
    })).resolves.toBeTruthy();
    await expect(create({
      kind: "element",
      path: Array.from({ length: 64 }, () => "界".repeat(256)),
    })).resolves.toBeTruthy();
    await expect(create({ kind: "element", path: Array.from({ length: 65 }, () => "div") }))
      .rejects.toThrow("Comment anchor is invalid");
    await expect(create({ kind: "element", path: ["x".repeat(257)] }))
      .rejects.toThrow("Comment anchor is invalid");
    await expect(create({
      kind: "text-range",
      quote: "x".repeat(4_097),
      path: ["main"],
      startOffset: 0,
      endOffset: 1,
    })).rejects.toThrow("Comment anchor is invalid");
    await expect(create({
      kind: "text-range",
      quote: "selection",
      path: ["main"],
      startOffset: -1,
      endOffset: 1,
    })).rejects.toThrow("Comment anchor is invalid");
  });
});
