import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const createInternal = internalMutation({
  args: {
    organizationId: v.string(),
    projectId: v.optional(v.id("projects")),
    keyId: v.string(),
    keyPrefix: v.string(),
    name: v.string(),
    secretHash: v.string(),
    scopes: v.array(v.string()),
    expiresAt: v.optional(v.number()),
    actorId: v.string(),
  },
  handler: async (ctx, args) => {
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

export const validateInternal = internalMutation({
  args: {
    secretHash: v.string(),
    organizationId: v.string(),
    projectId: v.optional(v.id("projects")),
    requiredScope: v.string(),
  },
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("apiKeyCredentials")
      .withIndex("by_secret_hash", (query) => query.eq("secretHash", args.secretHash))
      .unique();
    const now = Date.now();
    if (
      !credential
      || credential.organizationId !== args.organizationId
      || credential.revokedAt !== undefined
      || (credential.expiresAt !== undefined && credential.expiresAt <= now)
      || !credential.scopes.includes(args.requiredScope)
      || (credential.projectId !== undefined && credential.projectId !== args.projectId)
    ) {
      return null;
    }
    await ctx.db.patch(credential._id, { lastUsedAt: now });
    return {
      keyId: credential.keyId,
      organizationId: credential.organizationId,
      projectId: credential.projectId,
      scopes: credential.scopes,
    };
  },
});
