/**
 * The ingest Worker (development and tests only; see wrangler.ingest.toml):
 * Queue consumer, reconciliation cron and the per-repository coordinator
 * Durable Object. It serves no routes; the webhook route arrives with P1.
 * entry.ts is the deployed module: it initializes the Markdown engine first.
 */
import { unconfiguredDeliveries } from "../github/deliveries";
import { HttpGitHubSource } from "../github/http-source";
import { staticTokenProvider } from "../github/token";
import { IngestCoordinator, type DurableStateLike } from "./coordinator";
import { coordinatorClient, type DurableObjectNamespaceLike } from "./coordinator-client";
import { consumeIngestBatch, type IngestLog, type MessageBatchLike } from "./consumer";
import type { IngestDependencies } from "./ingest";
import type { IngestMessage, QueueLike } from "./messages";
import { contentPipeline } from "./content-pipeline";
import { imageProxyRewriter } from "../../image-proxy";
import { reconcileHeads, redeliverFailedDeliveries } from "./reconcile";
import { plaintextSealer, r2Store, type R2BucketLike } from "./store";

export interface IngestWorkerEnv {
  INGEST_BUCKET: R2BucketLike;
  INGEST_QUEUE: QueueLike<IngestMessage>;
  INGEST_COORDINATOR: DurableObjectNamespaceLike;
  /** Development and tests: the REST origin of a fake GitHub. Defaults to api.github.com. */
  GITHUB_API_ORIGIN?: string;
  /** Comma-separated origins archive redirects may lead to. Defaults to codeload.github.com. */
  GITHUB_ARCHIVE_ORIGINS?: string;
  /** Development and tests only, until P1 mints installation tokens. */
  GITHUB_DEV_TOKEN?: string;
  /** Signs image proxy URLs in rendered pages (#224); the serving Worker's IMAGE_PROXY_SECRET. */
  IMAGE_PROXY_SECRET: string;
}

export function ingestDependencies(env: IngestWorkerEnv): IngestDependencies {
  const archiveOrigins = env.GITHUB_ARCHIVE_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean);
  return {
    source: new HttpGitHubSource({
      tokens: staticTokenProvider(env.GITHUB_DEV_TOKEN || null),
      apiOrigin: env.GITHUB_API_ORIGIN || undefined,
      archiveOrigins: archiveOrigins?.length ? archiveOrigins : undefined,
    }),
    store: r2Store(env.INGEST_BUCKET),
    sealer: plaintextSealer,
    pipeline: contentPipeline({ rewriteImageUrl: imageProxyRewriter(env.IMAGE_PROXY_SECRET) }),
    now: () => Date.now(),
  };
}

/** One instance per repository (named by GitHub repository ID). */
export class RepoIngestCoordinator {
  private readonly coordinator: IngestCoordinator;

  constructor(state: DurableStateLike, env: IngestWorkerEnv) {
    this.coordinator = new IngestCoordinator(state, ingestDependencies(env));
  }

  fetch(request: Request): Promise<Response> {
    return this.coordinator.fetch(request);
  }
}

/** Structured logs: IDs, branch names and outcomes only, never tokens or content. */
export const log: IngestLog = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatchLike, env: IngestWorkerEnv): Promise<void> {
    await consumeIngestBatch(batch, { coordinator: (repoId) => coordinatorClient(env.INGEST_COORDINATOR, repoId), now: () => Date.now(), log });
  },

  async scheduled(_controller: unknown, env: IngestWorkerEnv): Promise<void> {
    const store = r2Store(env.INGEST_BUCKET);
    const [heads, redelivery] = await Promise.allSettled([
      reconcileHeads({ store, coordinator: (repoId) => coordinatorClient(env.INGEST_COORDINATOR, repoId), queue: env.INGEST_QUEUE, log }),
      // P1 replaces this with HttpWebhookDeliveries and the app's JWT signer.
      redeliverFailedDeliveries({ store, deliveries: unconfiguredDeliveries, now: () => Date.now(), log }),
    ]);
    for (const [step, result] of [["heads", heads], ["redelivery", redelivery]] as const) {
      if (result.status === "fulfilled") log(`reconcile.${step}`, result.value);
      else log(`reconcile.${step}.error`, { error: result.reason instanceof Error ? result.reason.message : "unknown" });
    }
  },
};
