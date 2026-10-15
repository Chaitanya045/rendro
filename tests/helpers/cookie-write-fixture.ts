import { STORAGE_ATTESTATION_HEADER } from "../../shared/storage-attestation";
import { commitWithProof, publishWithProof, publicationProof } from "./storage-proof";
import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { components, internal } from "../../convex/_generated/api";
import { registerAuth } from "./auth-identity";
import rateLimiterTest from "../convex-rate-limiter";
import { sha256 } from "../../convex/credentialHash";

export function admissionHeaders(overrides: Record<string, string> = {}) {
  const result = new Headers({ origin: process.env.SITE_URL!, "content-type": "application/json", ...overrides });
  for (const [name, value] of Object.entries(overrides)) if (!value) result.delete(name);
  return result;
}

export async function cookieWriteFixture() {
  const backend = convexTest(schema, import.meta.glob("../../convex/**/*.ts"));
  registerAuth(backend);
  rateLimiterTest.register(backend);
  const now = Date.now();
  const user = await backend.mutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
    name: "Owner", email: "owner@example.test", emailVerified: true, createdAt: now, updatedAt: now,
  } } });
  const session = await backend.mutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
    token: "admission-test-session", userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 7 * 86400_000,
  } } });
  const signed = `${session.token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(String(session.token)).digest("base64")}`;
  const cookie = `better-auth.session_token=${encodeURIComponent(signed)}`;
  const org = await backend.mutation(components.betterAuth.adapter.create, { input: { model: "organization", data: { name: "Org", slug: "org", createdAt: now } } });
  await backend.mutation(components.betterAuth.adapter.create, { input: { model: "member", data: { organizationId: org._id, userId: user._id, role: "owner", createdAt: now } } });
  const organizationId = org._id;
  const project = await backend.mutation(internal.projects.createInternal, { organizationId, name: "Docs", slug: "docs", actorId: user._id });
  const projectId = project!._id;
  const deployment = await backend.mutation(internal.deployments.startInternal, {
    organizationId, projectId, manifestSha256: "a".repeat(64), fileCount: 1, byteCount: 1, actorId: user._id,
    provenance: { source: { kind: "local" }, execution: { kind: "local" }, cliVersion: "test", manifestSha256: "a".repeat(64) },
  });
  await commitWithProof(backend, { organizationId, projectId, deploymentId: deployment.deploymentId, actorId: user._id });
  await backend.mutation(internal.apiKeyCredentials.createInternal, {
    organizationId, keyId: "key", keyPrefix: "test", name: "test", secretHash: await sha256("valid-key"), actorId: user._id,
    scopes: ["docs:read", "docs:write", "publications:read", "publications:write"],
  });
  const publication = await publishWithProof(backend, {
    organizationId, projectId, slug: "existing", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", actorId: user._id,
  });
  const grant = await backend.mutation(internal.shareGrants.createInternal, {
    organizationId, projectId, documentPath: "index.html", tokenHash: "grant", expiresAt: now + 600_000, actorId: user._id,
  });
  const bodies: Record<string, object> = {
    "/api/rendro/projects": { organizationId, name: "New", slug: "new" },
    "/api/rendro/credentials": { organizationId, name: "New", scopes: ["docs:read"] },
    "/api/rendro/credentials/revoke": { organizationId, keyId: "key" },
    "/api/rendro/shares": { organizationId, projectId, documentPath: "index.html", expiresInSeconds: 600 },
    "/api/rendro/shares/revoke": { organizationId, grantId: grant!._id },
    "/api/rendro/publications": { organizationId, projectId, slug: "new", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" },
    "/api/rendro/publications/remove": { organizationId, projectId, publicationId: publication!._id },
    "/api/auth/set-initial-password": { newPassword: "local-test-initial-password" },
  };
  const proof = await publicationProof(backend, { organizationId, projectId, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" });
  const post = (path: string, overrides: Record<string, string> = {}) => backend.fetch(path, {
    method: "POST", headers: admissionHeaders({ cookie, [STORAGE_ATTESTATION_HEADER]: proof!, ...overrides }), body: JSON.stringify(bodies[path]),
  });
  return { backend, post, bodies, session, user, cookie, organizationId, projectId };
}
