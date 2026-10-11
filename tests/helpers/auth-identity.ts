import type { TestConvex } from "convex-test";
import { components } from "../../convex/_generated/api";
import type schema from "../../convex/schema";
import authSchema from "../../convex/betterAuth/schema";

export function registerAuth(backend: TestConvex<typeof schema>) {
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../../convex/betterAuth/**/*.ts"));
}

/** Real persisted sessions for legacy authorization tests, not JWT-only identities. */
export async function seedIdentity(backend: TestConvex<typeof schema>, input: { email: string; name?: string }) {
  const now = Date.now();
  return backend.run(async ctx => {
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "user", data: { name: input.name ?? input.email, email: input.email, emailVerified: true, createdAt: now, updatedAt: now },
    } });
    const session = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "session", data: { token: crypto.randomUUID(), userId: user._id, createdAt: now, updatedAt: now, expiresAt: now + 60 * 60_000 },
    } });
    return { email: input.email, name: input.name ?? input.email, subject: user._id as string, sessionId: session._id as string };
  });
}
