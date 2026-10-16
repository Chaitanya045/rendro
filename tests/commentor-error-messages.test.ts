import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { commentErrorMessage, commentRetryAfter, commentQuotaMessage, isDefinitiveCommentRejection } from "../src/commentor/errors";

describe("direct Convex widget error messages", () => {
  it.each([
    ["invalid_id", "This comment is unavailable"],
    ["not_found", "This comment is unavailable"],
    ["unauthenticated", "Sign in again"],
    ["forbidden", "You do not have permission"],
    ["invalid_input", "Check your comment"],
    ["conflict", "This comment operation changed"],
  ])("maps %s without displaying backend diagnostics", (code, expected) => {
    const error = new ConvexError({ code, message: "private diagnostics" });
    error.message = "private trace";
    expect(commentErrorMessage(error, "Fallback")).toContain(expected);
    expect(isDefinitiveCommentRejection(error)).toBe(true);
  });
  it.each([
    new Error("private trace"),
    new ConvexError("legacy failure"),
    new ConvexError({ code: "unknown", message: "private diagnostics" }),
  ])("keeps unrecognized failures generic", error => {
    expect(commentErrorMessage(error, "Fallback")).toBe("Fallback");
    expect(isDefinitiveCommentRejection(error)).toBe(false);
  });
});


describe("comment quota envelopes", () => {
  it("rounds milliseconds up and treats quota denial as definitive", () => {
    const error = new ConvexError({ kind: "RateLimited", name: "comments", retryAfter: 1001 });
    expect(commentRetryAfter(error)).toBe(1001);
    expect(commentErrorMessage(error, "Fallback")).toBe("Too many comments right now; try again in 2 seconds.");
    expect(isDefinitiveCommentRejection(error)).toBe(true);
    expect(commentQuotaMessage(0)).toBe("You can try posting your comment again now.");
  });
  it.each([null, false, "trace", {}, { kind: "Other" }, { kind: "RateLimited", name: "shares" },
    ...[undefined, null, "1000", NaN, Infinity, -1, 0, 2_147_483_648].map(retryAfter => ({ kind: "RateLimited", name: "comments", retryAfter })),
  ])("ignores malformed or unrelated envelopes: %j", data => {
    const error = new ConvexError(data as never);
    expect(commentRetryAfter(error)).toBeNull();
    expect(commentErrorMessage(error, "Fallback")).toBe("Fallback");
    expect(isDefinitiveCommentRejection(error)).toBe(false);
  });
});
