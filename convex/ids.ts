import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";

// HTTP and public-function callers supply strings, not trusted database IDs.
export function requireId<T extends TableNames>(ctx: Pick<QueryCtx, "db">, table: T, value: string): Id<T> {
  const id = ctx.db.normalizeId(table, value);
  if (!id) throw new ConvexError("Invalid ID");
  return id;
}
