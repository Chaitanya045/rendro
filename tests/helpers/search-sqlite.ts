import { DatabaseSync, type SupportedValueType } from "node:sqlite";
import type { SearchD1, SearchD1Result, SearchD1Statement } from "../../src/search/d1";

/**
 * A SQLite double for the D1 binding (#251): real SQL, FTS5, snippet() and
 * bm25() through Node's built-in `node:sqlite`, wrapped in D1's API shape.
 * Covers the same semantics the workerd tests exercise against local D1, so
 * unit tests never need a cloud database.
 */
class SqliteStatement implements SearchD1Statement {
  private values: SupportedValueType[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]): SearchD1Statement {
    this.values = values as SupportedValueType[];
    return this;
  }
  all<T = unknown>(): Promise<SearchD1Result<T>> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) as T[] });
  }
  run(): Promise<unknown> {
    return Promise.resolve(this.database.prepare(this.sql).run(...this.values));
  }
}

export class SqliteSearchD1 implements SearchD1 {
  readonly database: DatabaseSync;

  constructor() {
    this.database = new DatabaseSync(":memory:");
  }

  prepare(sql: string): SearchD1Statement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: readonly SearchD1Statement[]): Promise<unknown[]> {
    this.database.exec("BEGIN");
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  exec(sql: string): Promise<unknown> {
    this.database.exec(sql);
    return Promise.resolve(null);
  }
}
