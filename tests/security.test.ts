import { describe, expect, it } from "vitest";

import { convexTest } from "convex-test";
import { api, components } from "../convex/_generated/api";
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const acmeIdentity = {
  subject: "user_alice",
  email: "Alice@acme.com",
  name: "Alice Example",
};

function makeBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent(
    "betterAuth",
    betterAuthSchema,
    import.meta.glob("../convex/betterAuth/**/*.ts"),
  );
  return backend;
}

describe("Convex authorization boundary", () => {
  it("rejects anonymous comment reads and writes", async () => {
    const backend = makeBackend();

    await expect(
      backend.query(api.threads.list, {
        orgSlug: "acme",
        filePath: "guide/index.html",
      }),
    ).rejects.toThrow("Unauthenticated");
    await expect(
      backend.mutation(api.threads.create, {
        orgSlug: "acme",
        filePath: "guide/index.html",
        body: "anonymous write",
        anchor: { kind: "element", path: ["main", "p"] },
      }),
    ).rejects.toThrow("Unauthenticated");
  });

  it("rejects an authenticated user from another domain organization", async () => {
    const backend = makeBackend().withIdentity({
      subject: "user_mallory",
      email: "mallory@other.com",
      name: "Mallory",
    });

    await expect(
      backend.mutation(api.threads.create, {
        orgSlug: "acme",
        filePath: "guide/index.html",
        body: "cross-org write",
        anchor: { kind: "element", path: ["main"] },
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("derives thread and reply authors from signed identity claims", async () => {
    const backend = makeBackend().withIdentity(acmeIdentity);
    const threadId = await backend.mutation(api.threads.create, {
      orgSlug: "acme",
      filePath: "guide/index.html",
      body: "Root comment",
      anchor: { kind: "element", path: ["main", "h1"] },
    });
    await backend.mutation(api.replies.add, {
      threadId,
      body: "Reply body",
    });

    const threads = await backend.query(api.threads.list, {
      orgSlug: "acme",
      filePath: "guide/index.html",
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      authorEmail: "alice@acme.com",
      authorName: "Alice Example",
    });
    expect(threads[0].replies[0]).toMatchObject({
      authorEmail: "alice@acme.com",
      authorName: "Alice Example",
    });
  });

  it("prevents cross-organization mutation through an opaque thread id", async () => {
    const backend = makeBackend();
    const acme = backend.withIdentity(acmeIdentity);
    const threadId = await acme.mutation(api.threads.create, {
      orgSlug: "acme",
      filePath: "guide/index.html",
      body: "Protected comment",
      anchor: { kind: "element", path: ["main"] },
    });
    const outsider = backend.withIdentity({
      subject: "user_outsider",
      email: "outsider@other.com",
      name: "Outsider",
    });

    await expect(
      outsider.mutation(api.threads.resolve, { threadId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      outsider.mutation(api.replies.add, { threadId, body: "tampered" }),
    ).rejects.toThrow("Forbidden");
    await expect(
      outsider.mutation(api.threads.remove, { threadId }),
    ).rejects.toThrow("Forbidden");
  });

  it("scopes document comments to an authorized project and document", async () => {
    const backend = makeBackend();
    const now = Date.now();
    const seeded = await backend.run(async (ctx) => {
      const user = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "user",
          data: {
            name: "Project Member",
            email: "member@acme.test",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          },
        },
      });
      const session = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "session",
          data: {
            token: "project-member-session",
            userId: user._id,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + 60_000,
          },
        },
      });
      const organization = await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "organization",
          data: {
            name: "Project Comments",
            slug: "project-comments",
            createdAt: now,
          },
        },
      });
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "member",
          data: {
            organizationId: organization._id,
            userId: user._id,
            role: "member",
            createdAt: now,
          },
        },
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: organization._id,
        name: "Product docs",
        slug: "product-docs",
        createdBy: user._id,
        createdAt: now,
      });
      return {
        userId: user._id,
        sessionId: session._id,
        organizationId: organization._id,
        projectId,
      };
    });
    const member = backend.withIdentity({
      subject: seeded.userId,
      sessionId: seeded.sessionId,
      email: "member@acme.test",
      name: "Project Member",
    });

    const threadId = await member.mutation(api.documentThreads.create, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "guide/index.html",
      body: "Anchor this section",
      anchor: { kind: "element", path: ["main", "h2"] },
    });
    await member.mutation(api.documentReplies.add, {
      threadId,
      body: "Updated in the next deployment",
    });

    const threads = await member.query(api.documentThreads.list, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "guide/index.html",
    });
    const otherDocument = await member.query(api.documentThreads.list, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "guide/other.html",
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      authorId: seeded.userId,
      authorEmail: "member@acme.test",
      body: "Anchor this section",
    });
    expect(threads[0].replies[0]).toMatchObject({
      authorId: seeded.userId,
      body: "Updated in the next deployment",
    });
    expect(otherDocument).toEqual([]);
  });

  it("rejects direct API-key and deleted-file calls without the service secret", async () => {
    const backend = makeBackend();

    await expect(
      backend.mutation(api.apiKeys.create, {
        orgSlug: "acme",
        keyHash: "hash",
        internalSecret: "attacker",
      }),
    ).rejects.toThrow("Unauthorized service call");
    await expect(
      backend.mutation(api.deletedFiles.mark, {
        orgSlug: "acme",
        fileKey: "acme/index.html",
        internalSecret: "attacker",
      }),
    ).rejects.toThrow("Unauthorized service call");
    await expect(
      backend.query(api.apiKeys.validate, {
        keyHash: "hash",
        internalSecret: "attacker",
      }),
    ).rejects.toThrow("Unauthorized service call");
  });
});
