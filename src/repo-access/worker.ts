/**
 * The control Worker (#243; development and tests only, see
 * wrangler.control.toml). It is the serving Worker's `REPO_ACCESS` service:
 *
 * - `POST https://repo-access.internal/v1/authorize`: `repoAccessHandler`
 *   over the access directory (the read path's permission source).
 * - `POST https://repo-access.internal/v1/accounts/link` and `/unlink`: where
 *   P1's sign-in hands over a user's GitHub identity and tokens.
 * - `POST /v1/github/webhook`: GitHub's permission events, verified and
 *   deduplicated like #229's push webhook.
 *
 * Internal endpoints answer only requests addressed to the internal host, which
 * only a service binding can send, so a public route added for the webhook
 * never exposes them. Tokens never appear in a response or a log line.
 */
import { isDeliveryId, readVerifiedWebhook } from "@/ingest/github/webhook";
import { staticTokenProvider } from "@/ingest/github/token";
import type { DurableObjectNamespaceLike } from "@/ingest/orchestrator/coordinator-client";
import { isOwnerLogin } from "@/ingest/orchestrator/messages";
import { parseRepoRecord, repoAccessHandler, RepoAccessUnavailable, type RepoPermissionSource } from "@/repo-read/access";
import { AccessDirectory, type DirectoryLog, type DirectoryState, type EpochStore } from "./directory";
import { planEvent } from "./events";
import { GitHubAccessClient } from "./github";
import { httpTokenRefresher, MIN_TOKEN_KEY_LENGTH, parseUserTokens, unconfiguredRefresher } from "./tokens";

export interface ControlWorkerEnv {
  REPO_ACCESS_DIRECTORY: DurableObjectNamespaceLike;
  /** The serving Worker's `REPO_EPOCHS` namespace: this Worker writes, the serving Worker reads. */
  REPO_EPOCHS: EpochStore;
  /** The GitHub App's webhook secret (P1). */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Dedicated AES-GCM key secret for stored user tokens; never shared with another secret. */
  GITHUB_TOKEN_KEY?: string;
  /** The GitHub App's OAuth client (P1); without it expired user tokens cannot be renewed (503). */
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** Development and tests: a fake GitHub's REST and web origins. */
  GITHUB_API_ORIGIN?: string;
  GITHUB_WEB_ORIGIN?: string;
  /** Development and tests only, until P1 mints installation tokens. */
  GITHUB_DEV_TOKEN?: string;
}

export const INTERNAL_HOST = "repo-access.internal";
const DIRECTORY_URL = "https://directory";

/** Structured logs: event names, counts and outcomes only. */
export const log: DirectoryLog = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};

function directory(env: ControlWorkerEnv) {
  const namespace = env.REPO_ACCESS_DIRECTORY;
  return namespace.get(namespace.idFromName("directory"));
}

/** The permission source the read path calls, answered by the directory object. */
export function directorySource(env: ControlWorkerEnv): RepoPermissionSource {
  return {
    async authorize(viewer, owner, name) {
      const response = await directory(env).fetch(`${DIRECTORY_URL}/authorize`, { method: "POST", body: JSON.stringify({ viewer, owner, name }) });
      if (response.status === 404) return null;
      const repo = response.ok ? parseRepoRecord((await response.json() as { repo?: unknown }).repo) : null;
      if (!repo) throw new RepoAccessUnavailable();
      return repo;
    },
  };
}

function validSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= MIN_TOKEN_KEY_LENGTH;
}

function validUserId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

async function accounts(request: Request, env: ControlWorkerEnv, path: "link" | "unlink"): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!validUserId(body?.userId)) return Response.json({ error: "Malformed request" }, { status: 400 });
  let forward: Record<string, unknown> = { userId: body.userId };
  if (path === "link") {
    const tokens = parseUserTokens(body.tokens);
    if (!Number.isSafeInteger(body.githubId) || (body.githubId as number) <= 0 || !isOwnerLogin(body.login) || !tokens) {
      return Response.json({ error: "Malformed request" }, { status: 400 });
    }
    forward = { userId: body.userId, githubId: body.githubId, login: body.login, tokens };
  }
  const response = await directory(env).fetch(`${DIRECTORY_URL}/${path}`, { method: "POST", body: JSON.stringify(forward) });
  return new Response(null, { status: response.status === 204 ? 204 : 503 });
}

async function webhook(request: Request, env: ControlWorkerEnv): Promise<Response> {
  // Without a secret nothing can be verified: answer 503, so GitHub records a failure the reconciler can redeliver.
  if (!env.GITHUB_WEBHOOK_SECRET) return new Response(null, { status: 503 });
  const verified = await readVerifiedWebhook(request, env.GITHUB_WEBHOOK_SECRET);
  if (verified instanceof Response) return verified;
  if (!isDeliveryId(verified.deliveryId)) return new Response(null, { status: 400 });
  const plan = planEvent(verified.event, verified.payload);
  if (plan === "ignored") return new Response(null, { status: 204 });
  if (plan === "malformed") {
    log("access.webhook-malformed", { event: verified.event as string });
    return new Response(null, { status: 400 });
  }
  const response = await directory(env).fetch(`${DIRECTORY_URL}/webhook`, { method: "POST", body: JSON.stringify({ deliveryId: verified.deliveryId, plan }) });
  // Not applied: a 5xx makes GitHub record the delivery as failed, so it can be redelivered.
  if (!response.ok) return new Response(null, { status: 503 });
  const { status } = await response.json() as { status: string };
  return new Response(null, { status: status === "duplicate" ? 200 : 202 });
}

export default {
  async fetch(request: Request, env: ControlWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === INTERNAL_HOST) {
      if (url.pathname === "/v1/authorize") return repoAccessHandler(directorySource(env))(request);
      if (url.pathname === "/v1/accounts/link") return accounts(request, env, "link");
      if (url.pathname === "/v1/accounts/unlink") return accounts(request, env, "unlink");
    } else if (url.pathname === "/v1/github/webhook") {
      return webhook(request, env);
    }
    return new Response(null, { status: 404 });
  },
};

/** The single directory instance (named "directory"): registry, mirrors and the epoch outbox. */
export class RepoAccessDirectory {
  private readonly directory: AccessDirectory | null;

  constructor(state: DirectoryState, env: ControlWorkerEnv) {
    const tokenKey = env.GITHUB_TOKEN_KEY;
    // A missing or reused key leaves stored tokens unusable: everything that needs them is unavailable (503).
    this.directory = validSecret(tokenKey) && tokenKey !== env.GITHUB_WEBHOOK_SECRET && tokenKey !== env.GITHUB_APP_CLIENT_SECRET
      ? new AccessDirectory(state, {
        github: new GitHubAccessClient({ apiOrigin: env.GITHUB_API_ORIGIN || undefined }),
        installationTokens: staticTokenProvider(env.GITHUB_DEV_TOKEN || null),
        refresher: env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
          ? httpTokenRefresher({ clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET, webOrigin: env.GITHUB_WEB_ORIGIN || undefined, now: () => Date.now() })
          : unconfiguredRefresher,
        tokenKey, epochs: env.REPO_EPOCHS, now: () => Date.now(), log,
      })
      : null;
  }

  fetch(request: Request): Promise<Response> {
    if (!this.directory) return Promise.resolve(Response.json({ error: "Unavailable" }, { status: 503 }));
    return this.directory.fetch(request);
  }

  alarm(): Promise<void> {
    return this.directory ? this.directory.alarm() : Promise.resolve();
  }
}
