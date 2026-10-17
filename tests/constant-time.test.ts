import { describe, expect, it } from "vitest";
import { bearerMatches, constantTimeEqual } from "../shared/constant-time";

describe("constantTimeEqual", () => {
  it.each([
    ["", "", true],
    ["synthetic-secret", "synthetic-secret", true],
    ["synthetic-secret", "synthetic-secreT", false],
    ["Xynthetic-secret", "synthetic-secret", false],
    ["synthetic", "synthetic-secret", false],
    ["synthetic-secret", "synthetic", false],
    ["", "x", false],
    ["x", "", false],
    // A shorter value that is a prefix of the other never matches, and NUL padding is not equality.
    ["abc", "abc\0", false],
    ["abc\0", "abc", false],
    ["naïve", "naïve", true],
    ["naïve", "naive", false],
    ["🔑", "🔑", true],
    ["🔑", "🗝", false],
  ])("compares %j with %j as %s", (left, right, expected) => {
    expect(constantTimeEqual(left, right)).toBe(expected);
  });
});

describe("bearerMatches", () => {
  it.each([
    ["Bearer synthetic-secret", "synthetic-secret", true],
    ["Bearer synthetic-secreT", "synthetic-secret", false],
    ["bearer synthetic-secret", "synthetic-secret", false],
    ["synthetic-secret", "synthetic-secret", false],
    ["Bearer ", "synthetic-secret", false],
    ["", "synthetic-secret", false],
    [null, "synthetic-secret", false],
    // An unset or empty secret must not authorize the literal header `Bearer undefined` or `Bearer `.
    ["Bearer undefined", undefined, false],
    ["Bearer ", "", false],
    [null, undefined, false],
  ])("authorizes header %j for secret %j: %s", (header, secret, expected) => {
    expect(bearerMatches(header, secret)).toBe(expected);
  });
});
