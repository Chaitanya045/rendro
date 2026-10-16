import { ConvexError } from "convex/values";
import { isPublicErrorData } from "../shared/public-errors";

// Only the limiter's documented comments envelope is safe to expose. Never
// display backend messages or infer quotas from diagnostic strings.
export function commentRetryAfter(error: unknown): number | null {
  if (!(error instanceof ConvexError) || !error.data || typeof error.data !== "object") return null;
  const data = error.data as Record<string, unknown>;
  return data.kind === "RateLimited" && (data.name === "comments" || data.name === "comments:organization")
    && typeof data.retryAfter === "number" && Number.isFinite(data.retryAfter)
    && data.retryAfter > 0 && data.retryAfter <= 2_147_483_647 ? data.retryAfter : null;
}

export const COMMENT_QUOTA_END_MESSAGE = "You can post comments again now.";

export function commentQuotaMessage(seconds: number): string {
  return seconds > 0 ? `Too many comments right now; try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`
    : COMMENT_QUOTA_END_MESSAGE;
}

export function commentErrorMessage(error: unknown, fallback: string): string {
  const retryAfter = commentRetryAfter(error);
  if (retryAfter !== null) return commentQuotaMessage(Math.ceil(retryAfter / 1000));
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

// A rate limit and the codes below definitively reject this action before it
// can write. Unrecognized codes (even structured ConvexErrors) must keep the
// identity for a safe, unchanged retry.
export function isDefinitiveCommentRejection(error: unknown): boolean {
  if (commentRetryAfter(error) !== null) return true;
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
