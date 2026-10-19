import { describe, expect, it } from "vitest";

import { MAX_QUERY_LENGTH, MAX_TERM_LENGTH, MAX_TERMS, MIN_TERM_LENGTH, neutralizeQuery } from "../src/search/query";

describe("neutralizeQuery", () => {
  it("turns free text into quoted trigram phrases joined by implicit AND", () => {
    expect(neutralizeQuery("install docker compose")).toBe('"install" "docker" "compose"');
  });

  it("neutralizes FTS5 syntax: operators, quotes, prefixes, column filters and NEAR", () => {
    for (const hostile of [
      '"quoted phrase"',
      "install OR docker",
      "install NOT docker",
      "install NEAR docker",
      "install*",
      'title:install',
      "(install AND docker) OR NOT other",
      "^anchor$",
      "install --docker++",
      "x AND {a b} OR y",
      "a.b-c_d/e",
    ]) {
      const match = neutralizeQuery(hostile);
      expect(match, hostile).toSatisfy((value: string | null) => value === null || /^("[\p{L}\p{N}]+" ?)*"?[\p{L}\p{N}]+"?$/u.test(value));
    }
    expect(neutralizeQuery("install OR docker")).toBe('"install" "docker"');
    // Operators survive as words, but quoting neutralizes them: "AND" is a phrase here, never an operator.
    expect(neutralizeQuery('title:install AND "quoted*"')).toBe('"title" "install" "AND" "quoted"');
    // Nothing left but separators, so nothing is searchable either.
    expect(neutralizeQuery("a.b-c_d/e")).toBe(null);
  });

  it("keeps non-Latin terms searchable", () => {
    expect(neutralizeQuery("超快安装指南")).toBe('"超快安装指南"');
    expect(neutralizeQuery("résumé وثائق")).toBe('"résumé" "وثائق"');
  });

  it("drops terms below the trigram length", () => {
    expect(neutralizeQuery("ab an of the okay")).toBe('"the" "okay"');
    expect(neutralizeQuery("ab")).toBe(null);
  });

  it("caps the number of terms and truncates each term", () => {
    const many = Array.from({ length: MAX_TERMS + 5 }, (_, index) => `term${index}`);
    expect(neutralizeQuery(many.join(" "))).toBe(Array.from({ length: MAX_TERMS }, (_, index) => `"term${index}"`).join(" "));

    const long = "z".repeat(MAX_TERM_LENGTH + 20);
    expect(neutralizeQuery(long)).toBe(`"${"z".repeat(MAX_TERM_LENGTH)}"`);
    // A sub-trigram trailing word is dropped.
    expect(neutralizeQuery(`${long} ab`)).toBe(`"${"z".repeat(MAX_TERM_LENGTH)}"`);
  });

  it("returns null for empty or unusable queries and treats only the first characters as usable", () => {
    expect(neutralizeQuery("")).toBe(null);
    expect(neutralizeQuery("   ")).toBe(null);
    expect(neutralizeQuery("... - * :")).toBe(null);
    expect(MAX_QUERY_LENGTH).toBe(200);
    expect(MIN_TERM_LENGTH).toBe(3);
    expect(MAX_TERM_LENGTH).toBe(64);
    expect(MAX_TERMS).toBe(16);
  });
});
