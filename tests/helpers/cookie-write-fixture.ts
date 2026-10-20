import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { components } from "../../convex/_generated/api";
import { registerAuth } from "./auth-identity";
import rateLimiterTest from "../convex-rate-limiter";

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
  // The Convex HTTP write that admits cookie-authenticated JSON (the rest are Better Auth's own).
  const bodies: Record<string, object> = {
    "/api/auth/set-initial-password": { newPassword: "local-test-initial-password" },
  };
  const post = (path: string, overrides: Record<string, string> = {}) => backend.fetch(path, {
    method: "POST", headers: admissionHeaders({ cookie, ...overrides }), body: JSON.stringify(bodies[path]),
  });
  return { backend, post, bodies, session, user, cookie };
}
