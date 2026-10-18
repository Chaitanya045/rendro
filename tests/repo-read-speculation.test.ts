import { describe, expect, it } from "vitest";
import { REPO_SPECULATION_RULES_PATH, repoSpeculationRules } from "@/repo-read/speculation";

// URLPattern exists at runtime (Node 24, Chromium) but is not in this tsconfig's lib.
declare const URLPattern: new (init: { pathname: string }) => { test(input: string): boolean };

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
    const include = new URLPattern({ pathname: String((where[0] as { href_matches: string }).href_matches) });
    const exclude = new URLPattern({ pathname: String((where[1] as { not: { href_matches: string } }).not.href_matches) });
    expect(include.test("https://rendro.test/r/octo/docs/@c/files/a.md")).toBe(true);
    expect(exclude.test("https://rendro.test/r/octo/docs/@c/files/a.md")).toBe(false);
    expect(exclude.test("https://rendro.test/r/octo/docs/@c/view/tkt/files/img.png")).toBe(true);
  });
});
