import { ConvexError } from "convex/values";
import { httpAction as registerHttpAction } from "./_generated/server";

// Use only for messages authored by the handler, never caught exceptions.
export function clientFailure(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export function isApplicationError(error: unknown): error is ConvexError<string> {
  return error instanceof ConvexError && typeof error.data === "string";
}

// ConvexError is the explicit application-error contract across function calls.
// The supplied status applies ONLY to those errors, never infrastructure faults.
export function failure(error: unknown, applicationStatus = 400, operation = "httpAction"): Response {
  if (isApplicationError(error)) {
    const message = error.data;
    const code = message === "Invalid ID" ? 400
      : /authentication|membership|role/i.test(message) ? 403
      : applicationStatus >= 500 ? 400 : applicationStatus;
    return clientFailure(message, code);
  }
  // Arbitrary exception messages, stacks, and objects may contain credentials or
  // request data. Log only fixed categories and the caller's static operation.
  const category = error instanceof TypeError ? "TypeError"
    : error instanceof RangeError ? "RangeError"
    : error instanceof Error ? "Error" : "Unknown";
  console.error("HTTP request failed", { operation, category });
  return Response.json({ error: "Request failed" }, { status: 500 });
}

export const httpAction = (handler: Parameters<typeof registerHttpAction>[0]) =>
  registerHttpAction(async (ctx, request) => {
    try {
      return await handler(ctx, request);
    } catch (error) {
      return failure(error, 500);
    }
  });
