import { ConvexError } from "convex/values";
import { isPublicErrorData } from "../shared/public-errors";

export function commentErrorMessage(error: unknown, fallback: string): string {
  const messages = {
    invalid_id: "This comment is unavailable. Reload the document.",
    not_found: "This comment is unavailable. Reload the document.",
    unauthenticated: "Sign in again to comment.",
    forbidden: "You do not have permission to change this comment.",
    invalid_input: "Check your comment and try again.",
    conflict: "This comment operation changed. Reload the document and try again.",
  };
  return error instanceof ConvexError && isPublicErrorData(error.data) ? messages[error.data.code] : fallback;
}

// Auth failure here rejects this action before it can write. A conflict also
// definitively rejects changed operation arguments. Unrecognized codes (even
// structured ConvexErrors) must keep the identity for a safe, unchanged retry.
export function isDefinitiveCommentRejection(error: unknown): boolean {
  if (!(error instanceof ConvexError) || !isPublicErrorData(error.data)) return false;
  switch (error.data.code) {
    case "invalid_id":
    case "not_found":
    case "forbidden":
    case "invalid_input":
    case "unauthenticated":
    case "conflict":
      return true;
    default:
      return false;
  }
}
