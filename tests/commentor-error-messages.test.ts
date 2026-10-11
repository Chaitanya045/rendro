import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { commentErrorMessage } from "../src/commentor/errors";

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
  });
  it.each([
    new Error("private trace"),
    new ConvexError("legacy failure"),
    new ConvexError({ code: "unknown", message: "private diagnostics" }),
  ])("keeps unrecognized failures generic", error => {
    expect(commentErrorMessage(error, "Fallback")).toBe("Fallback");
  });
});
