import rateLimiterTest from "./convex-rate-limiter";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../convex/betterAuth/schema";
import { sha256 } from "../convex/credentialHttp";

const modules = import.meta.glob("../convex/**/*.ts");

async function fixture(projectScoped = false) {
  const backend = convexTest(schema, modules);
  rateLimiterTest.register(backend);
  backend.registerComponent(
    "betterAuth", betterAuthSchema, import.meta.glob("../convex/betterAuth/**/*.ts"),
  );
  const project = await backend.mutation(internal.projects.createInternal, {
    organizationId: "org-test", name: "Test", slug: "test", actorId: "owner",
  });
  if (!project) throw new Error("Project creation failed");
  const key = "test-only-credential";
  const secretHash = await sha256(key);
  const credentialId = await backend.mutation(internal.apiKeyCredentials.createInternal, {
    organizationId: "org-test", projectId: projectScoped ? project._id : undefined,
    keyId: "test-key", keyPrefix: "test", name: "Test", secretHash,
    scopes: ["docs:read"], actorId: "owner",
  });
  const validate = (projectId?: string, organizationId = "org-test", requiredScope = "docs:read") =>
    backend.query(internal.apiKeyCredentials.validateInternal, {
      organizationId, projectId, secretHash, requiredScope,
    }).then(result => result && result.principal);
  return { backend, project, key, credentialId, validate };
}

describe("untrusted credential project IDs", () => {
  it.each([false, true])("rejects malformed and wrong-table IDs without recording key use (project scoped: %s)", async (scoped) => {
    const { backend, validate, credentialId } = await fixture(scoped);
    for (const projectId of ["release-smoke", "", " ", credentialId]) {
      expect(await validate(projectId)).toBeNull();
    }
    const retained = await backend.run((ctx) => ctx.db.get(credentialId));
    expect(retained).not.toBeNull();
    expect(retained?.lastUsedAt).toBeUndefined();
  });

  it("preserves valid organization-wide validation with and without a project", async () => {
    const { backend, project, credentialId, validate } = await fixture();
    expect(await validate()).toMatchObject({ keyId: "test-key", organizationId: "org-test" });
    expect(await validate(project._id)).toMatchObject({ keyId: "test-key" });
    // Validation is read-only; usage is recorded separately by the HTTP caller.
    expect((await backend.run((ctx) => ctx.db.get(credentialId)))?.lastUsedAt).toBeUndefined();
  });

  it("preserves project, organization, scope, and revocation boundaries", async () => {
    const { backend, project, validate } = await fixture(true);
    const sibling = await backend.mutation(internal.projects.createInternal, {
      organizationId: "org-test", name: "Other", slug: "other", actorId: "owner",
    });
    if (!sibling) throw new Error("Project creation failed");
    expect(await validate(project._id)).toMatchObject({ projectId: project._id });
    expect(await validate()).toBeNull();
    expect(await validate(sibling._id)).toBeNull();
    expect(await validate(project._id, "org-other")).toBeNull();
    expect(await validate(project._id, "org-test", "docs:write")).toBeNull();
    await backend.mutation(internal.apiKeyCredentials.revokeInternal, {
      organizationId: "org-test", keyId: "test-key", actorId: "owner",
    });
    expect(await validate(project._id)).toBeNull();
  });

  it("still authorizes valid project-scoped credentials through HTTP", async () => {
    const { backend, project, key } = await fixture(true);
    const query = new URLSearchParams({ organizationId: "org-test", projectId: project._id, scope: "docs:read" });
    const headers = { authorization: `Bearer ${key}` };
    const validated = await backend.fetch(`/api/rendro/credentials/validate?${query}`, { headers });
    expect(validated.status).toBe(200);
    const active = await backend.fetch(`/api/rendro/deployments/active?${query}`, { headers });
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({
      project: { _id: project._id }, deployment: null, principal: { kind: "api-key", keyId: "test-key" },
    });
  });

  it.each(["invalid-key", "test-only-credential"])("returns controlled HTTP rejection for malformed IDs with %s", async (key) => {
    const { backend, credentialId } = await fixture();
    for (const projectId of ["release-smoke", credentialId]) {
      const query = new URLSearchParams({ organizationId: "org-test", projectId, scope: "docs:read" });
      const headers = { authorization: `Bearer ${key}` };
      const response = await backend.fetch(`/api/rendro/credentials/validate?${query}`, { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Invalid or insufficient API key" });
      const deployment = await backend.fetch(`/api/rendro/deployments/active?${query}`, { headers });
      expect(deployment.status).toBe(403);
    }
    const retained = await backend.run((ctx) => ctx.db.get(credentialId));
    expect(retained).not.toBeNull();
    expect(retained?.lastUsedAt).toBeUndefined();
  });
});
