import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { tables as generatedTables } from "./schema.generated";

// Keep application-owned tables when regenerating Better Auth's model schema.
// Session-read windows live apart from Better Auth's rateLimit table, so their
// cleanup reads only expired windows and never a credential bucket.
export const tables = {
  ...generatedTables,
  sessionReadWindow: defineTable({
    key: v.string(),
    count: v.number(),
    // Fixed when the window starts (see sessionReadLimit.consume).
    expiresAt: v.number(),
  })
    .index("key", ["key"])
    .index("expiresAt", ["expiresAt"]),
};

export default defineSchema(tables);
