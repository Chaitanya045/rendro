import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";

type AuthCtx = Pick<QueryCtx | MutationCtx, "auth">;

export interface AuthenticatedIdentity {
  subject: string;
  email: string;
  name: string;
}

export async function requireIdentity(ctx: AuthCtx): Promise<AuthenticatedIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.email) throw new ConvexError("Unauthenticated");
  return {
    subject: identity.subject,
    email: identity.email.toLowerCase(),
    name: identity.name?.trim() || identity.email.split("@", 1)[0],
  };
}

export function orgSlugFromEmail(email: string): string | null {
  const atIndex = email.indexOf("@");
  if (atIndex < 0) return null;
  const domain = email.slice(atIndex + 1).toLowerCase();
  const dotIndex = domain.lastIndexOf(".");
  if (dotIndex < 0) return null;
  const slug = domain.slice(0, dotIndex);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

export async function requireOrgIdentity(
  ctx: AuthCtx,
  orgSlug: string,
): Promise<AuthenticatedIdentity> {
  const identity = await requireIdentity(ctx);
  if (orgSlugFromEmail(identity.email) !== orgSlug) {
    throw new ConvexError("Forbidden");
  }
  return identity;
}

export function requireInternalSecret(provided: string): void {
  const expected = process.env.CONVEX_INTERNAL_SECRET;
  if (!expected || provided.length !== expected.length) {
    throw new ConvexError("Unauthorized service call");
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (difference !== 0) throw new ConvexError("Unauthorized service call");
}
