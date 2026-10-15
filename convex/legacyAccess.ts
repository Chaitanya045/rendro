import { v } from "convex/values";
import { query } from "./publicFunctions";
import { createAuth } from "./auth";
import { requireOrganizationMember } from "./authorization";
import { isOrganizationDeleted } from "./organizationLifecycle";
import { publicError } from "./publicErrors";
import { requireInternalSecret } from "./security";
import type { QueryCtx, MutationCtx } from "./_generated/server";

// Operator-only Convex environment setting. No domain fallback or self-service claim.
export function mappedOrganization(orgSlug: string): string | null {
  const mapping: unknown = JSON.parse(process.env.LEGACY_ORGANIZATION_MAP ?? "{}");
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)
    || Object.entries(mapping).some(([slug, id]) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      || typeof id !== "string" || !id.trim() || id !== id.trim())) throw new Error("Invalid legacy mapping configuration");
  return Object.hasOwn(mapping, orgSlug) ? (mapping as Record<string, string>)[orgSlug] : null;
}

export async function requireLegacyMember(ctx: QueryCtx | MutationCtx, orgSlug: string) {
  const organizationId = mappedOrganization(orgSlug);
  if (!organizationId) publicError("not_found");
  return requireOrganizationMember(ctx, organizationId);
}

export const resolve = query({
  args: { orgSlug: v.string(), internalSecret: v.string() },
  handler: async (ctx, { orgSlug, internalSecret }) => {
    requireInternalSecret(internalSecret);
    const organizationId = mappedOrganization(orgSlug);
    if (!organizationId || await isOrganizationDeleted(ctx, organizationId)) return null;
    const auth = await createAuth(ctx).$context;
    const organization = await auth.adapter.findOne({ model: "organization", where: [{ field: "id", value: organizationId }] });
    return organization ? organizationId : null;
  },
});
