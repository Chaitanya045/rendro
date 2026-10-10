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

describe("private share grants", () => {
  it("lists a project's grants behind more than 200 newer sibling-project grants", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await backend.run(async (ctx) => {
      const organizationId = "org-share-boundary";
      const targetProjectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Target",
        slug: "target",
        createdBy: "user-a",
        createdAt: 1,
      });
      const siblingProjectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Sibling",
        slug: "sibling",
        createdBy: "user-a",
        createdAt: 2,
      });
      const deploymentId = await ctx.db.insert("deployments", {
        organizationId,
        projectId: targetProjectId,
        manifestKey: "manifests/target.json",
        manifestSha256: "target-sha",
        status: "active",
        fileCount: 1,
        byteCount: 1,
        provenance: {
          source: { kind: "local", localPathLabel: "fixture" },
          execution: { kind: "local" },
          cliVersion: "test",
          manifestSha256: "target-sha",
        },
        createdBy: "user-a",
        createdAt: 1,
      });
      const targetGrantId = await ctx.db.insert("shareGrants", {
        organizationId,
        projectId: targetProjectId,
        deploymentId,
        documentPath: "index.html",
        tokenHash: "target-token",
        expiresAt: Date.now() + 60_000,
        createdBy: "user-a",
        createdAt: 1,
      });
      for (let index = 0; index < 201; index += 1) {
        await ctx.db.insert("shareGrants", {
          organizationId,
          projectId: siblingProjectId,
          deploymentId,
          documentPath: `sibling-${index}.html`,
          tokenHash: `sibling-token-${index}`,
          expiresAt: Date.now() + 60_000,
          createdBy: "user-a",
          createdAt: index + 2,
        });
      }
      return { organizationId, targetProjectId, targetGrantId };
    });

    const grants = await backend.query(internal.shareGrants.listInternal, {
      organizationId: seeded.organizationId,
      projectId: seeded.targetProjectId,
    });

    expect(grants.map((grant) => grant._id)).toEqual([seeded.targetGrantId]);
    expect(await backend.query(internal.shareGrants.listInternal, {
      organizationId: "different-organization",
      projectId: seeded.targetProjectId,
    })).toEqual([]);
  });
});
