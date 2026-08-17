import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const anchorValidator = v.union(
  v.object({
    kind: v.literal("text-range"),
    quote: v.string(),
    path: v.array(v.string()),
    startOffset: v.number(),
    endOffset: v.number(),
  }),
  v.object({ kind: v.literal("element"), path: v.array(v.string()) }),
);
export const provenanceValidator = v.object({
  source: v.object({
    kind: v.union(v.literal("local"), v.literal("git")),
    repository: v.optional(v.string()),
    commit: v.optional(v.string()),
    ref: v.optional(v.string()),
    dirty: v.optional(v.boolean()),
    localPathLabel: v.optional(v.string()),
  }),
  execution: v.object({
    kind: v.union(v.literal("local"), v.literal("ci")),
    provider: v.optional(v.string()),
    runId: v.optional(v.string()),
    workflow: v.optional(v.string()),
    job: v.optional(v.string()),
    actor: v.optional(v.string()),
  }),
  cliVersion: v.string(),
  manifestSha256: v.string(),
});

export default defineSchema({
  projects: defineTable({
    organizationId: v.string(),
    name: v.string(),
    slug: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
    activeDeploymentId: v.optional(v.id("deployments")),
  })
    .index("by_organization", ["organizationId", "createdAt"])
    .index("by_organization_slug", ["organizationId", "slug"]),

  deployments: defineTable({
    organizationId: v.string(),
    projectId: v.id("projects"),
    status: v.union(
      v.literal("staging"),
      v.literal("active"),
      v.literal("superseded"),
      v.literal("failed"),
    ),
    manifestKey: v.string(),
    treeIndexKey: v.optional(v.string()),
    manifestSha256: v.string(),
    fileCount: v.number(),
    byteCount: v.number(),
    provenance: provenanceValidator,
    createdBy: v.string(),
    createdAt: v.number(),
    activatedAt: v.optional(v.number()),
    failureReason: v.optional(v.string()),
    previousDeploymentId: v.optional(v.id("deployments")),
    purgedAt: v.optional(v.number()),
  })
    .index("by_project_created", ["projectId", "createdAt"])
    .index("by_organization_status", ["organizationId", "status"]),

  publications: defineTable({
    organizationId: v.string(),
    projectId: v.id("projects"),
    slug: v.string(),
    pathPrefix: v.string(),
    entryFile: v.string(),
    trackingMode: v.union(v.literal("track_active"), v.literal("pinned")),
    pinnedDeploymentId: v.optional(v.id("deployments")),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_organization", ["organizationId", "createdAt"])
    .index("by_project", ["projectId", "createdAt"]),

  shareGrants: defineTable({
    organizationId: v.string(),
    projectId: v.id("projects"),
    deploymentId: v.id("deployments"),
    documentPath: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_organization", ["organizationId", "createdAt"]),

  apiKeyCredentials: defineTable({
    organizationId: v.string(),
    projectId: v.optional(v.id("projects")),
    keyId: v.string(),
    keyPrefix: v.string(),
    name: v.string(),
    secretHash: v.string(),
    scopes: v.array(v.string()),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_secret_hash", ["secretHash"])
    .index("by_organization", ["organizationId", "createdAt"])
    .index("by_key_id", ["keyId"]),

  documentThreads: defineTable({
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
    deploymentId: v.optional(v.id("deployments")),
    authorId: v.string(),
    body: v.string(),
    anchor: anchorValidator,
    resolved: v.boolean(),
    archived: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_document", ["organizationId", "projectId", "documentPath", "createdAt"])
    .index("by_project", ["projectId", "createdAt"]),

  documentReplies: defineTable({
    threadId: v.id("documentThreads"),
    organizationId: v.string(),
    authorId: v.string(),
    body: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_thread", ["threadId", "createdAt"]),

  auditEvents: defineTable({
    organizationId: v.string(),
    actorId: v.string(),
    action: v.string(),
    resourceType: v.string(),
    resourceId: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_organization_created", ["organizationId", "createdAt"])
    .index("by_resource", ["resourceType", "resourceId", "createdAt"]),

  // Temporary source tables retained until the legacy migration is verified.
  threads: defineTable({
    orgSlug: v.string(),
    filePath: v.string(),
    authorEmail: v.string(),
    authorName: v.string(),
    body: v.string(),
    anchor: anchorValidator,
    resolved: v.boolean(),
    archived: v.optional(v.boolean()),
  }).index("by_org_file", ["orgSlug", "filePath"]),
  replies: defineTable({
    threadId: v.id("threads"),
    authorEmail: v.string(),
    authorName: v.string(),
    body: v.string(),
  }).index("by_thread", ["threadId"]),
  api_keys: defineTable({
    orgSlug: v.string(),
    keyHash: v.string(),
    createdAt: v.string(),
  }).index("by_hash", ["keyHash"]),
  deleted_files: defineTable({
    orgSlug: v.string(),
    fileKey: v.string(),
    deletedAt: v.string(),
  }).index("by_key", ["fileKey"]),
});
