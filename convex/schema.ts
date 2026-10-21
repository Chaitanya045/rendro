import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Repository doc comments (#254): what the widget quoted, under which heading,
// in which blob. Untrusted client data: readers re-find the text, never trust offsets.
export const repoAnchorValidator = v.object({
  kind: v.literal("repo-text"),
  blobSha: v.string(),
  headingSlug: v.string(),
  prefix: v.string(),
  exact: v.string(),
  suffix: v.string(),
  offset: v.number(),
});
// The roles that may moderate repository comments (#259): GitHub's admin and maintain, as the control Worker's
// permission mirror states them. Write, triage and read are not roles here: they never moderate.
export const moderationRoleValidator = v.union(v.literal("admin"), v.literal("maintain"));
export default defineSchema({
  admissionBuckets: defineTable({ name: v.string(), key: v.string(), expiresAt: v.number() })
    .index("by_bucket", ["name", "key"])
    .index("by_expiry", ["expiresAt"]),

  // Repository doc comments (#254). Access mirrors repository read access: the
  // serving Worker writes a grant after its own authorization (cookie, epoch,
  // permission source); grants are deleted at expiry by a scheduled function, on
  // a revocation epoch from P5, or when the repository is removed. Queries only
  // check that a grant exists, so they never read the clock.
  repoCommentGrants: defineTable({
    repoId: v.number(),
    // null: the repository was public when granted; anyone may read.
    userId: v.union(v.string(), v.null()),
    epoch: v.number(),
    expiresAt: v.number(),
  })
    .index("by_repo_user", ["repoId", "userId"])
    .index("by_user", ["userId"]),

  // A reader's moderation role on a repository (#259): they may archive and delete other readers' comments there. It
  // is recorded by the serving Worker only, from the control Worker's answer, and ends exactly as a read grant does:
  // at its expiry, on the user's revocation epoch, or when the repository is removed. A public repository's readers
  // hold no per-user grant, so this is its own table rather than a field of a read grant.
  repoCommentModerators: defineTable({
    repoId: v.number(),
    userId: v.string(),
    role: moderationRoleValidator,
    epoch: v.number(),
    expiresAt: v.number(),
  })
    .index("by_repo_user", ["repoId", "userId"])
    .index("by_user", ["userId"]),

  repoCommentEpochs: defineTable({ userId: v.string(), epoch: v.number() }).index("by_user", ["userId"]),

  repoCommentRepos: defineTable({
    repoId: v.number(),
    // Set when GitHub reports the repository uninstalled or deleted: comments are hidden at once.
    removedAt: v.optional(v.number()),
    // Set when the control Worker confirmed the removal with GitHub after the retention window (#258): the purge runs.
    purgeConfirmedAt: v.optional(v.number()),
  }).index("by_repo", ["repoId"]),

  repoThreads: defineTable({
    repoId: v.number(),
    path: v.string(),
    blobSha: v.string(),
    anchor: repoAnchorValidator,
    authorId: v.string(),
    body: v.string(),
    resolved: v.boolean(),
    archived: v.boolean(),
    clientOperationId: v.optional(v.string()),
    // The author's last edit (#287): when, and the operation that made it, so the editor's live echo is recognised.
    editedAt: v.optional(v.number()),
    editOperationId: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repo_path", ["repoId", "path", "deletedAt", "createdAt"])
    .index("by_repo_blob", ["repoId", "blobSha"])
    .index("by_operation", ["repoId", "authorId", "clientOperationId"]),

  repoReplies: defineTable({
    repoId: v.number(),
    threadId: v.id("repoThreads"),
    authorId: v.string(),
    body: v.string(),
    clientOperationId: v.optional(v.string()),
    editedAt: v.optional(v.number()),
    editOperationId: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "deletedAt", "createdAt"])
    .index("by_operation", ["threadId", "authorId", "clientOperationId"]),

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
});
