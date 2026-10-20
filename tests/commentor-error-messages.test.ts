import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { commentErrorClassifier, commentQuotaMessage } from "../src/commentor/error-mapping";
import * as parent from "../src/commentor/errors";
import * as frameErrors from "../src/commentor/frame-errors";
import { CommentErrorEnvelope, frameErrorEnvelope } from "../src/commentor/frame-errors";
import { CommentMutationOutcomeUnknownError, CommentMutationRejectedError } from "../src/commentor/parent-transport";

// One mapping, two ways to read an envelope (#315): the parent host only from a real ConvexError, the
// Convex-free document frame structurally from the envelope it rebuilds out of postMessage. The frame ships
// no rejection classifier (the parent sends its verdict), so its reader is checked against that one too.
const frameClassifier = commentErrorClassifier(frameErrorEnvelope);
const frame = { ...frameErrors, isDefinitiveCommentRejection: (error: unknown) => frameClassifier.isDefinitiveCommentRejection(error) };
const paths = [
  { path: "parent host (ConvexError)", classifier: parent, envelope: (data: unknown) => new ConvexError(data as never) },
  { path: "document frame (structural envelope)", classifier: frame, envelope: (data: unknown) => new CommentErrorEnvelope(data) },
];

const quota = { kind: "RateLimited", name: "comments", retryAfter: 2100 };
const codes = [
  ["invalid_id", "This comment is unavailable. Reload the document."],
  ["not_found", "This comment is unavailable. Reload the document."],
  ["unauthenticated", "Sign in again to comment."],
  ["forbidden", "You do not have permission to change this comment."],
  ["invalid_input", "Check your comment and try again."],
  ["conflict", "This comment operation changed. Reload the document and try again."],
] as const;
// Every error kind: the envelope data, or a failure that carries none (null).
const kinds = [
  { kind: "RateLimited", data: quota, retryAfter: 2100, message: "Too many comments right now; try again in 3 seconds.", definitive: true },
  { kind: "RateLimited (organization)", data: { ...quota, name: "comments:organization" }, retryAfter: 2100, message: "Too many comments right now; try again in 3 seconds.", definitive: true },
  ...codes.map(([code, message]) => ({ kind: code, data: { code, message: "private diagnostics" }, retryAfter: null, message, definitive: true })),
  { kind: "unknown code", data: { code: "unknown", message: "private diagnostics" }, retryAfter: null, message: "Fallback", definitive: false },
  { kind: "legacy string", data: "legacy failure", retryAfter: null, message: "Fallback", definitive: false },
];
const plain = [
  ["outcome-unknown", new CommentMutationOutcomeUnknownError()],
  ["rejected by the parent", new CommentMutationRejectedError("Sign in again to comment.")],
  ["transient", new Error("private trace")],
] as const;

describe.each(paths)("comment error mapping through the $path", ({ classifier, envelope }) => {
  it.each(kinds)("maps $kind without displaying backend diagnostics", ({ data, retryAfter, message, definitive }) => {
    const error = envelope(data);
    error.message = "private trace";
    expect(classifier.commentRetryAfter(error)).toBe(retryAfter);
    expect(classifier.commentErrorMessage(error, "Fallback")).toBe(message);
    expect(classifier.isDefinitiveCommentRejection(error)).toBe(definitive);
  });

  it.each(plain)("keeps a %s failure without an envelope generic", (_kind, error) => {
    expect(classifier.commentRetryAfter(error)).toBeNull();
    expect(classifier.commentErrorMessage(error, "Fallback")).toBe("Fallback");
    expect(classifier.isDefinitiveCommentRejection(error)).toBe(false);
  });

  it("recognizes the per-user and organization-wide comment buckets only", () => {
    for (const name of ["shares", "comments:user", "organization", "comments:"]) {
      expect(classifier.commentRetryAfter(envelope({ ...quota, name }))).toBeNull();
    }
  });

  it.each([null, false, "trace", {}, { kind: "Other" }, { kind: "RateLimited", name: "shares" },
    ...[undefined, null, "1000", NaN, Infinity, -1, 0, 2_147_483_648].map(retryAfter => ({ kind: "RateLimited", name: "comments", retryAfter })),
  ])("ignores malformed or unrelated envelopes: %j", data => {
    const error = envelope(data);
    expect(classifier.commentRetryAfter(error)).toBeNull();
    expect(classifier.commentErrorMessage(error, "Fallback")).toBe("Fallback");
    expect(classifier.isDefinitiveCommentRejection(error)).toBe(false);
  });
});

describe("the two envelope readers", () => {
  it("agree on a real ConvexError of every kind, so the frame's structural check is not narrower", () => {
    for (const { data } of kinds) {
      const error = new ConvexError(data as never);
      expect(frame.commentRetryAfter(error)).toBe(parent.commentRetryAfter(error));
      expect(frame.commentErrorMessage(error, "Fallback")).toBe(parent.commentErrorMessage(error, "Fallback"));
      expect(frame.isDefinitiveCommentRejection(error)).toBe(parent.isDefinitiveCommentRejection(error));
    }
  });

  it("rebuild the quota envelope with ConvexError's message for the same data", () => {
    expect(new CommentErrorEnvelope(quota).message).toBe(new ConvexError(quota).message);
    expect(new CommentErrorEnvelope("legacy failure").message).toBe("legacy failure");
  });

  it("keep the parent on real ConvexErrors and the frame on Error envelopes", () => {
    // The parent talks to Convex: a look-alike envelope is not a Convex result.
    expect(parent.commentRetryAfter(new CommentErrorEnvelope(quota))).toBeNull();
    expect(parent.isDefinitiveCommentRejection(new CommentErrorEnvelope({ code: "forbidden", message: "Forbidden" }))).toBe(false);
    // The frame reads only Error instances, never a bare object or a primitive.
    for (const value of [{ data: quota }, null, undefined, "RateLimited", 2100]) {
      expect(frame.commentRetryAfter(value)).toBeNull();
      expect(frame.commentErrorMessage(value, "Fallback")).toBe("Fallback");
    }
  });
});

describe("comment quota messages", () => {
  it("rounds milliseconds up and treats quota denial as definitive", () => {
    const error = new ConvexError({ ...quota, retryAfter: 1001 });
    expect(parent.commentRetryAfter(error)).toBe(1001);
    expect(parent.commentErrorMessage(error, "Fallback")).toBe("Too many comments right now; try again in 2 seconds.");
    expect(parent.isDefinitiveCommentRejection(error)).toBe(true);
    expect(commentQuotaMessage(0)).toBe("You can post comments again now.");
    expect(commentQuotaMessage(1)).toBe("Too many comments right now; try again in 1 second.");
  });
});
