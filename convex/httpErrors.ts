import { ConvexError } from "convex/values";
import { httpAction as registerHttpAction } from "./_generated/server";

// Only explicit application errors are safe to expose. Error.message from a
// nested Convex call includes server stack locations, even for client mistakes.
export function failure(error: unknown, status = 400): Response {
  if (typeof error === "string") return Response.json({ error }, { status });
  if (error instanceof ConvexError && typeof error.data === "string") {
    const message = error.data;
    const code = message === "Invalid ID" ? 400
      : /authentication|membership|role/i.test(message) ? 403
      : status >= 500 ? 400 : status;
    return Response.json({ error: message }, { status: code });
  }
  console.error("HTTP request failed", error);
  return Response.json({ error: "Request failed" }, { status });
}

// HTTP actions do not have database access; their queries/mutations normalize
// client IDs. Catch their structured errors at the outer HTTP boundary too.
export const httpAction = (handler: Parameters<typeof registerHttpAction>[0]) =>
  registerHttpAction(async (ctx, request) => {
    try {
      return await handler(ctx, request);
    } catch (error) {
      return failure(error, 500);
    }
  });
