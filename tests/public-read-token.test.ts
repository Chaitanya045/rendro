import { describe, expect, it } from "vitest";
import { publicReadTokens } from "../src/ingest/github/public-token";

describe("the public-read token (#354)", () => {
  it("hands out a well-formed token, and nothing for an unset or malformed one", () => {
    expect(publicReadTokens("github_pat_11AB-cd.ef_12").token()).toBe("github_pat_11AB-cd.ef_12");
    expect(publicReadTokens("ghp_" + "a".repeat(36)).token()).toBe("ghp_" + "a".repeat(36));
    for (const value of [undefined, "", "has space", "line\nbreak", "x".repeat(513), "ünï"]) expect(publicReadTokens(value).token()).toBeNull();
  });
});
