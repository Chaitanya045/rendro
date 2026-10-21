/**
 * The ingest Worker (development and tests only; see wrangler.ingest.toml):
 * Queue consumer, reconciliation cron and the per-repository coordinator
 * Durable Object. It serves no routes: the App's one webhook URL is the control
 * Worker's, and push ingress there is still open (#338).
 * entry.ts is the deployed module: it initializes the Markdown engine first.
 */
import { HttpWebhookDeliveries, unconfiguredDeliveries } from "../github/deliveries";
import { appJwtSigner, gitHubAppCredentials, mintedInstallationTokens, type GitHubAppCredentials, type MintingTokenProvider } from "../github/app-auth";
import { HttpGitHubSource } from "../github/http-source";
import { staticTokenProvider, type InstallationTokenProvider } from "../github/token";
import { IngestCoordinator, IDLE_EXPIRY_MS, type DurableStateLike } from "./coordinator";
import { coordinatorClient, type DurableObjectNamespaceLike } from "./coordinator-client";
import { consumeIngestBatch, type IngestLog, type MessageBatchLike } from "./consumer";
import type { IngestDependencies } from "./ingest";
import type { IngestMessage, QueueLike } from "./messages";
import { contentPipeline } from "./content-pipeline";
import { imageProxyRewriter } from "../../image-proxy";
import { d1SearchIndex, type SearchD1 } from "../../search/d1";
import { reconcileHeads, redeliverFailedDeliveries } from "./reconcile";
import { contentSealer } from "./sealing";
import { r2Store, type R2BucketLike } from "./store";

export interface IngestWorkerEnv {
  INGEST_BUCKET: R2BucketLike;
  INGEST_QUEUE: QueueLike<IngestMessage>;
  INGEST_COORDINATOR: DurableObjectNamespaceLike;
  /** Development and tests: the REST origin of a fake GitHub. Defaults to api.github.com. */
  GITHUB_API_ORIGIN?: string;
  /** Comma-separated origins archive redirects may lead to. Defaults to codeload.github.com. */
  GITHUB_ARCHIVE_ORIGINS?: string;
  /** The GitHub App's ID and private key (#338): installation tokens and the app JWT come from them. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Development and tests only: a static installation token where the App is not configured. */
  GITHUB_DEV_TOKEN?: string;
  /** Signs image proxy URLs in rendered pages (#224); the serving Worker's IMAGE_PROXY_SECRET. */
  IMAGE_PROXY_SECRET: string;
  /** Repository search index (#251). Development and tests only; P-deploy provisions it. */
  REPO_SEARCH?: SearchD1;
  /** Seals private-repository content (#263); the serving Worker's value. Without a valid one, private repositories are not ingested. */
  REPO_CONTENT_KEY?: string;
  /** During a key rotation: the previous key, which still opens content sealed before it. */
  REPO_CONTENT_KEY_PREVIOUS?: string;
  /** Tests only: the idle window in seconds (default 30 days). */
  REPO_IDLE_EXPIRY_SECONDS?: string;
}

/** The idle window: 30 days unless a test configures a positive number of seconds. */
export function idleWindowMs(env: IngestWorkerEnv): number {
  const seconds = Number(env.REPO_IDLE_EXPIRY_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : IDLE_EXPIRY_MS;
}

/**
 * One minting provider per isolate and App (#338), shared by every coordinator the isolate runs, so an installation's
 * token is minted once an hour, not once per repository. Tokens stay in memory: nothing is kept at rest here.
 */
const minted = new Map<string, MintingTokenProvider>();

function app(env: IngestWorkerEnv): GitHubAppCredentials | null {
  return gitHubAppCredentials(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
}

export function ingestTokens(env: IngestWorkerEnv): InstallationTokenProvider {
  const credentials = app(env);
  if (!credentials) return staticTokenProvider(env.GITHUB_DEV_TOKEN || null);
  const key = JSON.stringify([credentials.appId, credentials.privateKey, env.GITHUB_API_ORIGIN ?? ""]);
  let provider = minted.get(key);
  if (!provider) {
    provider = mintedInstallationTokens({ app: appJwtSigner(credentials), apiOrigin: env.GITHUB_API_ORIGIN || undefined });
    minted.set(key, provider);
  }
  return provider;
}

export function ingestDependencies(env: IngestWorkerEnv): IngestDependencies {
  const archiveOrigins = env.GITHUB_ARCHIVE_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean);
  return {
    source: new HttpGitHubSource({
      tokens: ingestTokens(env),
      apiOrigin: env.GITHUB_API_ORIGIN || undefined,
      archiveOrigins: archiveOrigins?.length ? archiveOrigins : undefined,
    }),
    store: r2Store(env.INGEST_BUCKET),
    sealer: contentSealer(env.REPO_CONTENT_KEY, env.REPO_CONTENT_KEY_PREVIOUS),
    pipeline: contentPipeline({ rewriteImageUrl: imageProxyRewriter(env.IMAGE_PROXY_SECRET) }),
    now: () => Date.now(),
    ...(env.REPO_SEARCH ? { search: d1SearchIndex(env.REPO_SEARCH) } : {}),
  };
}

export function webhookDeliveries(env: IngestWorkerEnv) {
  const credentials = app(env);
  return credentials ? new HttpWebhookDeliveries(appJwtSigner(credentials), { apiOrigin: env.GITHUB_API_ORIGIN || undefined }) : unconfiguredDeliveries;
}

/** One instance per repository (named by GitHub repository ID). */
export class RepoIngestCoordinator {
  private readonly coordinator: IngestCoordinator;

  constructor(state: DurableStateLike, env: IngestWorkerEnv) {
    this.coordinator = new IngestCoordinator(state, ingestDependencies(env), { idleMs: idleWindowMs(env), log });
  }

  fetch(request: Request): Promise<Response> {
    return this.coordinator.fetch(request);
  }

  alarm(): Promise<void> {
    return this.coordinator.alarm();
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
      // The App's delivery log, read with its JWT (#338); without the App there is nothing to redeliver.
      redeliverFailedDeliveries({ store, deliveries: webhookDeliveries(env), now: () => Date.now(), log }),
    ]);
    for (const [step, result] of [["heads", heads], ["redelivery", redelivery]] as const) {
      if (result.status === "fulfilled") log(`reconcile.${step}`, result.value);
      else log(`reconcile.${step}.error`, { error: result.reason instanceof Error ? result.reason.message : "unknown" });
    }
  },
};
