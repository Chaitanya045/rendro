import type { PaginationOptions, PaginationResult } from "convex/server";
import { ConvexError } from "convex/values";
import { publicError } from "./publicErrors";

export async function publicPaginate<T>(
  query: { paginate(options: PaginationOptions): Promise<PaginationResult<T>> },
  options: PaginationOptions,
): Promise<PaginationResult<T>> {
  // Cursors are opaque and versioned; reject empty input without imposing an
  // encoding or size limit that could invalidate a runtime-issued cursor.
  for (const cursor of [options.cursor, options.endCursor]) {
    if (cursor !== null && cursor !== undefined && cursor.trim().length === 0) {
      publicError("invalid_input");
    }
  }
  try {
    return await query.paginate(options);
  } catch (error) {
    // Verified against the isolate runtime: decoding errors lose their code at
    // the syscall boundary; query fingerprint failures retain system data.
    const data: unknown = error instanceof ConvexError ? error.data : undefined;
    if (
      (error instanceof Error && error.message === "Failed to parse cursor")
      || (data !== null && typeof data === "object"
        && "isConvexSystemError" in data && data.isConvexSystemError === true
        && "paginationError" in data && data.paginationError === "InvalidCursor")
    ) publicError("invalid_input");
    throw error;
  }
}
