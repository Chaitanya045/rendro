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
  source: { kind: "git" as const, repository: "https://example.test/docs", commit: "abc", ref: "main" },
  execution: { kind: "ci" as const, provider: "test", runId: "1" },
  cliVersion: "test",
  manifestSha256: "manifest",
};

async function project(backend: ReturnType<typeof convexTest>, organizationId: string, slug: string) {
  const result = await backend.mutation(internal.projects.createInternal, {
    organizationId,
    name: slug,
    slug,
    actorId: "owner",
  });
  if (!result) throw new Error("Project creation failed");
  return result;
}

async function staging(
  backend: ReturnType<typeof convexTest>,
  organizationId: string,
  projectId: Awaited<ReturnType<typeof project>>["_id"],
) {
  return backend.mutation(internal.deployments.startInternal, {
    organizationId,
    projectId,
    manifestSha256: provenance.manifestSha256,
    fileCount: 1,
    byteCount: 10,
    provenance,
    actorId: "api-key:test",
  });
}

describe("deployment tenant and project boundaries", () => {
  it("rejects a foreign organization paired with a project's ID when listing", async () => {
    const backend = convexTest(schema, modules);
    const outsiderProject = await project(backend, "org-outsider", "outsider");
    await staging(backend, "org-outsider", outsiderProject._id);

    await expect(backend.query(internal.deployments.listInternal, {
      organizationId: "org-member",
      projectId: outsiderProject._id,
    })).rejects.toThrow("Project not found");
  });

  it("does not let one project-scoped credential fail a sibling deployment", async () => {
    const backend = convexTest(schema, modules);
    const allowedProject = await project(backend, "org-a", "allowed");
    const siblingProject = await project(backend, "org-a", "sibling");
    const siblingDeployment = await staging(backend, "org-a", siblingProject._id);

    expect(await backend.mutation(internal.deployments.failInternal, {
      organizationId: "org-a",
      projectId: allowedProject._id,
      deploymentId: siblingDeployment.deploymentId,
      reason: "spoofed failure",
    })).toBe(false);

    const retained = await backend.query(internal.deployments.getInternal, {
      organizationId: "org-a",
      projectId: siblingProject._id,
      deploymentId: siblingDeployment.deploymentId,
    });
    expect(retained?.status).toBe("staging");
  });

  it("fails a staging deployment when all identity fields agree", async () => {
    const backend = convexTest(schema, modules);
    const ownedProject = await project(backend, "org-a", "owned");
    const deployment = await staging(backend, "org-a", ownedProject._id);

    expect(await backend.mutation(internal.deployments.failInternal, {
      organizationId: "org-a",
      projectId: ownedProject._id,
      deploymentId: deployment.deploymentId,
      reason: "upload interrupted",
    })).toBe(true);
  });

  it("does not fail an already committed deployment", async () => {
    const backend = convexTest(schema, modules);
    const ownedProject = await project(backend, "org-a", "committed");
    const deployment = await staging(backend, "org-a", ownedProject._id);
    await backend.mutation(internal.deployments.commitInternal, {
      organizationId: "org-a",
      projectId: ownedProject._id,
      deploymentId: deployment.deploymentId,
      actorId: "api-key:test",
    });

    expect(await backend.mutation(internal.deployments.failInternal, {
      organizationId: "org-a",
      projectId: ownedProject._id,
      deploymentId: deployment.deploymentId,
      reason: "late failure callback",
    })).toBe(false);
    const retained = await backend.query(internal.deployments.getInternal, {
      organizationId: "org-a",
      projectId: ownedProject._id,
      deploymentId: deployment.deploymentId,
    });
    expect(retained?.status).toBe("active");
  });
});
