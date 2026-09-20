import { describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, components, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";
import { authComponent } from "../convex/auth";
import { draftAfterSuccessfulReply } from "../src/commentor/reply-state";
import { injectMobileViewportScrollbarStream } from "../src/routes/document-html";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("../convex/**/*.ts");

async function commentMember() {
  const backend = convexTest(schema, modules);
  backend.registerComponent(
    "betterAuth",
    betterAuthSchema,
    import.meta.glob("../convex/betterAuth/**/*.ts"),
  );
  const now = Date.now();
  const seeded = await backend.run(async (ctx) => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: { name: "Functional QA", email: "qa@example.test", emailVerified: true, createdAt: now, updatedAt: now } },
    });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: { token: "functional-session", userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 60_000 } },
    });
    const organization = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "organization", data: { name: "Functional org", slug: "functional-org", createdAt: now } },
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
    return { userId: user._id, sessionId: session._id, organizationId: organization._id, projectId };
  });
  return {
    backend,
    seeded,
    member: backend.withIdentity({ subject: seeded.userId, sessionId: seeded.sessionId, email: "qa@example.test", name: "Functional QA" }),
  };
}

describe("document workflows", () => {
  it("preserves replies through status changes and deletes the complete thread atomically", async () => {
    const { backend, seeded, member } = await commentMember();
    const threadId = await member.mutation(api.documentThreads.create, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "guide/index.html",
      body: "Review this section",
      anchor: { kind: "element", path: ["main", "section:nth-of-type(1)"] },
    });
    await member.mutation(api.documentReplies.add, { threadId, body: "  First reply  " });
    await member.mutation(api.documentReplies.add, { threadId, body: "Second reply" });
    await member.mutation(api.documentThreads.resolve, { threadId });
    await member.mutation(api.documentThreads.archive, { threadId });

    const listed = await member.query(api.documentThreads.list, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "guide/index.html",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ resolved: true, archived: true });
    expect(listed[0]?.replies.map((reply) => reply.body)).toEqual(["First reply", "Second reply"]);

    await member.mutation(api.documentThreads.remove, { threadId });
    expect(await member.query(api.documentThreads.list, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "guide/index.html",
    })).toEqual([]);
    await expect(member.mutation(api.documentReplies.add, { threadId, body: "Late reply" }))
      .rejects.toThrow("Comment not found");
    const orphanReplies = await backend.run((ctx) => ctx.db.query("documentReplies").collect());
    expect(orphanReplies).toEqual([]);
  });

  it("keeps a newer local reply draft when a realtime confirmation arrives", () => {
    expect(draftAfterSuccessfulReply("Edited while sending", "Original submission"))
      .toBe("Edited while sending");
    expect(draftAfterSuccessfulReply("Original submission", "Original submission"))
      .toBeUndefined();
  });

  it("deduplicates one author lookup across a thread and multiple replies", async () => {
    const { seeded, member } = await commentMember();
    const threadId = await member.mutation(api.documentThreads.create, {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      documentPath: "reference.html",
      body: "Question",
      anchor: { kind: "element", path: ["article"] },
    });
    await member.mutation(api.documentReplies.add, { threadId, body: "One" });
    await member.mutation(api.documentReplies.add, { threadId, body: "Two" });
    const lookup = vi.spyOn(authComponent, "getAnyUserById");
    try {
      await member.query(api.documentThreads.list, {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        documentPath: "reference.html",
      });
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
    }
  });
});

describe("deployment workflow", () => {
  it("supersedes the previous active release while retaining immutable deployment records", async () => {
    const backend = convexTest(schema, modules);
    const project = await backend.mutation(internal.projects.createInternal, {
      organizationId: "org-functional",
      name: "Docs",
      slug: "docs",
      actorId: "qa",
    });
    if (!project) throw new Error("Project setup failed");
    const provenance = {
      source: { kind: "git" as const, repository: "https://example.test/docs", commit: "abc", ref: "main" },
      execution: { kind: "ci" as const, provider: "test", runId: "functional" },
      cliVersion: "test",
      manifestSha256: "first",
    };
    const first = await backend.mutation(internal.deployments.startInternal, {
      organizationId: "org-functional", projectId: project._id, manifestSha256: "first", fileCount: 1, byteCount: 10, provenance, actorId: "qa",
    });
    await backend.mutation(internal.deployments.commitInternal, {
      organizationId: "org-functional", projectId: project._id, deploymentId: first.deploymentId, actorId: "qa",
    });
    const second = await backend.mutation(internal.deployments.startInternal, {
      organizationId: "org-functional", projectId: project._id, manifestSha256: "second", fileCount: 2, byteCount: 20,
      provenance: { ...provenance, manifestSha256: "second" }, actorId: "qa",
    });
    await backend.mutation(internal.deployments.commitInternal, {
      organizationId: "org-functional", projectId: project._id, deploymentId: second.deploymentId, actorId: "qa",
    });
    const deployments = await backend.query(internal.deployments.listInternal, {
      organizationId: "org-functional", projectId: project._id,
    });
    expect(deployments.map((deployment) => [deployment.manifestSha256, deployment.status]))
      .toEqual([["second", "active"], ["first", "superseded"]]);
    expect(deployments[0]?.previousDeploymentId).toBe(first.deploymentId);
  });
});

describe("shared document delivery", () => {
  it("propagates a failed upstream HTML stream instead of returning a truncated successful document", async () => {
    const failure = new Error("storage stream interrupted");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<!doctype html><head></head><body>Partial"));
        controller.error(failure);
      },
    });
    const response = new Response(injectMobileViewportScrollbarStream(source));
    await expect(response.text()).rejects.toThrow("storage stream interrupted");
  });
});
