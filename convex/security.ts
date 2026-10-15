import { authComponent } from "./auth";
import { publicError } from "./publicErrors";
import type { QueryCtx, MutationCtx } from "./_generated/server";

type AuthCtx = QueryCtx | MutationCtx;

export interface AuthenticatedIdentity {
  subject: string;
  email: string;
  name: string;
}

export async function requireIdentity(ctx: AuthCtx): Promise<AuthenticatedIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.email || typeof identity.sessionId !== "string") publicError("unauthenticated");
  // Legacy comments must validate the persisted session just like project comments.
  if (!await authComponent.safeGetAuthUser(ctx)) publicError("unauthenticated");
  return {
    subject: identity.subject,
    email: identity.email.toLowerCase(),
    name: identity.name?.trim() || identity.email.split("@", 1)[0],
  };
}

export function requireInternalSecret(provided: string): void {
  const expected = process.env.CONVEX_INTERNAL_SECRET;
  if (!expected || provided.length !== expected.length) {
    publicError("forbidden");
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (difference !== 0) publicError("forbidden");
}
