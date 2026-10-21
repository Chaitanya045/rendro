/**
 * The control Worker (#243; development and tests only, see
 * wrangler.control.toml). It is the serving Worker's `REPO_ACCESS` service:
 *
 * - `POST /v1/authorize`: `repoAccessHandler` over the access directory (the
 *   read path's permission source).
 * - `POST /v1/moderation`: the role that lets a reader moderate a repository's
 *   comments (#259), from the same mirror.
 * - `POST /v1/accounts/link` and `/unlink`: where GitHub sign-in hands over a
 *   user's GitHub identity and tokens (#338), and `/refresh`: the user just
 *   installed the app, so their mirror is listed again on its next use; and
 *   `/repositories`: what their home lists, from the mirror.
 * - `POST /v1/github/webhook`: GitHub's permission events, verified and
 *   deduplicated like #229's push webhook.
 *
 * The internal endpoints are served only by the named entrypoint
 * `RepoAccessService` (#295). A named entrypoint is reachable only through a
 * service binding that names it (`entrypoint = "RepoAccessService"`), never
 * over HTTP, whatever the host: the default handler, which a public route for
 * the webhook would expose, serves the webhook alone. Tokens never appear in a
 * response or a log line.
 */
import { isDeliveryId, readVerifiedWebhook } from "@/ingest/github/webhook";
import { appJwtSigner, gitHubAppCredentials, mintedInstallationTokens } from "@/ingest/github/app-auth";
import { staticTokenProvider } from "@/ingest/github/token";
import type { DurableObjectNamespaceLike } from "@/ingest/orchestrator/coordinator-client";
import { isOwnerLogin } from "@/ingest/orchestrator/messages";
import { parseRepoRecord, repoAccessHandler, RepoAccessUnavailable, isModerationRole, repoModerationHandler, type RepoModerationSource, type RepoPermissionSource } from "@/repo-read/access";
import { convexCommentSink } from "./comments";
import { coordinatorContentPurge } from "./content";
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
  /** The GitHub App's ID and private key (#338): installation tokens are minted from them. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Development and tests only: a static installation token where the App is not configured. */
  GITHUB_DEV_TOKEN?: string;
  /** Comments on repository docs (#254): Convex, told about every epoch and removed repository. Optional. */
  CONVEX_URL?: string;
  CONVEX_INTERNAL_SECRET?: string;
  /**
   * Optional (#263): the ingest Worker's per-repository coordinators. A removal GitHub confirmed then
   * deletes the repository's cached R2 content and search rows too.
   */
  REPO_INGEST?: DurableObjectNamespaceLike;
}

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

/** The role lookup the comment grants call (#259), answered by the directory object. */
export function directoryModeration(env: ControlWorkerEnv): RepoModerationSource {
  return {
    async moderationRole(viewer, owner, name) {
      const response = await directory(env).fetch(`${DIRECTORY_URL}/moderation`, { method: "POST", body: JSON.stringify({ viewer, owner, name }) });
      const role = response.ok ? (await response.json() as { role?: unknown }).role : undefined;
      if (role !== null && !isModerationRole(role)) throw new RepoAccessUnavailable();
      return role;
    },
  };
}

function validSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= MIN_TOKEN_KEY_LENGTH;
}

function validUserId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

async function accounts(request: Request, env: ControlWorkerEnv, path: "link" | "unlink" | "refresh"): Promise<Response> {
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

/** A reader's home (#338): the repositories their mirror lists. 200 `HomeListing`, 503 when GitHub cannot be asked. */
async function repositories(request: Request, env: ControlWorkerEnv): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!validUserId(body?.userId)) return Response.json({ error: "Malformed request" }, { status: 400 });
  const response = await directory(env).fetch(`${DIRECTORY_URL}/repositories`, { method: "POST", body: JSON.stringify({ userId: body.userId }) });
  return response.ok ? Response.json(await response.json()) : Response.json({ error: "Unavailable" }, { status: 503 });
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

/** The default handler: what any route or caller without the entrypoint reaches. The webhook only. */
export default {
  async fetch(request: Request, env: ControlWorkerEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/v1/github/webhook") return webhook(request, env);
    return new Response(null, { status: 404 });
  },
};

/** The internal endpoints, for service bindings that name this entrypoint (`entrypoint = "RepoAccessService"`). Any host. */
export const RepoAccessService = {
  async fetch(request: Request, env: ControlWorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/authorize") return repoAccessHandler(directorySource(env))(request);
    if (pathname === "/v1/moderation") return repoModerationHandler(directoryModeration(env))(request);
    if (pathname === "/v1/accounts/link") return accounts(request, env, "link");
    if (pathname === "/v1/accounts/unlink") return accounts(request, env, "unlink");
    if (pathname === "/v1/accounts/refresh") return accounts(request, env, "refresh");
    if (pathname === "/v1/accounts/repositories") return repositories(request, env);
    return new Response(null, { status: 404 });
  },
};

/**
 * Installation tokens minted from the App's key and kept sealed in the directory's storage (#338); without the
 * App, development and tests use `GITHUB_DEV_TOKEN` (or none).
 */
function installationTokens(state: DirectoryState, env: ControlWorkerEnv, tokenKey: string) {
  const app = gitHubAppCredentials(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  if (!app) return staticTokenProvider(env.GITHUB_DEV_TOKEN || null);
  return mintedInstallationTokens({ app: appJwtSigner(app), apiOrigin: env.GITHUB_API_ORIGIN || undefined, store: { storage: state.storage, secret: tokenKey } });
}

/** The single directory instance (named "directory"): registry, mirrors and the epoch outbox. */
export class RepoAccessDirectory {
  private readonly directory: AccessDirectory | null;

  constructor(state: DirectoryState, env: ControlWorkerEnv) {
    const tokenKey = env.GITHUB_TOKEN_KEY;
    // A missing or reused key leaves stored tokens unusable: everything that needs them is unavailable (503).
    this.directory = validSecret(tokenKey) && tokenKey !== env.GITHUB_WEBHOOK_SECRET && tokenKey !== env.GITHUB_APP_CLIENT_SECRET
      ? new AccessDirectory(state, {
        github: new GitHubAccessClient({ apiOrigin: env.GITHUB_API_ORIGIN || undefined }),
        installationTokens: installationTokens(state, env, tokenKey),
        refresher: env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
          ? httpTokenRefresher({ clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET, webOrigin: env.GITHUB_WEB_ORIGIN || undefined, now: () => Date.now() })
          : unconfiguredRefresher,
        tokenKey, epochs: env.REPO_EPOCHS, now: () => Date.now(), log,
        // Without both, comment grants end with their own lifetime (at most five minutes) instead of with the epoch.
        comments: env.CONVEX_URL && validSecret(env.CONVEX_INTERNAL_SECRET) ? convexCommentSink(env.CONVEX_URL, env.CONVEX_INTERNAL_SECRET) : undefined,
        content: env.REPO_INGEST ? coordinatorContentPurge(env.REPO_INGEST) : undefined,
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
