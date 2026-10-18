import type { CoordinatorClient } from "./coordinator-client";
import { parseIngestMessage } from "./messages";

/** The subset of the Workers Queue message API used here. */
export interface QueueMessageLike {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatchLike {
  readonly messages: readonly QueueMessageLike[];
}

export type IngestLog = (event: string, fields: Record<string, unknown>) => void;

export interface ConsumerDependencies {
  coordinator(repoId: number): CoordinatorClient;
  now: () => number;
  log: IngestLog;
  /** Re-checks of a push whose commit GitHub did not report as the head yet. */
  staleHintRetries?: number;
}

/** Queues accept delays up to 12 hours. */
const MAX_DELAY_SECONDS = 12 * 60 * 60;
const STALE_HINT_DELAY_SECONDS = 15;

export function backoffSeconds(attempts: number): number {
  return Math.min(10 * 2 ** Math.max(0, attempts - 1), 60 * 60);
}

function delayUntil(retryAt: number, now: number): number {
  return Math.min(MAX_DELAY_SECONDS, Math.max(1, Math.ceil((retryAt - now) / 1000)));
}

/**
 * Queue consumer: every message goes to its repository's coordinator, which
 * serializes and deduplicates. Outcomes map to ack or delayed retry; a
 * malformed message is dropped, never retried.
 */
export async function consumeIngestBatch(batch: MessageBatchLike, deps: ConsumerDependencies): Promise<void> {
  const staleHintRetries = deps.staleHintRetries ?? 2;
  await Promise.all(batch.messages.map(async (message) => {
    const body = parseIngestMessage(message.body);
    if (!body) {
      deps.log("ingest.message.invalid", { id: message.id });
      message.ack();
      return;
    }
    const fields = { id: message.id, repoId: body.repo.id, branch: body.branch, reason: body.reason, attempts: message.attempts };
    let outcome;
    try {
      outcome = await deps.coordinator(body.repo.id).ingest(body);
    } catch (error) {
      // The coordinator crashed, was evicted or is overloaded. Nothing partial is ever served; retry.
      deps.log("ingest.coordinator.error", { ...fields, error: error instanceof Error ? error.message : "unknown" });
      message.retry({ delaySeconds: backoffSeconds(message.attempts) });
      return;
    }
    deps.log("ingest.outcome", { ...fields, ...outcome });
    if (outcome.status === "failed") {
      if (outcome.permanent) message.ack();
      else message.retry({ delaySeconds: outcome.retryAt ? delayUntil(outcome.retryAt, deps.now()) : backoffSeconds(message.attempts) });
      return;
    }
    // GitHub's ref API can briefly lag the push that announced a commit; look again shortly.
    if ((outcome.status === "flipped" || outcome.status === "current") && outcome.staleHint && message.attempts <= staleHintRetries) {
      message.retry({ delaySeconds: STALE_HINT_DELAY_SECONDS });
      return;
    }
    message.ack();
  }));
}
