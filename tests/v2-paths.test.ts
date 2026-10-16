import { describe, expect, it } from "vitest";
import { cleanDeploymentPath, cleanPublicationPath } from "../shared/v2-paths";

describe("publication path cleanup", () => {
  it("strips outer whitespace and slashes, keeping inner percent signs literal", () => {
    expect(cleanPublicationPath("  /docs/guide%20a.html/ ", false)).toBe("docs/guide%20a.html");
    expect(cleanPublicationPath("docs", true)).toBe("docs");
  });

  it("treats an empty field as a valid empty prefix only when allowed", () => {
    for (const empty of ["", "   ", "///", " / "]) {
      expect(cleanPublicationPath(empty, true)).toBe("");
      expect(cleanPublicationPath(empty, false)).toBeNull();
    }
  });

  it.each(["../escape", "a/../b", "a//b", "a\\b", "a/./b"])("rejects the non-canonical path %j", (path) => {
    expect(cleanPublicationPath(path, true)).toBeNull();
    expect(cleanPublicationPath(path, false)).toBeNull();
  });
});

describe("deployment path cleanup", () => {
  it("accepts canonical keys up to 1024 characters and nothing longer", () => {
    expect(cleanDeploymentPath("assets/app.js")).toBe("assets/app.js");
    expect(cleanDeploymentPath("a".repeat(1024))).toBe("a".repeat(1024));
    expect(cleanDeploymentPath("a".repeat(1025))).toBeNull();
  });

  it.each(["", "/leading", "trailing/", "a//b", "../up", "a/../b"])("rejects %j without trimming it into shape", (path) => {
    expect(cleanDeploymentPath(path)).toBeNull();
  });
});
