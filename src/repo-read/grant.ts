import type { RepoRecord } from "./access";

declare const issued: unique symbol;

/**
 * Proof that the current request may read `repo`. Snapshot reads take one,
 * so no code path can reach a private cache entry or storage object without
 * having authorized first. Only `authorize.ts` issues grants.
 */
export interface RepoGrant {
  readonly repo: RepoRecord;
  /** The signed-in reader: the read path grants no one else (#354). Typed `| null` only for the comment code (#353 removes its public branch). */
  readonly viewer: string | null;
  /** The reader's revocation epoch the grant rests on. */
  readonly epoch: number;
  /** Until when (ms) the authorization behind this grant holds without being decided again: the
   * capability's expiry. Comment access (#254) never outlives it. */
  readonly until: number;
  readonly [issued]: true;
}

export function issueGrant(repo: RepoRecord, viewer: string | null, epoch: number, until = 0): RepoGrant {
  return { repo, viewer, epoch, until } as RepoGrant;
}
