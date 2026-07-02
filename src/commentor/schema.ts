// Data model: flat threads + flat replies, scoped by (orgSlug, filePath).
// No nesting, no soft-delete, no search index, no audit fields.
// Add them only when a concrete requirement earns them.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Shared anchor shape. Used by the schema, the create mutation args,
// and the widget's client-side capture.
export const anchorValidator = v.union(
  v.object({
    kind: v.literal("text-range"),
    quote: v.string(),
    path: v.array(v.string()),
    startOffset: v.number(),
    endOffset: v.number(),
  }),
  v.object({
    kind: v.literal("element"),
    path: v.array(v.string()),
  }),
);

export default defineSchema({
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
});
