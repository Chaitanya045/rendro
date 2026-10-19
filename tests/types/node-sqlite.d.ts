/**
 * Minimal ambient types for `node:sqlite`, which @types/node (pinned to ^20)
 * does not declare. Only what tests/helpers/search-sqlite.ts uses. The runtime
 * floor is Node 22.13, where the module works without a flag.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    all(...anonymousParameters: SupportedValueType[]): Record<string, null | number | bigint | string>[];
    run(...anonymousParameters: SupportedValueType[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export type SupportedValueType = null | number | bigint | string;
  export class DatabaseSync {
    constructor(location?: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
