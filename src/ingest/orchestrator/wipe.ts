/**
 * Deleting one repository's cached content (#263): every R2 object under its
 * prefix, its reconciliation entry and its search rows. Used for a removal
 * GitHub confirmed (#258), for idle expiry and before content is sealed again
 * (a repository made private, a rotated key, an object that did not open).
 *
 * The work is bounded per step and idempotent: a step lists from the start of
 * the prefix (deleted keys are gone from the listing), so a step that was cut
 * short is simply run again. The coordinator records progress durably and
 * resumes from its alarm.
 */
import type { SearchIndex } from "../../search/index";
import { repoPrefix, ROOT_PREFIX, trackedKey } from "./keys";
import type { ObjectStore } from "./store";

export type WipeReason =
  /** GitHub confirmed the app lost the repository: everything goes, the coordinator's state too. */
  | "removed"
  /** Nobody viewed the repository for the idle window: the next view ingests again. */
  | "idle"
  /** The stored content is not sealed the way the repository now needs (made private, key rotated, unreadable). */
  | "reseal";

export interface WipeProgress {
  reason: WipeReason;
  startedAt: number;
  objects: number;
  searchRows: number;
}

/** The audit record of a purged repository: outside its prefix, so it outlives the purge. IDs, times and counts only. */
export function purgeAuditKey(repoId: number, startedAt: number): string {
  // repoPrefix validates the ID.
  repoPrefix(repoId);
  return `${ROOT_PREFIX}audit/purge/${repoId}/${new Date(startedAt).toISOString()}.json`;
}

/** R2 lists and deletes at most 1,000 keys at once. */
export const WIPE_PAGE = 1_000;
/** Pages per step: at most 20,000 objects between two progress records. */
export const WIPE_PAGES_PER_STEP = 20;
export const SEARCH_ROWS_PER_BATCH = 500;
const SEARCH_BATCHES_PER_STEP = 20;

/**
 * One bounded step. The pointers and the reconciliation entry go first, so
 * readers stop finding the snapshot (a pointer miss, never a half-deleted
 * snapshot) and the cron stops checking the repository; then everything else.
 * Returns true once nothing is left.
 */
export async function wipeStep(store: ObjectStore, search: SearchIndex | undefined, repoId: number, progress: WipeProgress): Promise<boolean> {
  await store.delete([trackedKey(repoId)]);
  let budget = WIPE_PAGES_PER_STEP;
  for (const prefix of [`${repoPrefix(repoId)}ref/`, repoPrefix(repoId)]) {
    for (; budget > 0; budget -= 1) {
      const { keys } = await store.list(prefix);
      if (!keys.length) break;
      await store.delete(keys.slice(0, WIPE_PAGE));
      progress.objects += Math.min(keys.length, WIPE_PAGE);
    }
    if (budget === 0) return false;
  }
  if (!search) return true;
  for (let batch = 0; batch < SEARCH_BATCHES_PER_STEP; batch += 1) {
    const deleted = await search.deleteRepo(repoId, SEARCH_ROWS_PER_BATCH);
    progress.searchRows += deleted;
    if (deleted < SEARCH_ROWS_PER_BATCH) return true;
  }
  return false;
}
