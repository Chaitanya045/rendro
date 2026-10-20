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
  await backend.mutation(internal.apiKeyCredentials.createInternal, {
    organizationId, keyId: "key", keyPrefix: "test", name: "test", secretHash: await sha256("valid-key"), actorId: user._id,
    scopes: ["docs:read", "docs:write", "publications:read", "publications:write"],
  });
  const bodies: Record<string, object> = {
    "/api/rendro/projects": { organizationId, name: "New", slug: "new" },
    "/api/rendro/credentials": { organizationId, name: "New", scopes: ["docs:read"] },
    "/api/rendro/credentials/revoke": { organizationId, keyId: "key" },
    "/api/auth/set-initial-password": { newPassword: "local-test-initial-password" },
  };
  const post = (path: string, overrides: Record<string, string> = {}) => backend.fetch(path, {
    method: "POST", headers: admissionHeaders({ cookie, ...overrides }), body: JSON.stringify(bodies[path]),
  });
  return { backend, post, bodies, session, user, cookie, organizationId, projectId };
}
