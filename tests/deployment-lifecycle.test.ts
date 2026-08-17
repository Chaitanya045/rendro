import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("../convex/**/*.ts");
const provenance = {
  source: { kind: "git" as const, repository: "https://example.test/repo", commit: "abc123", ref: "main" },
  execution: { kind: "ci" as const, provider: "github-actions", runId: "1" },
  cliVersion: "test",
  manifestSha256: "manifest",
};

async function project(backend: ReturnType<typeof convexTest>, organizationId = "org-a") {
  const result = await backend.mutation(internal.projects.createInternal, {
    organizationId,
    name: "Documentation",
    slug: "documentation",
    actorId: "user-a",
  });
  if (!result) throw new Error("Project creation failed");
  return result;
}

async function stage(
  backend: ReturnType<typeof convexTest>,
  projectId: Awaited<ReturnType<typeof project>>["_id"],
  organizationId = "org-a",
  manifestSha256 = "manifest",
) {
  return backend.mutation(internal.deployments.startInternal, {
    organizationId,
    projectId,
    manifestSha256,
    fileCount: 2,
    byteCount: 100,
    provenance: { ...provenance, manifestSha256 },
    actorId: "api-key:key-a",
  });
}

describe("immutable deployment lifecycle", () => {
  it("rejects a project ID paired with another organization ID", async () => {
    const backend = convexTest(schema, modules);
    const owned = await project(backend);
    await expect(stage(backend, owned._id, "org-b")).rejects.toThrow("Project not found");
  });

  it("keeps the active deployment unchanged when a later upload fails", async () => {
    const backend = convexTest(schema, modules);
    const owned = await project(backend);
    const first = await stage(backend, owned._id, "org-a", "first");
    await backend.mutation(internal.deployments.commitInternal, {
      organizationId: "org-a",
      projectId: owned._id,
      deploymentId: first.deploymentId,
      actorId: "api-key:key-a",
    });
    const interrupted = await stage(backend, owned._id, "org-a", "interrupted");
    await backend.mutation(internal.deployments.failInternal, {
      deploymentId: interrupted.deploymentId,
      reason: "network disconnected",
    });
    const current = await backend.query(internal.projects.getInternal, {
      organizationId: "org-a",
      projectId: owned._id,
    });
    expect(current?.activeDeploymentId).toBe(first.deploymentId);
    const failed = await backend.query(internal.deployments.getInternal, {
      organizationId: "org-a",
      projectId: owned._id,
      deploymentId: interrupted.deploymentId,
    });
    expect(failed?.status).toBe("failed");
  });

  it("rejects a stale concurrent commit instead of overwriting the newer pointer", async () => {
    const backend = convexTest(schema, modules);
    const owned = await project(backend);
    const left = await stage(backend, owned._id, "org-a", "left");
    const right = await stage(backend, owned._id, "org-a", "right");
    await backend.mutation(internal.deployments.commitInternal, {
      organizationId: "org-a",
      projectId: owned._id,
      deploymentId: left.deploymentId,
      actorId: "api-key:key-a",
    });
    await expect(backend.mutation(internal.deployments.commitInternal, {
      organizationId: "org-a",
      projectId: owned._id,
      deploymentId: right.deploymentId,
      actorId: "api-key:key-a",
    })).rejects.toThrow("Active deployment changed");
  });

  it("preserves a superseded deployment while a publication pins it", async () => {
    const backend = convexTest(schema, modules);
    const owned = await project(backend);
    const first = await stage(backend, owned._id, "org-a", "first");
    await backend.mutation(internal.deployments.commitInternal, {
      organizationId: "org-a", projectId: owned._id, deploymentId: first.deploymentId, actorId: "user-a",
    });
    const second = await stage(backend, owned._id, "org-a", "second");
    await backend.mutation(internal.deployments.commitInternal, {
      organizationId: "org-a", projectId: owned._id, deploymentId: second.deploymentId, actorId: "user-a",
    });
    await backend.mutation(internal.publicationsV2.createInternal, {
      organizationId: "org-a",
      projectId: owned._id,
      slug: "stable-docs",
      pathPrefix: "",
      entryFile: "index.html",
      trackingMode: "pinned",
      pinnedDeploymentId: first.deploymentId,
      actorId: "user-a",
    });
    const candidates = await backend.query(internal.retention.candidatesInternal, {
      failedBefore: Date.now() + 1,
      supersededBefore: Date.now() + 1,
      limit: 50,
    });
    expect(candidates.map((candidate) => candidate._id)).not.toContain(first.deploymentId);
  });
});

describe("scoped API credentials", () => {
  it("enforces organization, project, scope, expiry, and revocation", async () => {
    const backend = convexTest(schema, modules);
    const owned = await project(backend);
    await backend.mutation(internal.apiKeyCredentials.createInternal, {
      organizationId: "org-a",
      projectId: owned._id,
      keyId: "key-a",
      keyPrefix: "rnd_live_key-a",
      name: "CI",
      secretHash: "secret-hash",
      scopes: ["docs:write"],
      expiresAt: Date.now() + 60_000,
      actorId: "user-a",
    });
    const valid = await backend.mutation(internal.apiKeyCredentials.validateInternal, {
      secretHash: "secret-hash",
      organizationId: "org-a",
      projectId: owned._id,
      requiredScope: "docs:write",
    });
    expect(valid?.keyId).toBe("key-a");
    expect(await backend.mutation(internal.apiKeyCredentials.validateInternal, {
      secretHash: "secret-hash",
      organizationId: "org-b",
      projectId: owned._id,
      requiredScope: "docs:write",
    })).toBeNull();
    expect(await backend.mutation(internal.apiKeyCredentials.validateInternal, {
      secretHash: "secret-hash",
      organizationId: "org-a",
      projectId: owned._id,
      requiredScope: "publications:write",
    })).toBeNull();
    await backend.mutation(internal.apiKeyCredentials.revokeInternal, {
      organizationId: "org-a",
      keyId: "key-a",
      actorId: "user-a",
    });
    expect(await backend.mutation(internal.apiKeyCredentials.validateInternal, {
      secretHash: "secret-hash",
      organizationId: "org-a",
      projectId: owned._id,
      requiredScope: "docs:write",
    })).toBeNull();
  });

  it("rejects expired credentials", async () => {
    const backend = convexTest(schema, modules);
    const owned = await project(backend);
    await backend.mutation(internal.apiKeyCredentials.createInternal, {
      organizationId: "org-a",
      projectId: owned._id,
      keyId: "expired",
      keyPrefix: "rnd_live_expired",
      name: "Expired CI",
      secretHash: "expired-hash",
      scopes: ["docs:read"],
      expiresAt: Date.now() - 1,
      actorId: "user-a",
    });
    expect(await backend.mutation(internal.apiKeyCredentials.validateInternal, {
      secretHash: "expired-hash",
      organizationId: "org-a",
      projectId: owned._id,
      requiredScope: "docs:read",
    })).toBeNull();
  });
});
