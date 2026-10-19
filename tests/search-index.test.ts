import { describe, expect, it } from "vitest";

import type { PageSection } from "../src/ingest/sections";
import { d1SearchIndex, type SearchD1Result } from "../src/search/d1";
import { SqliteSearchD1 } from "./helpers/search-sqlite";

const section = (slug: string, title: string, text: string): PageSection => ({ slug, title, text });

describe("d1SearchIndex", () => {
  it("migrates idempotently and answers hasBlob per blob and repository", async () => {
    const database = new SqliteSearchD1();
    const index = d1SearchIndex(database);
    await index.migrate();
    await index.migrate();
    expect(await index.hasBlob(1, "a".repeat(40))).toBe(false);
    await index.putBlob(1, "a".repeat(40), [section("intro", "Intro", "getting started quickly")]);
    expect(await index.hasBlob(1, "a".repeat(40))).toBe(true);
    // Another blob, or the same blob in another repository, is a miss.
    expect(await index.hasBlob(1, "b".repeat(40))).toBe(false);
    expect(await index.hasBlob(2, "a".repeat(40))).toBe(false);
    // The memoized migration promise runs the schema exactly once.
    const again = d1SearchIndex(database);
    await Promise.all([again.migrate(), again.migrate()]);
    expect(await again.hasBlob(1, "a".repeat(40))).toBe(true);
  });

  it("replaces a blob's rows on re-index and chunks large section lists", async () => {
    const database = new SqliteSearchD1();
    const index = d1SearchIndex(database);
    await index.putBlob(7, "a".repeat(40), [section("one", "One", "first version of the text")]);
    const many = Array.from({ length: 95 }, (_, index) => section(`s${index}`, `S${index}`, `chunk number ${index} text`));
    await index.putBlob(7, "a".repeat(40), many);
    const hits = await index.query(7, '"chunk"', 200);
    expect(hits).toHaveLength(95);
    // Two chunks (40 + 40 + 15) were inserted; one round trip per chunk.
    expect(await index.hasBlob(7, "a".repeat(40))).toBe(true);
    const count = database.database.prepare("SELECT COUNT(*) AS n FROM sections WHERE repo_id = 7").all();
    expect(count[0].n).toBe(95);
    await index.putBlob(7, "b".repeat(40), []);
    expect(await index.hasBlob(7, "b".repeat(40))).toBe(false);
  });

  it("ranks by bm25 with the title weighted above the body and wraps matches in the snippet", async () => {
    const index = d1SearchIndex(new SqliteSearchD1());
    await index.migrate();
    const padding = `${"filler words here. ".repeat(30)}`;
    await index.putBlob(1, "a".repeat(40), [
      section("deployment", "Deployment", `${padding} how the deployment pipeline works, and what deployment means. ${padding}`),
      section("unrelated", "Unrelated", `${padding} deployment appears here once. ${padding}`),
    ]);
    const hits = await index.query(1, '"deployment"', 10);
    expect(hits).toHaveLength(2);
    // More matches rank first (bm25, lower is better); the window is 64 trigram tokens, so the snippet is ellipsised.
    expect(hits.map(hit => hit.slug)).toEqual(["deployment", "unrelated"]);
    expect(hits[0].snippet).toContain("\u0002deployment\u0003");
    expect(hits[0].snippet).toContain("...");
    expect(hits[1].snippet).toContain("\u0002deployment\u0003");
  });

  it("scopes query results by repository and honours the limit", async () => {
    const index = d1SearchIndex(new SqliteSearchD1());
    await index.migrate();
    await index.putBlob(1, "a".repeat(40), [section("one", "One", "shared searchable prose")]);
    await index.putBlob(2, "b".repeat(40), [section("one", "One", "shared searchable prose")]);
    await index.putBlob(2, "c".repeat(40), [section("two", "Two", "shared searchable prose")]);
    expect((await index.query(1, '"shared"', 10)).map(hit => hit.blobSha)).toEqual(["a".repeat(40)]);
    expect((await index.query(2, '"shared"', 1))).toHaveLength(1);
    expect(await index.query(3, '"shared"', 10)).toEqual([]);
    // A term shorter than the trigram length matches nothing without an error.
    expect(await index.query(1, '"ab"', 10)).toEqual([]);
  });
});

describe("SearchD1 double shape", () => {
  it("binds values per statement so batches and statements do not alias", async () => {
    const database = new SqliteSearchD1();
    const statements = [1, 2].map(value => database.prepare("SELECT ? AS value").bind(value));
    await database.batch(statements);
    const single = database.prepare("SELECT ? AS value").bind(3);
    const nested = database.prepare("SELECT ? AS value").bind(4);
    expect((await (nested.all() as Promise<SearchD1Result<{ value: number }>>)).results).toEqual([{ value: 4 }]);
    expect((await (single.all() as Promise<SearchD1Result<{ value: number }>>)).results).toEqual([{ value: 3 }]);
  });
});
