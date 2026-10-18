import { describe, expect, it } from "vitest";
import { REPO_SPECULATION_RULES_PATH, repoSpeculationRules } from "@/repo-read/speculation";

// URLPattern exists at runtime (Node 24, Chromium) but is not in this tsconfig's
// lib, and CI runs Node 22 without it, so the match assertions run only where it exists.
type URLPatternLike = new (init: { pathname: string }) => { test(input: string): boolean };
const URLPatternCtor = (globalThis as { URLPattern?: URLPatternLike }).URLPattern;

describe("repository speculation rules", () => {
  it("serves the rules from a same-origin path outside the capability routes", () => {
    expect(REPO_SPECULATION_RULES_PATH).toBe("/speculation-rules/repo.json");
    expect(REPO_SPECULATION_RULES_PATH.startsWith("/r/")).toBe(false);
  });

  it("prefetches commit-pinned document frames with moderate eagerness and never ticket URLs", () => {
    expect(JSON.parse(repoSpeculationRules())).toEqual({
      prefetch: [
        {
          source: "document",
          where: {
            and: [
              { href_matches: "/r/*/@*/files/*" },
              { not: { href_matches: "/r/*/@*/view/*" } },
            ],
          },
          eagerness: "moderate",
        },
      ],
    });
  });

  it("matches frame paths and excludes the ticket form", () => {
    const where = JSON.parse(repoSpeculationRules()).prefetch[0].where.and as Array<Record<string, unknown>>;
    const includePattern = String((where[0] as { href_matches: string }).href_matches);
    const excludePattern = String((where[1] as { not: { href_matches: string } }).not.href_matches);
    expect(includePattern).toBe("/r/*/@*/files/*");
    expect(excludePattern).toBe("/r/*/@*/view/*");
    // Match semantics depend on URLPattern, which every browser that reads these
    // rules has; the contract above is what this suite asserts everywhere else.
    if (!URLPatternCtor) return;
    const include = new URLPatternCtor({ pathname: includePattern });
    const exclude = new URLPatternCtor({ pathname: excludePattern });
    expect(include.test("https://rendro.test/r/octo/docs/@c/files/a.md")).toBe(true);
    expect(exclude.test("https://rendro.test/r/octo/docs/@c/files/a.md")).toBe(false);
    expect(exclude.test("https://rendro.test/r/octo/docs/@c/view/tkt/files/img.png")).toBe(true);
  });
});
