import { commentErrorClassifier } from "./error-mapping";

// The document frame never talks to Convex: it receives errors from the parent
// host already serialized over postMessage. It rebuilds the one envelope it
// acts on (a comment quota) as a CommentErrorEnvelope and reads envelopes
// structurally, so commentor.js bundles no convex/values (#315).

/** An error envelope rebuilt in the frame. Its message matches ConvexError's for the same data. */
export class CommentErrorEnvelope extends Error {
  readonly data: unknown;

  constructor(data: unknown) {
    super(typeof data === "string" ? data : JSON.stringify(data));
    this.data = data;
  }
}

/** Structural: any Error carrying `data` (the frame's own envelope, or a ConvexError alike). */
export const frameErrorEnvelope = (error: unknown): unknown => error instanceof Error && "data" in error ? error.data : undefined;

// The frame needs no rejection classifier: the parent sends its verdict as `rejected`.
export const { commentRetryAfter, commentErrorMessage } = commentErrorClassifier(frameErrorEnvelope);
