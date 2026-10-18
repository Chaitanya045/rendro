import type { DurableStorageLike } from "../orchestrator/coordinator";

/** GitHub redelivers for up to three days; a settled delivery is remembered for a day longer. */
export const DELIVERY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 100;

/**
 * Webhook delivery dedupe in Durable Object storage, keyed by
 * `X-GitHub-Delivery` (redeliveries reuse it). Callers remember a delivery only
 * once its work has settled, so a failure stays retryable. Dedupe saves work;
 * the work itself must still be idempotent.
 */
export class DeliveryDedupe {
  constructor(private readonly storage: DurableStorageLike, private readonly retentionMs = DELIVERY_RETENTION_MS) {}

  async seen(id: string): Promise<boolean> {
    return await this.storage.get(`delivery:${id}`) !== undefined;
  }

  async remember(id: string, now: number): Promise<void> {
    await this.storage.put(`delivery:${id}`, now);
    await this.storage.put(`delivery-at:${timeKey(now)}:${id}`, id);
    const expired = await this.storage.list<string>({ prefix: "delivery-at:", end: `delivery-at:${timeKey(now - this.retentionMs)}`, limit: PRUNE_BATCH });
    if (expired.size > 0) await this.storage.delete([...expired.keys(), ...[...expired.values()].map((old) => `delivery:${old}`)]);
  }
}

function timeKey(ms: number): string {
  return String(Math.max(0, ms)).padStart(16, "0");
}
