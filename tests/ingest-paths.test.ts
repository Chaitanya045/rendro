import { describe, expect, it } from "vitest";

import { basenameOf, dirnameOf, extensionOf, isRepoPath, isWithin, joinRepoPath, prefixFragment, resolveConfigDir, resolveRepoPath, rewriteUrl } from "../src/ingest/paths";

describe("repo path helpers", () => {
  it("validates repo paths", () => {
    expect(["a", "a/b.md", "a b/c"].map(isRepoPath)).toEqual([true, true, true]);
    expect(["", "/a", "a/", "a//b", "./a", "a/../b", "a\\b", "a\u0000b", "a\u007fb"].map(isRepoPath)).toEqual(Array(9).fill(false));
  });

  it("splits paths", () => {
    expect([dirnameOf("a/b/c.md"), dirnameOf("c.md"), basenameOf("a/b/c.md"), basenameOf("c.md")]).toEqual(["a/b", "", "c.md", "c.md"]);
    expect(["a/b.MD", "a.tar.gz", "README", ".gitignore", "a.b/c"].map(extensionOf)).toEqual([".md", ".gz", "", "", ""]);
    expect([joinRepoPath("", "a"), joinRepoPath("d", "a")]).toEqual(["a", "d/a"]);
    expect([isWithin("a/b", ""), isWithin("a", "a"), isWithin("a/b", "a"), isWithin("ab", "a")]).toEqual([true, true, true, false]);
  });

  it("resolves references within the repo", () => {
    expect(resolveRepoPath("docs/guide", "../api/./x.md")).toBe("docs/api/x.md");
    expect(resolveRepoPath("", "a//b/")).toBe("a/b");
    expect(resolveRepoPath("docs", "../..")).toBeNull();
  });

  it("resolves config directories or rejects them", () => {
    expect(["docs", "./src/", ".", "docs/../site"].map((value) => resolveConfigDir("web", value))).toEqual(["web/docs", "web/src", "web", "web/site"]);
    expect(["", "  ", "/abs", "C:\\x", "a\\b", "https://x", "../..", "a/\u0001"].map((value) => resolveConfigDir("web", value))).toEqual(Array(8).fill(null));
  });
});

describe("rewriteUrl", () => {
  const doc = "docs/guide/intro.md";
  it.each([
    ["https://Example.com/a b", "href", "https://example.com/a%20b"],
    ["HTTP://x.example", "src", "http://x.example/"],
    ["//cdn.example/x.png", "src", "https://cdn.example/x.png"],
    ["\\\\cdn.example\\y", "href", "https://cdn.example/y"],
    ["/\\host.example/z", "href", "https://host.example/z"],
    ["mailto:a@b.example", "href", "mailto:a@b.example"],
    ["#Install", "href", "#user-content-Install"],
    ["#user-content-x", "href", "#user-content-x"],
    ["#caf%C3%A9", "href", "#user-content-caf%C3%A9"],
    ["#", "href", "#"],
    ["../api/README.md#usage", "href", "../api/README.md#user-content-usage"],
    ["setup.md?plain=1#x", "href", "setup.md#user-content-x"],
    ["setup.md#", "href", "setup.md"],
    ["img/logo.png#frag", "src", "img/logo.png"],
    ["/LICENSE", "href", "../../LICENSE"],
    ["/", "href", "../../"],
    ["sub/", "href", "sub/"],
    [".", "href", "./"],
    ["./", "href", "./"],
    ["./a%20b.md", "href", "a%20b.md"],
    ["%2e%2e/x.md", "href", "../x.md"],
    ["bad%zz.md", "href", "bad%25zz.md"],
    ["  \t spaced.md \n", "href", "spaced.md"],
    ["ja\tva\nscript:alert(1)", "href", null],
    ["JavaScript:alert(1)", "href", null],
    ["vbscript:x", "href", null],
    ["data:text/html,x", "src", null],
    ["mailto:a@b.example", "src", null],
    ["#frag", "src", null],
    ["https://[invalid", "href", null],
    ["//[invalid", "href", null],
    ["", "href", null],
    ["   ", "href", null],
    ["?q=1", "href", null],
    ["../../../x.md", "href", null],
    ["a%2Fb.md", "href", null],
    ["a%5Cb.md", "href", null],
    ["a%00b.md", "href", null],
    ["\ud800.md", "href", null],
    ["#\ud800", "href", null],
    ["x.md#\ud800", "href", null],
  ] as const)("%j (%s) -> %j", (raw, context, expected) => {
    expect(rewriteUrl(raw, doc, context)).toBe(expected);
  });

  it("resolves against the repo root for root-level documents", () => {
    expect(rewriteUrl("docs/a.md", "README.md", "href")).toBe("docs/a.md");
    expect(rewriteUrl("../a.md", "README.md", "href")).toBeNull();
  });

  it("prefixes fragments once", () => {
    expect(prefixFragment("x")).toBe("user-content-x");
    expect(prefixFragment("user-content-x")).toBe("user-content-x");
    expect(prefixFragment("")).toBe("");
  });
});
