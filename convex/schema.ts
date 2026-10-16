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
  organizationTombstones: defineTable({
    organizationId: v.string(),
    deletedAt: v.number(),
    deletedBy: v.string(),
  }).index("by_organization", ["organizationId"]),

  admissionBuckets: defineTable({ name: v.string(), key: v.string(), expiresAt: v.number() })
    .index("by_bucket", ["name", "key"])
    .index("by_expiry", ["expiresAt"]),

  failedApiKeyBuckets: defineTable({ key: v.string(), expiresAt: v.number() })
    .index("by_key", ["key"])
    .index("by_expiry", ["expiresAt"]),

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
    // Compatibility with earlier cleanup versions; new writes use deploymentPurges.
    purgedAt: v.optional(v.number()),
    stagingExpiresAt: v.optional(v.number()),
    purgeState: v.optional(v.literal("purging")),
    purgeToken: v.optional(v.string()),
    purgeClaimUntil: v.optional(v.number()),
  })
    .index("by_retention", ["status", "purgedAt", "createdAt"])
    .index("by_staging_expiry", ["status", "purgedAt", "stagingExpiresAt"])
    .index("by_project_created", ["projectId", "createdAt"])
    .index("by_organization_activated", ["organizationId", "activatedAt"])
    .index("by_organization_status", ["organizationId", "status"]),

  deploymentPurges: defineTable({
    deploymentId: v.id("deployments"),
    purgeToken: v.string(),
    claimUntil: v.number(),
    purgedAt: v.optional(v.number()),
  }).index("by_deployment", ["deploymentId"]),

  retentionProgress: defineTable({
    name: v.string(),
    phase: v.number(),
    cursor: v.union(v.string(), v.null()),
    cutoff: v.number(),
  }).index("by_name", ["name"]),

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
    .index("by_pinned_deployment", ["pinnedDeploymentId"])
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
    .index("by_deployment_live", ["deploymentId", "revokedAt", "expiresAt"])
    .index("by_token_hash", ["tokenHash"])
    .index("by_organization", ["organizationId", "createdAt"])
    .index("by_organization_project", ["organizationId", "projectId", "createdAt"]),

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
    clientOperationId: v.optional(v.string()),
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
    deploymentId: v.optional(v.id("deployments")),
    authorId: v.string(),
    body: v.string(),
    anchor: anchorValidator,
    resolved: v.boolean(),
    archived: v.boolean(),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_document", ["organizationId", "projectId", "documentPath", "createdAt"])
    .index("by_operation", ["organizationId", "projectId", "documentPath", "authorId", "clientOperationId"])
    .index("by_active_document", ["organizationId", "projectId", "documentPath", "deletedAt", "createdAt"])
    .index("by_project", ["projectId", "createdAt"]),

  // Short-lived receipts for collaborative status writes; no comment content.
  commentStatusReceipts: defineTable({
    organizationId: v.string(),
    projectId: v.id("projects"),
    documentPath: v.string(),
    threadId: v.id("documentThreads"),
    authorId: v.string(),
    clientOperationId: v.string(),
    field: v.union(v.literal("resolved"), v.literal("archived")),
    target: v.boolean(),
    expiresAt: v.number(),
  })
    .index("by_operation", ["organizationId", "projectId", "documentPath", "threadId", "authorId", "clientOperationId"])
    .index("by_expiry", ["expiresAt"]),

  documentReplies: defineTable({
    clientOperationId: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    threadId: v.id("documentThreads"),
    organizationId: v.string(),
    authorId: v.string(),
    body: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_active_thread", ["threadId", "deletedAt", "createdAt"])
    .index("by_operation", ["organizationId", "threadId", "authorId", "clientOperationId"]),

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

  legacyCommentStatusReceipts: defineTable({
    threadId: v.id("threads"), authorId: v.string(), clientOperationId: v.string(),
    field: v.union(v.literal("resolved"), v.literal("archived")), target: v.boolean(), expiresAt: v.number(),
  }).index("by_operation", ["threadId", "authorId", "clientOperationId"]).index("by_expiry", ["expiresAt"]),

  // Temporary source tables retained until the legacy migration is verified.
  threads: defineTable({
    orgSlug: v.string(),
    filePath: v.string(),
    authorId: v.optional(v.string()),
    clientOperationId: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    authorEmail: v.string(),
    authorName: v.string(),
    body: v.string(),
    anchor: anchorValidator,
    resolved: v.boolean(),
    archived: v.optional(v.boolean()),
  }).index("by_org_file", ["orgSlug", "filePath"])
    .index("by_operation", ["orgSlug", "filePath", "authorId", "clientOperationId"]),
  replies: defineTable({
    threadId: v.id("threads"),
    authorId: v.optional(v.string()),
    clientOperationId: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    authorEmail: v.string(),
    authorName: v.string(),
    body: v.string(),
  }).index("by_thread", ["threadId"])
    .index("by_operation", ["threadId", "authorId", "clientOperationId"]),
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
