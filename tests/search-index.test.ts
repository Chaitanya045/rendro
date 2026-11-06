import { describe, expect, it } from "vitest";

import type { PageSection } from "../src/ingest/sections";
import { d1SearchIndex, isMissingSchema, repoSearchKey, type SearchD1, type SearchD1Result, type SearchD1Statement } from "../src/search/d1";
import { SqliteSearchD1 } from "./helpers/search-sqlite";

const section = (slug: string, title: string, text: string): PageSection => ({ slug, title, text });

/** The SQLite double, recording the full-text queries the index runs so a test can re-run their plan and match. */
function recording(database: SqliteSearchD1) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const d1: SearchD1 = {
    prepare(sql) {
      const statement = database.prepare(sql);
      const recorded: SearchD1Statement = {
        bind(...values) {
          if (sql.includes(" MATCH ")) queries.push({ sql, values });
          statement.bind(...values);
          return recorded;
        },
        all: () => statement.all(),
        run: () => statement.run(),
      };
      return recorded;
    },
    batch: statements => database.batch(statements),
    exec: sql => database.exec(sql),
  };
  return { d1, queries };
}

/** #251's schema, before the index carried repository keys. */
const UNKEYED_SCHEMA = `
  CREATE TABLE sections (repo_id INTEGER NOT NULL, blob_sha TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (repo_id, blob_sha, slug));
  CREATE VIRTUAL TABLE sections_fts USING fts5(title, body, content='sections', content_rowid='rowid', tokenize='trigram');
  CREATE TRIGGER sections_ai AFTER INSERT ON sections BEGIN
    INSERT INTO sections_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;
  CREATE TRIGGER sections_ad AFTER DELETE ON sections BEGIN
    INSERT INTO sections_fts(sections_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  END;
  CREATE TRIGGER sections_au AFTER UPDATE ON sections BEGIN
    INSERT INTO sections_fts(sections_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO sections_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;`;

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

  /** The SQLite double with every batch recorded (its statements' SQL, in order) and optionally delayed or failed. */
  function batched(options: { delay?: number; fail?: (batch: number) => boolean } = {}) {
    const database = new SqliteSearchD1();
    const batches: string[][] = [];
    const timeline = { active: 0, peak: 0, finished: 0 };
    const d1: SearchD1 = {
      prepare(sql) {
        const statement = database.prepare(sql);
        const recorded: SearchD1Statement & { sql: string } = {
          sql,
          bind(...values) { statement.bind(...values); return recorded; },
          all: () => statement.all(),
          run: () => statement.run(),
        };
        return recorded;
      },
      async batch(statements) {
        const number = batches.length;
        batches.push(statements.map(statement => (statement as SearchD1Statement & { sql: string }).sql));
        timeline.active += 1;
        timeline.peak = Math.max(timeline.peak, timeline.active);
        await new Promise(resolve => setTimeout(resolve, options.delay ?? 0));
        timeline.active -= 1;
        timeline.finished += 1;
        if (options.fail?.(number)) throw new Error("D1 down");
        return database.batch(statements);
      },
      exec: sql => database.exec(sql),
    };
    return { database, d1, batches, timeline };
  }
  const isDelete = (sql: string) => sql.startsWith("DELETE FROM sections");
  const many = (count: number) => Array.from({ length: count }, (_, index) => section(`s${index}`, `S${index}`, `chunk number ${index} text`));

  it("folds the DELETE into the first batch and overlaps the remaining batches", async () => {
    const { d1, batches, timeline } = batched({ delay: 5 });
    const index = d1SearchIndex(d1);
    await index.migrate();
    batches.length = 0;
    timeline.peak = 0;
    await index.putBlob(7, "a".repeat(40), many(95));
    expect(batches.map(batch => batch.length)).toEqual([41, 40, 15]);
    expect(batches.flat().filter(isDelete)).toHaveLength(1);
    expect(isDelete(batches[0][0])).toBe(true);
    // The two later batches are in flight together; the first finished before they started (it holds the DELETE).
    expect(timeline.peak).toBe(2);
    expect((await index.query(7, '"chunk"', 200))).toHaveLength(95);
  });

  it("sends a short page in one batch with its DELETE, and an empty one as the DELETE alone", async () => {
    const { d1, batches } = batched();
    const index = d1SearchIndex(d1);
    await index.migrate();
    batches.length = 0;
    await index.putBlob(7, "a".repeat(40), many(3));
    await index.putBlob(7, "b".repeat(40), []);
    expect(batches.map(batch => batch.length)).toEqual([4, 1]);
    expect(isDelete(batches[1][0])).toBe(true);
  });

  it("skips the DELETE for a blob known to have no rows, and sends nothing for an empty one", async () => {
    const { d1, batches, database } = batched();
    const index = d1SearchIndex(d1);
    await index.migrate();
    batches.length = 0;
    await index.putBlob(7, "a".repeat(40), many(45), { replace: false });
    expect(batches.map(batch => batch.length)).toEqual([40, 5]);
    expect(batches.flat().some(isDelete)).toBe(false);
    batches.length = 0;
    await index.putBlob(7, "b".repeat(40), [], { replace: false });
    expect(batches).toEqual([]);
    // `replace: true` is the default behaviour spelled out.
    await index.putBlob(7, "a".repeat(40), many(2), { replace: true });
    expect(database.database.prepare("SELECT COUNT(*) AS n FROM sections WHERE repo_id = 7").all()[0].n).toBe(2);
  });

  it("lets every overlapping batch settle before it reports a failure", async () => {
    const { d1, batches, timeline } = batched({ delay: 3, fail: batch => batch === 2 });
    const index = d1SearchIndex(d1);
    await index.migrate();
    batches.length = 0;
    timeline.finished = 0;
    await expect(index.putBlob(7, "a".repeat(40), many(125))).rejects.toThrow("D1 down");
    expect(batches).toHaveLength(4);
    expect(timeline.active).toBe(0);
    expect(timeline.finished).toBe(4);
    // The retry replaces whatever the failed attempt left.
    await d1SearchIndex(d1).putBlob(7, "a".repeat(40), many(125));
    expect((await index.query(7, '"chunk"', 200))).toHaveLength(125);
  });

  it("ranks title matches first and wraps matches in the snippet", async () => {
    const index = d1SearchIndex(new SqliteSearchD1());
    await index.migrate();
    const padding = `${"filler words here. ".repeat(30)}`;
    await index.putBlob(1, "a".repeat(40), [
      section("deployment", "Deployment", `${padding} how the deployment pipeline works, and what deployment means. ${padding}`),
      section("unrelated", "Unrelated", `${padding} deployment appears here once. ${padding}`),
    ]);
    const hits = await index.query(1, '"deployment"', 10);
    expect(hits).toHaveLength(2);
    // The title match ranks first; the window is 64 trigram tokens, so the snippet is ellipsised.
    expect(hits.map(hit => hit.slug)).toEqual(["deployment", "unrelated"]);
    expect(hits[0].snippet).toContain("\u0002deployment\u0003");
    expect(hits[0].snippet).toContain("...");
    expect(hits[1].snippet).toContain("\u0002deployment\u0003");
  });

  it("ranks more title matches above fewer, then the shorter section, then the older row", async () => {
    const index = d1SearchIndex(new SqliteSearchD1());
    await index.putBlob(1, "a".repeat(40), [
      section("long", "Notes", `install ${"words ".repeat(50)}`),
      section("short", "Notes", "install it"),
      section("same", "Other", "install it"),
      section("once", "Install", "install"),
      section("twice", "Install, then reinstall", "install"),
    ]);
    expect((await index.query(1, '"install"', 10)).map(hit => hit.slug)).toEqual(["twice", "once", "short", "same", "long"]);
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

describe("d1SearchIndex: per-repository scoping in the index (#294)", () => {
  it("examines only the scoped repository's rows, however many matching rows another repository has", async () => {
    const database = new SqliteSearchD1();
    const { d1, queries } = recording(database);
    const index = d1SearchIndex(d1);
    await index.putBlob(2, "b".repeat(40), [section("only", "Only", "the and for, in repository B")]);
    const alone = await index.query(2, '"the" "and"', 20);
    expect(alone.map(hit => hit.slug)).toEqual(["only"]);
    // Repository A indexes 10,000 sections that match the same terms.
    await index.putBlob(1, "a".repeat(40), Array.from({ length: 10_000 }, (_, row) => section(`s${row}`, `Section ${row}`, `the and for, row ${row}`)));
    expect(await index.query(2, '"the" "and"', 20)).toEqual(alone);
    const { sql, values } = queries.at(-1) as { sql: string; values: unknown[] };
    const yielded = (match: unknown) =>
      (database.database.prepare("SELECT COUNT(*) AS n FROM sections_search WHERE sections_search MATCH ?").all(match as string)[0] as { n: number }).n;
    // The index itself yields B's row alone; an unscoped match of the same terms would yield all 10,001.
    expect(yielded(values[0])).toBe(1);
    expect(yielded('"the" "and"')).toBe(10_001);
    // The FTS index drives the query, and each row it yields is joined by rowid: no scan of the sections table.
    const plan = database.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values as string[]).map(row => (row as { detail: string }).detail);
    expect(plan[0]).toMatch(/^SCAN sections_search VIRTUAL TABLE INDEX \d+:M/);
    expect(plan).toContain("SEARCH s USING INTEGER PRIMARY KEY (rowid=?)");
    expect(plan.filter(step => /^SCAN s\b/.test(step))).toEqual([]);
    // The rank reads the row only: bm25 would count every repository's matches for its inverse document frequency.
    expect(sql).not.toMatch(/bm25|\brank\b/);
  });

  it("computes the same repository key in SQL as for the query, for every repository ID", async () => {
    const database = new SqliteSearchD1();
    const index = d1SearchIndex(database);
    const ids = [1, 65_533, 65_534, 65_534 ** 2 + 7, 65_534 ** 3 + 5, Number.MAX_SAFE_INTEGER];
    for (const id of ids) await index.putBlob(id, "c".repeat(40), [section("keyed", "Keyed", "keyed text")]);
    for (const id of ids) {
      const stored = database.database.prepare("SELECT rk FROM sections_keyed WHERE id = (SELECT rowid FROM sections WHERE repo_id = ?)").all(id)[0] as { rk: string };
      expect(stored.rk).toBe(repoSearchKey(id));
      expect([...repoSearchKey(id)]).toHaveLength(4);
      expect(await index.query(id, '"keyed"', 10)).toHaveLength(1);
    }
    expect(new Set(ids.map(repoSearchKey)).size).toBe(ids.length);
  });

  it("keeps the key's code points out of indexed text, so no repository's content can stand in for another's key", async () => {
    const database = new SqliteSearchD1();
    const index = d1SearchIndex(database);
    const foreign = repoSearchKey(2);
    await index.putBlob(1, "a".repeat(40), [section("icon", `Title ${foreign}`, `body ${foreign} text \u{F0041}`)]);
    expect(database.database.prepare("SELECT title, body FROM sections").all()[0]).toEqual({ title: "Title ", body: "body  text " });
    expect(await index.query(2, '"body"', 10)).toEqual([]);
    expect(await index.query(1, '"body"', 10)).toHaveLength(1);
  });

  it("migrates an index built before repository keys forward once, keeping its rows searchable and its triggers in step", async () => {
    const database = new SqliteSearchD1();
    database.database.exec(UNKEYED_SCHEMA);
    database.database.prepare("INSERT INTO sections VALUES (?, ?, ?, ?, ?)").run(5, "d".repeat(40), "old", "Old title", "indexed before the keys");
    const index = d1SearchIndex(database);
    expect(await index.query(5, '"before"', 10)).toMatchObject([{ slug: "old", title: "Old title" }]);
    const schema = () => database.database.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view') OR name LIKE 'sections_fts%' ORDER BY name").all()
      .map(row => `${(row as { type: string }).type}:${(row as { name: string }).name}`);
    expect(schema()).toEqual(["view:sections_keyed", "trigger:sections_search_ad", "trigger:sections_search_ai", "trigger:sections_search_au"]);
    // Another isolate's migration is a no-op, and the swapped triggers keep the index in step.
    await d1SearchIndex(database).migrate();
    database.database.prepare("UPDATE sections SET body = ? WHERE repo_id = 5").run("rewritten afterwards");
    expect(await index.query(5, '"before"', 10)).toEqual([]);
    expect(await index.query(5, '"afterwards"', 10)).toHaveLength(1);
    expect(await index.deleteRepo(5, 10)).toBe(1);
    expect(await index.query(5, '"afterwards"', 10)).toEqual([]);
    expect(schema()).toHaveLength(4);
  });
});

/** A D1 over `database` that records every prepared statement and every batch, and can fail chosen ones. */
function spied(database: SqliteSearchD1, fail: { select?: Error; batches?: Error[] } = {}) {
  const log: string[] = [];
  const d1: SearchD1 = {
    prepare(sql) {
      const statement = database.prepare(sql);
      const wrapped: SearchD1Statement = {
        bind(...values) {
          statement.bind(...values);
          return wrapped;
        },
        all: () => {
          log.push(sql.startsWith("SELECT s.blob_sha") ? "select" : "other");
          if (fail.select && sql.startsWith("SELECT s.blob_sha")) return Promise.reject(fail.select);
          return statement.all();
        },
        run: () => statement.run(),
      };
      return wrapped;
    },
    batch(statements) {
      log.push("batch");
      const error = fail.batches?.shift();
      return error ? Promise.reject(error) : database.batch(statements);
    },
    exec: sql => database.exec(sql),
  };
  return { d1, log };
}

describe("query keeps schema migration off the read path (#358)", () => {
  it("answers from an existing schema without issuing any DDL", async () => {
    const database = new SqliteSearchD1();
    await d1SearchIndex(database).putBlob(3, "a".repeat(40), [section("intro", "Intro", "installation notes")]);
    // A new isolate: a fresh index object over the already-migrated database.
    const { d1, log } = spied(database);
    expect(await d1SearchIndex(d1).query(3, '"installation"', 10)).toHaveLength(1);
    expect(log).toEqual(["select"]);
  });

  it("migrates a brand-new database and retries once when the schema is missing", async () => {
    const database = new SqliteSearchD1();
    const { d1, log } = spied(database);
    const index = d1SearchIndex(d1);
    expect(await index.query(3, '"installation"', 10)).toEqual([]);
    expect(log).toEqual(["select", "batch", "select"]);
    // The database is migrated for good: the next query is a single read.
    expect(database.database.prepare("SELECT name FROM sqlite_master WHERE name = 'sections_search'").all()).toHaveLength(1);
    await index.query(3, '"installation"', 10);
    expect(log).toEqual(["select", "batch", "select", "select"]);
  });

  it("shares one migration between concurrent first queries", async () => {
    const { d1, log } = spied(new SqliteSearchD1());
    const index = d1SearchIndex(d1);
    await Promise.all([index.query(1, '"abc"', 5), index.query(2, '"abc"', 5), index.query(3, '"abc"', 5)]);
    expect(log.filter(entry => entry === "batch")).toHaveLength(1);
  });

  it("re-runs the migration when the schema vanishes after this isolate migrated it", async () => {
    const database = new SqliteSearchD1();
    const { d1, log } = spied(database);
    const index = d1SearchIndex(d1);
    await index.migrate();
    database.database.exec("DROP TABLE sections_search");
    expect(await index.query(1, '"abc"', 5)).toEqual([]);
    expect(log).toEqual(["batch", "select", "batch", "select"]);
  });

  it("lets an older schema's reader reach the current schema: the new query fails on it, so ingest's migration is not needed first", async () => {
    const database = new SqliteSearchD1();
    database.database.exec(UNKEYED_SCHEMA);
    database.database.prepare("INSERT INTO sections VALUES (?, ?, ?, ?, ?)").run(5, "d".repeat(40), "old", "Old title", "indexed before the keys");
    const { d1, log } = spied(database);
    expect(await d1SearchIndex(d1).query(5, '"before"', 10)).toMatchObject([{ slug: "old" }]);
    expect(log).toEqual(["select", "batch", "select"]);
    expect(database.database.prepare("SELECT name FROM sqlite_master WHERE name = 'sections_fts'").all()).toEqual([]);
  });

  it("raises any other failure without migrating or retrying", async () => {
    const { d1, log } = spied(new SqliteSearchD1(), { select: new Error("D1_ERROR: D1 DB is overloaded: SQLITE_BUSY") });
    await expect(d1SearchIndex(d1).query(1, '"abc"', 5)).rejects.toThrow("overloaded");
    expect(log).toEqual(["select"]);
  });

  it("raises the retry's failure, and a failed migration, without looping", async () => {
    const missing = new Error("D1_ERROR: no such table: sections_search: SQLITE_ERROR");
    const stillMissing = spied(new SqliteSearchD1(), { select: missing });
    await expect(d1SearchIndex(stillMissing.d1).query(1, '"abc"', 5)).rejects.toThrow("no such table");
    expect(stillMissing.log).toEqual(["select", "batch", "select"]);

    const database = new SqliteSearchD1();
    const broken = spied(database, { batches: [new Error("D1_ERROR: migration failed")] });
    const index = d1SearchIndex(broken.d1);
    await expect(index.query(1, '"abc"', 5)).rejects.toThrow("migration failed");
    // The failure is not remembered: the next query migrates again and succeeds.
    expect(await index.query(1, '"abc"', 5)).toEqual([]);
    expect(broken.log).toEqual(["select", "batch", "select", "batch", "select"]);
  });

  it("still migrates before the write side's first statement", async () => {
    const database = new SqliteSearchD1();
    const { d1, log } = spied(database);
    const index = d1SearchIndex(d1);
    expect(await index.hasBlob(1, "a".repeat(40))).toBe(false);
    expect(log[0]).toBe("batch");
    await index.putBlob(1, "a".repeat(40), [section("intro", "Intro", "installation notes")]);
    expect(log.filter(entry => entry === "batch")).toHaveLength(2);
    expect(await d1SearchIndex(spied(new SqliteSearchD1()).d1).deleteRepo(1, 10)).toBe(0);
  });

  it("recognizes D1's and SQLite's wording of a missing table or column, and nothing else", () => {
    expect(isMissingSchema(new Error("D1_ERROR: no such table: sections_search: SQLITE_ERROR"))).toBe(true);
    expect(isMissingSchema(new Error("D1_ERROR: no such column: rk at offset 7: SQLITE_ERROR"))).toBe(true);
    expect(isMissingSchema(new Error("no such table: sections_search"))).toBe(true);
    expect(isMissingSchema(new Error("D1_ERROR: database is locked: SQLITE_BUSY"))).toBe(false);
    expect(isMissingSchema(new Error("D1_ERROR: fts5: syntax error near \"AND\": SQLITE_ERROR"))).toBe(false);
    expect(isMissingSchema("no such table")).toBe(false);
    expect(isMissingSchema(null)).toBe(false);
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
