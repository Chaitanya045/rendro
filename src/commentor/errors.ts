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
