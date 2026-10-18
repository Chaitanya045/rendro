import { NotConfiguredError, type WebhookDelivery, type WebhookDeliveries } from "../github/deliveries";
import { workPool } from "./concurrency";
import type { TrackedRepo } from "./coordinator";
import type { CoordinatorClient } from "./coordinator-client";
import type { IngestLog } from "./consumer";
import { REDELIVERY_CHECKPOINT_KEY, TRACKED_PREFIX } from "./keys";
import { parseRepoRef, type IngestMessage, type QueueLike } from "./messages";
import { readJson, writeJson, type ObjectStore } from "./store";

export interface ReconcileDependencies {
  store: ObjectStore;
  coordinator(repoId: number): CoordinatorClient;
  queue: QueueLike<IngestMessage>;
  log: IngestLog;
  concurrency?: number;
}

/**
 * Cron step 1: catch pushes no webhook announced (GitHub sends none for some
 * bulk pushes, and deliveries fail). Each tracked repository's coordinator
 * re-checks its branch heads with ETags; a head that differs from the served
 * commit is queued like a push.
 */
export async function reconcileHeads(deps: ReconcileDependencies): Promise<{ repos: number; enqueued: number; rateLimited: number }> {
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await deps.store.list(TRACKED_PREFIX, cursor);
    keys.push(...page.keys);
    cursor = page.cursor;
  } while (cursor);

  const totals = { repos: 0, enqueued: 0, rateLimited: 0 };
  await workPool(keys, deps.concurrency ?? 4, async (key) => {
    const repo = parseRepoRef((await readJson<TrackedRepo>(deps.store, key))?.value.repo);
    if (!repo) {
      deps.log("reconcile.tracked.invalid", { key });
      return;
    }
    totals.repos += 1;
    let outcome;
    try {
      outcome = await deps.coordinator(repo.id).reconcile(repo);
    } catch (error) {
      deps.log("reconcile.coordinator.error", { repoId: repo.id, error: error instanceof Error ? error.message : "unknown" });
      return;
    }
    if (outcome.retryAt !== null) totals.rateLimited += 1;
    for (const { branch, sha } of outcome.stale) {
      await deps.queue.send({ v: 1, repo, branch, sha, deliveryId: null, reason: "reconcile" });
      totals.enqueued += 1;
    }
  });
  return totals;
}

export interface RedeliveryDependencies {
  store: ObjectStore;
  deliveries: WebhookDeliveries;
  now: () => number;
  log: IngestLog;
  maxPages?: number;
  /** Redelivery is a write; GitHub's content-creation limit is 80 per minute. */
  maxRedeliveries?: number;
  /** Stop redelivering a delivery that failed this many times; our endpoint rejects it for a reason. */
  maxAttempts?: number;
}

const DAY = 24 * 60 * 60 * 1000;
/** GitHub redelivers deliveries from the past three days; stay clear of the edge. */
const WINDOW = 3 * DAY - 10 * 60 * 1000;
const OVERLAP = 60 * 60 * 1000;

interface Checkpoint {
  since: number;
}

/**
 * Cron step 2: redeliver webhooks whose latest attempt failed. Deliveries are
 * grouped by GUID (X-GitHub-Delivery), so a failure that a later attempt
 * fixed is left alone, and the ingest side dedupes by the same GUID.
 */
export async function redeliverFailedDeliveries(deps: RedeliveryDependencies): Promise<{ redelivered: number; complete: boolean; skipped: string | null }> {
  const now = deps.now();
  const checkpoint = await readJson<Checkpoint>(deps.store, REDELIVERY_CHECKPOINT_KEY);
  const windowStart = Math.max(now - WINDOW, (checkpoint?.value.since ?? 0) - OVERLAP);
  const attempts = new Map<string, WebhookDelivery[]>();
  let cursor: string | null = null;
  let complete = false;
  try {
    for (let page = 0; page < (deps.maxPages ?? 10); page += 1) {
      const { deliveries, next } = await deps.deliveries.list(cursor);
      for (const delivery of deliveries) {
        if (delivery.deliveredAt < windowStart) continue;
        attempts.set(delivery.guid, [...attempts.get(delivery.guid) ?? [], delivery]);
      }
      if (!next || deliveries.length === 0 || deliveries.some((delivery) => delivery.deliveredAt < windowStart)) {
        complete = true;
        break;
      }
      cursor = next;
    }
  } catch (error) {
    if (error instanceof NotConfiguredError) return { redelivered: 0, complete: false, skipped: "not-configured" };
    throw error;
  }

  const failed: WebhookDelivery[] = [];
  for (const group of attempts.values()) {
    const latest = group.reduce((a, b) => (b.deliveredAt > a.deliveredAt ? b : a));
    if (latest.statusCode >= 200 && latest.statusCode < 400) continue;
    if (group.length >= (deps.maxAttempts ?? 3)) {
      deps.log("redelivery.gave-up", { guid: latest.guid, attempts: group.length, status: latest.statusCode });
      continue;
    }
    failed.push(latest);
  }
  failed.sort((a, b) => a.deliveredAt - b.deliveredAt);
  const batch = failed.slice(0, deps.maxRedeliveries ?? 20);
  let redelivered = 0;
  for (const delivery of batch) {
    await deps.deliveries.redeliver(delivery.id);
    redelivered += 1;
  }
  // Move the window forward only when everything in it was seen and handled.
  if (complete && batch.length === failed.length) await writeJson(deps.store, REDELIVERY_CHECKPOINT_KEY, { since: now } satisfies Checkpoint);
  return { redelivered, complete, skipped: null };
}
