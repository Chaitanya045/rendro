import rateLimiterTest from "./convex-rate-limiter";
import { commitWithProof } from "./helpers/storage-proof";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const input = { organizationId: "org", name: "Legacy docs", slug: "legacy-old-org", legacyOrgSlug: "old-org", manifestSha256: "a".repeat(64) };

beforeEach(() => { vi.stubEnv("MIGRATION_SECRET", "migration-secret"); });
afterEach(() => { vi.unstubAllEnvs(); });

function request(backend: ReturnType<typeof convexTest>, body: object, secret = "migration-secret") {
  return backend.fetch("/api/rendro/migration/project", {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function fixture() {
  const backend = convexTest(schema, modules);
  rateLimiterTest.register(backend);
  const first = await request(backend, input);
  expect(first.status).toBe(201);
  const project = await backend.query(internal.projects.listInternal, { organizationId: "org" }).then(rows => rows[0]);
  const staged = await backend.mutation(internal.deployments.startInternal, {
    organizationId: "org", projectId: project._id, manifestSha256: input.manifestSha256,
    fileCount: 1, byteCount: 10, actorId: "api-key:migration",
    provenance: {
      source: { kind: "local", localPathLabel: "legacy:old-org" },
      execution: { kind: "local", actor: "migration" }, cliVersion: "migration-1", manifestSha256: input.manifestSha256,
    },
  });
  await commitWithProof(backend, {
    organizationId: "org", projectId: project._id, deploymentId: staged.deploymentId, actorId: "api-key:migration",
  });
  return { backend, project, staged };
}

describe("migration project reuse", () => {
  it.each([false, true])("accepts an identical committed migration (explicit project: %s)", async (explicit) => {
    const { backend, project, staged } = await fixture();
    const response = await request(backend, { ...input, ...(explicit ? { projectId: project._id } : {}) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: false, project: { _id: project._id, activeDeploymentId: staged.deploymentId } });
    expect(await backend.query(internal.projects.listInternal, { organizationId: "org" })).toHaveLength(1);
  });

  it.each([
    { manifestSha256: "b".repeat(64) },
    { legacyOrgSlug: "another-org" },
    { manifestSha256: undefined },
  ])("refuses changed or unspecified migration identity: %j", async (change) => {
    const { backend } = await fixture();
    const response = await request(backend, { ...input, ...change });
    expect(response.status).toBe(409);
  });

  it("refuses a normal deployment even when the content matches", async () => {
    const { backend, project, staged } = await fixture();
    await backend.run(async ctx => {
      const deployment = await ctx.db.get(staged.deploymentId);
      await ctx.db.patch(staged.deploymentId, { provenance: { ...deployment!.provenance, cliVersion: "2.0.0" } });
    });
    const response = await request(backend, { ...input, projectId: project._id });
    expect(response.status).toBe(409);
  });

  it("keeps the secret and tenant boundaries", async () => {
    const { backend, project } = await fixture();
    expect((await request(backend, input, "incorrect")).status).toBe(401);
    expect((await request(backend, { ...input, organizationId: "foreign", projectId: project._id })).status).toBe(404);
  });
});
