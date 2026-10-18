import type { RepoRecord } from "./access";

declare const issued: unique symbol;

/**
 * Proof that the current request may read `repo`. Snapshot reads take one,
 * so no code path can reach a private cache entry or storage object without
 * having authorized first. Only `authorize.ts` issues grants.
 */
export interface RepoGrant {
  readonly repo: RepoRecord;
  /** The reader, or null for an anonymous reader of a public repository. */
  readonly viewer: string | null;
  /** The reader's revocation epoch the grant rests on (0 for public reads). */
  readonly epoch: number;
  readonly [issued]: true;
}

export function issueGrant(repo: RepoRecord, viewer: string | null, epoch: number): RepoGrant {
  return { repo, viewer, epoch } as RepoGrant;
}
