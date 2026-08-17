import { describe, expect, it } from "vitest";

import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const acmeIdentity = {
  subject: "user_alice",
  email: "Alice@acme.com",
  name: "Alice Example",
};

function makeBackend() {
  return convexTest(schema, modules);
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
