import { ConvexError } from "convex/values";
import { commentErrorClassifier } from "./error-mapping";

// The parent host talks to Convex, so only a real ConvexError carries an
// envelope here. The document frame uses frame-errors.ts instead (#315).
export const { commentRetryAfter, commentErrorMessage, isDefinitiveCommentRejection } = commentErrorClassifier(
  error => error instanceof ConvexError ? error.data : undefined,
);
