import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const anchorValidator = v.union(
  v.object({ kind: v.literal("text-range"), quote: v.string(), path: v.array(v.string()), startOffset: v.number(), endOffset: v.number() }),
  v.object({ kind: v.literal("element"), path: v.array(v.string()) })
);

export default defineSchema({
  threads: defineTable({
    orgSlug: v.string(), filePath: v.string(), authorEmail: v.string(), authorName: v.string(),
    body: v.string(), anchor: anchorValidator, resolved: v.boolean(), archived: v.optional(v.boolean()),
  }).index("by_org_file", ["orgSlug", "filePath"]),
  
  replies: defineTable({
    threadId: v.id("threads"), authorEmail: v.string(), authorName: v.string(), body: v.string(),
  }).index("by_thread", ["threadId"]),
  
  api_keys: defineTable({
    orgSlug: v.string(), keyHash: v.string(), createdAt: v.string(),
  }).index("by_hash", ["keyHash"]),
  
  deleted_files: defineTable({
    orgSlug: v.string(), fileKey: v.string(), deletedAt: v.string(),
  }).index("by_key", ["fileKey"]),
});
