import { describe, expect, it } from "vitest";
import { parseRepositoryInput } from "../src/github-repo-input";

describe("the home's repository box (#354)", () => {
  it.each([
    ["octo/docs", "octo", "docs"],
    ["octo/docs\n", "octo", "docs"],
    ["  octo/docs  ", "octo", "docs"],
    ["Octo/My.Repo_1-x", "Octo", "My.Repo_1-x"],
    ["https://github.com/octo/docs", "octo", "docs"],
    ["http://www.github.com/octo/docs/", "octo", "docs"],
    ["github.com/octo/docs.git", "octo", "docs"],
    ["https://github.com/octo/docs/tree/main/docs?plain=1#top", "octo", "docs"],
    ["https://GitHub.com/octo/docs?tab=readme", "octo", "docs"],
    ["git@github.com:octo/docs.git", "octo", "docs"],
  ])("reads %s", (input, owner, name) => {
    expect(parseRepositoryInput(input)).toEqual({ owner, name });
  });

  it.each([
    "", "   ", "octo", "octo/", "/docs", "octo/docs/extra", "octo/docs/", "octo//docs", "-octo/docs", "octo/..", "octo/.", "octo/do cs",
    "https://gitlab.com/octo/docs", "https://github.com/octo", "https://github.com/", "https://evil.test/github.com/octo/docs", "javascript:alert(1)//octo/docs",
    "https://github.com/octo/..", "x".repeat(301), "octo/" + "d".repeat(101),
  ])("rejects %j", (input) => {
    expect(parseRepositoryInput(input)).toBeNull();
  });
});
