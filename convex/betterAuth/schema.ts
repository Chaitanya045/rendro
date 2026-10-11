import { defineSchema } from "convex/server";
import { tables as generatedTables } from "./schema.generated";

// Keep application-owned indexes when regenerating Better Auth's model schema.
export const tables = {
  ...generatedTables,
  rateLimit: generatedTables.rateLimit.index("lastRequest", ["lastRequest"]),
};

export default defineSchema(tables);
