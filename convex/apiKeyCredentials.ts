import { consumeWriteQuota } from "./writeQuotas";
import { isOrganizationDeleted, requireActiveOrganization } from "./organizationLifecycle";
import { requireId } from "./ids";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const createInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.optional(v.string()),
    keyId: v.string(),
    keyPrefix: v.string(),
    name: v.string(),
    secretHash: v.string(),
    scopes: v.array(v.string()),
    expiresAt: v.optional(v.number()),
    actorId: v.string(),
  },
  handler: async (ctx, input) => {
    await requireActiveOrganization(ctx, input.organizationId);
    await consumeWriteQuota(ctx, "credentials", input.actorId, input.organizationId);
    const args = {
      ...input,
      projectId: input.projectId === undefined ? undefined : requireId(ctx, "projects", input.projectId),
    };
    const now = Date.now();
    const id = await ctx.db.insert("apiKeyCredentials", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      keyId: args.keyId,
      keyPrefix: args.keyPrefix,
      name: args.name,
      secretHash: args.secretHash,
      scopes: args.scopes,
      expiresAt: args.expiresAt,
      createdBy: args.actorId,
      createdAt: now,
    });
    await ctx.db.insert("auditEvents", {
      organizationId: args.organizationId,
      actorId: args.actorId,
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: args.keyId,
      metadata: { name: args.name, scopes: args.scopes, projectId: args.projectId },
      createdAt: now,
    });
    return id;
  },
});

export const listInternal = internalQuery({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => {
    await requireActiveOrganization(ctx, args.organizationId);
    const rows = await ctx.db
      .query("apiKeyCredentials")
      .withIndex("by_organization", (query) => query.eq("organizationId", args.organizationId))
      .order("desc")
      .collect();
    return rows.map(({ secretHash: _secretHash, ...credential }) => credential);
  },
});

export const revokeInternal = internalMutation({
  args: {
    organizationId: v.string(),
    keyId: v.string(),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveOrganization(ctx, args.organizationId);
    const credential = await ctx.db
      .query("apiKeyCredentials")
      .withIndex("by_key_id", (query) => query.eq("keyId", args.keyId))
      .unique();
    if (!credential || credential.organizationId !== args.organizationId) {
      throw new ConvexError("API key not found");
    }
    if (!credential.revokedAt) {
      await ctx.db.patch(credential._id, { revokedAt: Date.now() });
      await ctx.db.insert("auditEvents", {
        organizationId: args.organizationId,
        actorId: args.actorId,
        action: "api_key.revoked",
        resourceType: "api_key",
        resourceId: args.keyId,
        createdAt: Date.now(),
      });
    }
    return true;
  },
});

// Last-use telemetry is debounced: at most one credential write per window.
export const API_KEY_USAGE_DEBOUNCE_MS = 60_000;

export const usageDue = (lastUsedAt: number | undefined, now: number) =>
  lastUsedAt === undefined || now - lastUsedAt >= API_KEY_USAGE_DEBOUNCE_MS;

// Authorization is a read-only query so parallel requests with one key do not
// contend on its row. Convex caches query results until their read set changes,
// so this must stay a pure function of its arguments and the documents it reads:
// it never reads the clock. Time-based decisions (expiry, telemetry due) are made
// by the caller (`validateApiCredential`) from the stored timestamps returned here.
export const validateInternal = internalQuery({
  args: {
    secretHash: v.string(),
    organizationId: v.string(),
    projectId: v.optional(v.string()),
    requiredScope: v.string(),
  },
  handler: async (ctx, args) => {
    if (await isOrganizationDeleted(ctx, args.organizationId)) return null;
    // HTTP callers supply untrusted strings. Reject malformed IDs as invalid
    // credentials rather than throwing before the authorization handler runs.
    const projectId = args.projectId === undefined
      ? undefined
      : ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null) return null;
    const credential = await ctx.db
      .query("apiKeyCredentials")
      .withIndex("by_secret_hash", (query) => query.eq("secretHash", args.secretHash))
      .unique();
    if (
      !credential
      || credential.organizationId !== args.organizationId
      || credential.revokedAt !== undefined
      || !credential.scopes.includes(args.requiredScope)
      || (credential.projectId !== undefined && credential.projectId !== projectId)
    ) {
      return null;
    }
    return {
      principal: {
        keyId: credential.keyId,
        organizationId: credential.organizationId,
        projectId: credential.projectId,
        scopes: credential.scopes,
      },
      credentialId: credential._id,
      expiresAt: credential.expiresAt,
      lastUsedAt: credential.lastUsedAt,
    };
  },
});

// Re-checks the window inside the transaction, so requests that raced past a
// stale read write once and the rest commit without touching the credential.
export const recordUsageInternal = internalMutation({
  args: { credentialId: v.id("apiKeyCredentials") },
  handler: async (ctx, { credentialId }) => {
    const credential = await ctx.db.get(credentialId);
    const now = Date.now();
    if (!credential || !usageDue(credential.lastUsedAt, now)) return false;
    await ctx.db.patch(credential._id, { lastUsedAt: now });
    return true;
  },
});

// Verify identity independently of requested tenant/scope, so changing those
// fields cannot obtain fresh rate-limit buckets. Never return the stored hash.
export const verifiedIdInternal = internalQuery({
  args: { secretHash: v.string() },
  handler: async (ctx, { secretHash }) => {
    const credential = await ctx.db.query("apiKeyCredentials")
      .withIndex("by_secret_hash", q => q.eq("secretHash", secretHash)).unique();
    if (!credential || credential.revokedAt !== undefined
      || (credential.expiresAt !== undefined && credential.expiresAt <= Date.now())) return null;
    if (await isOrganizationDeleted(ctx, credential.organizationId)) return null;
    return credential._id;
  },
});
