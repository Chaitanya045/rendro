import { isPublicErrorData, type PublicErrorCode } from "../shared/public-errors";

// Convex-free (#315): the document frame bundles this mapping, so it must not
// import convex/values. Each realm injects how it reads an error's envelope:
// the parent host from a real ConvexError (errors.ts), the frame structurally
// from the envelope it rebuilds out of postMessage (frame-errors.ts).

/** An error's structured envelope data, or undefined when it carries none. */
export type ErrorEnvelopeReader = (error: unknown) => unknown;

export const COMMENT_QUOTA_END_MESSAGE = "You can post comments again now.";

export function commentQuotaMessage(seconds: number): string {
  return seconds > 0 ? `Too many comments right now; try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`
    : COMMENT_QUOTA_END_MESSAGE;
}

const messages: Record<PublicErrorCode, string> = {
  invalid_id: "This comment is unavailable. Reload the document.",
  not_found: "This comment is unavailable. Reload the document.",
  unauthenticated: "Sign in again to comment.",
  forbidden: "You do not have permission to change this comment.",
  invalid_input: "Check your comment and try again.",
  conflict: "This comment operation changed. Reload the document and try again.",
};

// A rate limit and every code marked below definitively reject this action
// before it can write. Unrecognized codes (even structured ConvexErrors) must
// keep the identity for a safe, unchanged retry. The record type forces a
// decision whenever a public code is added.
const definitiveCodes: Record<PublicErrorCode, boolean> = {
  invalid_id: true,
  not_found: true,
  forbidden: true,
  invalid_input: true,
  unauthenticated: true,
  conflict: true,
};

export function commentErrorClassifier(envelope: ErrorEnvelopeReader) {
  // Only the limiter's documented comments envelope is safe to expose. Never
  // display backend messages or infer quotas from diagnostic strings.
  function commentRetryAfter(error: unknown): number | null {
    const data = envelope(error);
    if (!data || typeof data !== "object") return null;
    const quota = data as Record<string, unknown>;
    return quota.kind === "RateLimited" && (quota.name === "comments" || quota.name === "comments:organization")
      && typeof quota.retryAfter === "number" && Number.isFinite(quota.retryAfter)
      && quota.retryAfter > 0 && quota.retryAfter <= 2_147_483_647 ? quota.retryAfter : null;
  }

  return {
    commentRetryAfter,
    commentErrorMessage(error: unknown, fallback: string): string {
      const retryAfter = commentRetryAfter(error);
      if (retryAfter !== null) return commentQuotaMessage(Math.ceil(retryAfter / 1000));
      const data = envelope(error);
      return isPublicErrorData(data) ? messages[data.code] : fallback;
    },
    isDefinitiveCommentRejection(error: unknown): boolean {
      if (commentRetryAfter(error) !== null) return true;
      const data = envelope(error);
      return isPublicErrorData(data) && definitiveCodes[data.code];
    },
  };
}
