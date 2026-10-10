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

async function createProject(
  backend: ReturnType<typeof convexTest>,
  organizationId: string,
  slug: string,
) {
  const project = await backend.mutation(internal.projects.createInternal, {
    organizationId,
    name: slug,
    slug,
    actorId: "owner",
  });
  if (!project) throw new Error("Project creation failed");
  return project;
}

async function createPublication(
  backend: ReturnType<typeof convexTest>,
  organizationId: string,
  projectId: Awaited<ReturnType<typeof createProject>>["_id"],
  slug: string,
) {
  return backend.mutation(internal.publicationsV2.createInternal, {
    organizationId,
    projectId,
    slug,
    pathPrefix: "",
    entryFile: "index.html",
    trackingMode: "track_active",
    actorId: "owner",
  });
}

describe("publication tenant and project boundaries", () => {
  it("does not publish a pinned deployment before it has committed", async () => {
    const backend = convexTest(schema, modules);
    const project = await createProject(backend, "org-a", "pending");
    const staged = await backend.mutation(internal.deployments.startInternal, {
      organizationId: "org-a",
      projectId: project._id,
      manifestSha256: "pending-manifest",
      fileCount: 1,
      byteCount: 10,
      provenance: {
        source: { kind: "git", repository: "https://example.test/docs", commit: "abc", ref: "main" },
        execution: { kind: "ci", provider: "test", runId: "1" },
        cliVersion: "test",
        manifestSha256: "pending-manifest",
      },
      actorId: "api-key:test",
    });

    await expect(backend.mutation(internal.publicationsV2.createInternal, {
      organizationId: "org-a",
      projectId: project._id,
      slug: "not-yet-public",
      pathPrefix: "",
      entryFile: "index.html",
      trackingMode: "pinned",
      pinnedDeploymentId: staged.deploymentId,
      actorId: "admin",
    })).rejects.toThrow("Pinned deployment not found");
  });

  it("rejects an organization paired with an outsider project's ID when listing", async () => {
    const backend = convexTest(schema, modules);
    const outsiderProject = await createProject(backend, "org-outsider", "outsider-docs");
    await createPublication(backend, "org-outsider", outsiderProject._id, "outsider-publication");

    await expect(backend.query(internal.publicationsV2.listInternal, {
      organizationId: "org-member",
      projectId: outsiderProject._id,
    })).rejects.toThrow("Project not found");
  });

  it("does not let a project-scoped removal target a sibling project's publication", async () => {
    const backend = convexTest(schema, modules);
    const allowedProject = await createProject(backend, "org-a", "allowed");
    const siblingProject = await createProject(backend, "org-a", "sibling");
    const publication = await createPublication(backend, "org-a", siblingProject._id, "sibling-publication");
    if (!publication) throw new Error("Publication creation failed");

    await expect(backend.mutation(internal.publicationsV2.removeInternal, {
      organizationId: "org-a",
      projectId: allowedProject._id,
      publicationId: publication._id,
      actorId: "api-key:allowed-project-key",
    })).rejects.toThrow("Publication not found");

    expect(await backend.query(internal.publicationsV2.resolvePublicInternal, {
      slug: publication.slug,
    })).toBeNull();
    const retained = await backend.query(internal.publicationsV2.listInternal, {
      organizationId: "org-a",
      projectId: siblingProject._id,
    });
    expect(retained.map((candidate) => candidate._id)).toContain(publication._id);
  });

  it("removes a publication only when organization, project, and publication agree", async () => {
    const backend = convexTest(schema, modules);
    const project = await createProject(backend, "org-a", "docs");
    const publication = await createPublication(backend, "org-a", project._id, "public-docs");
    if (!publication) throw new Error("Publication creation failed");

    await expect(backend.mutation(internal.publicationsV2.removeInternal, {
      organizationId: "org-a",
      projectId: project._id,
      publicationId: publication._id,
      actorId: "admin",
    })).resolves.toBe(true);
    expect(await backend.query(internal.publicationsV2.listInternal, {
      organizationId: "org-a",
      projectId: project._id,
    })).toEqual([]);
  });
});
