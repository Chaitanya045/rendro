/**
 * Everything production needs, per deployable (#333): the one source of truth for `pnpm preflight:prod`
 * and the production steps in docs/SETUP.md.
 *
 * `tests/production-manifest.test.ts` keeps it in sync with the code: every binding, secret or env var a
 * deployable reads must be listed here, and everything listed here that is read through `env` must still be
 * read. Names only: never put a secret value in this file.
 *
 * - `required`: production is broken or degraded without it; preflight fails while it is missing.
 * - `optional`: read by the code, but production works without it (a rotation, a diagnostic default).
 * - `forbidden`: development and tests only; preflight fails if production sets it.
 *
 * `doc` points at the section that explains the item, relative to docs/.
 */

export type Need = "required" | "optional" | "forbidden";
export type DeployableKey = "serving" | "ingest" | "control";

interface Base { need: Need; purpose: string; doc: string }

/** A string setting: a Wrangler secret, a `[vars]` entry, or either (the code cannot tell them apart). */
export interface Setting extends Base { kind: "secret" | "var" | "var-or-secret"; name: string; value?: string }

export type Binding = Base & { name: string } & (
  | { kind: "assets" }
  | { kind: "r2"; bucket: string; sameAs?: { deployable: DeployableKey; binding: string } }
  | { kind: "kv"; namespace: string; sameAs?: { deployable: DeployableKey; binding: string } }
  | { kind: "d1"; database: string; sameAs?: { deployable: DeployableKey; binding: string } }
  | { kind: "queue-producer"; queue: string }
  /** A Durable Object binding. Without `script` the class is this Worker's own and needs a migration. */
  | { kind: "durable-object"; className: string; script?: DeployableKey }
  | { kind: "service"; service: DeployableKey; entrypoint: string }
  | { kind: "ratelimit"; limit: number; period: number }
  | { kind: "analytics"; dataset: string }
);

/** Wiring that is not read through `env`: handlers, schedules and public addresses. */
export type Wiring = Base & (
  /** Consumes the queue the `producer` binding sends to; `deadLetterQueue` is the name to create. */
  | { kind: "queue-consumer"; producer: string; deadLetterQueue: string }
  | { kind: "cron"; schedule: string }
  /** Attached in the dashboard or as a `custom_domain` route; preflight can only confirm the latter. */
  | { kind: "custom-domain"; pattern: string }
  /** A zone route whose path must be exactly `path`. */
  | { kind: "route"; path: string }
  | { kind: "workers-dev"; enabled: boolean }
);

export interface WorkerDeployable {
  title: string;
  /** The production Worker's name (`wrangler secret list --name`). */
  worker: string;
  config: string;
  /** The wrangler environment production deploys: null for the top level. */
  env: string | null;
  deploy: string;
  /** Module graph roots for the sync test. */
  entry: string;
  /** Named exports Wrangler must find on the main module: Durable Object classes and entrypoints. */
  exports: string[];
  settings: Setting[];
  bindings: Binding[];
  wiring: Wiring[];
}

export interface ConvexDeployable {
  title: string;
  deployment: "prod";
  /** Glob of the modules Convex deploys; the sync test walks their imports. */
  entries: string;
  /** Set by Convex itself on every deployment; never listed as missing or unused. */
  builtIn: string[];
  settings: (Base & { name: string })[];
}

const ENV_WORKERS = "TECHNICAL.md#environment-variables-workers";
const READ_PATH = "TECHNICAL.md#bindings-and-configuration";
const INGEST = "TECHNICAL.md#ingest-worker-and-bindings-development-and-tests-only";
const CONTROL = "TECHNICAL.md#bindings-and-configuration-development-and-tests-only";
const RUM = "TECHNICAL.md#post-rum";
const CONVEX = "TECHNICAL.md#environment-variables-convex";
const GITHUB_SIGN_IN = "TECHNICAL.md#github-sign-in-p1";
const APP_TOKENS = "TECHNICAL.md#installation-tokens";

const serving: WorkerDeployable = {
  title: "Serving Worker",
  worker: "rendro",
  config: "wrangler.toml",
  env: null,
  deploy: "pnpm run deploy",
  entry: "src/worker.ts",
  exports: [],
  settings: [
    { kind: "secret", name: "CONVEX_INTERNAL_SECRET", need: "required", purpose: "Signs the client IP for Convex and authorizes internal Convex calls; equals the Convex value", doc: ENV_WORKERS },
    { kind: "secret", name: "IMAGE_PROXY_SECRET", need: "required", purpose: "Verifies /img/ proxy signatures; equals the ingest Worker's value", doc: ENV_WORKERS },
    { kind: "secret", name: "REPO_CAPABILITY_SECRET", need: "required", purpose: "Signs repository capability cookies and asset tickets; serving Worker only", doc: ENV_WORKERS },
    { kind: "secret", name: "REPO_CONTENT_KEY", need: "required", purpose: "Opens sealed private-repository content; equals the ingest Worker's value", doc: ENV_WORKERS },
    { kind: "secret", name: "REPO_CONTENT_KEY_PREVIOUS", need: "optional", purpose: "The previous content key, during a key rotation only", doc: "TECHNICAL.md#key-rotation" },
    { kind: "var-or-secret", name: "CONVEX_URL", need: "required", purpose: "Convex deployment URL; without it sign-in and comments are off", doc: ENV_WORKERS },
    { kind: "var-or-secret", name: "CONVEX_SITE_URL", need: "optional", purpose: "Convex HTTP actions origin; derived from CONVEX_URL when unset", doc: ENV_WORKERS },
    { kind: "var", name: "NODE_ENV", value: "production", need: "required", purpose: "Production mode: JSON logs at info level", doc: ENV_WORKERS },
    { kind: "var", name: "LOG_LEVEL", need: "optional", purpose: "Pino log level; defaults to info in production", doc: ENV_WORKERS },
    { kind: "var", name: "SITE_URL", need: "optional", purpose: "Canonical origin for write admission and beacons; defaults to the request origin", doc: RUM },
    { kind: "var", name: "GITHUB_APP_CLIENT_ID", need: "required", purpose: "The GitHub App's OAuth client ID; without it the pages offer email sign-in only", doc: GITHUB_SIGN_IN },
    { kind: "var", name: "GITHUB_APP_SLUG", need: "required", purpose: "The GitHub App's URL slug: the home links to its installation page", doc: "TECHNICAL.md#the-home-repository-list" },
    { kind: "var", name: "AUTH_EMAIL_SIGN_IN", need: "optional", purpose: "\"off\" makes sign-in GitHub-only (the same value in Convex); default on", doc: GITHUB_SIGN_IN },
    { kind: "var", name: "REPO_SHARED_CACHE_DEBUG", need: "forbidden", purpose: "Development diagnostic that exposes shared-cache headers", doc: ENV_WORKERS },
  ],
  bindings: [
    { kind: "assets", name: "ASSETS", need: "required", purpose: "Static assets (bundles, fonts, styles, favicons)", doc: "TECHNICAL.md#public-static-assets" },
    { kind: "r2", name: "REPO_CONTENT", bucket: "rendro-ingest", sameAs: { deployable: "ingest", binding: "INGEST_BUCKET" }, need: "required", purpose: "Rendered repository snapshots: the ingest Worker's bucket", doc: READ_PATH },
    { kind: "kv", name: "REPO_EPOCHS", namespace: "rendro-repo-epochs", sameAs: { deployable: "control", binding: "REPO_EPOCHS" }, need: "required", purpose: "Revocation epochs the control Worker writes", doc: READ_PATH },
    { kind: "service", name: "REPO_ACCESS", service: "control", entrypoint: "RepoAccessService", need: "required", purpose: "The permission source; without the entrypoint every check is a 503", doc: READ_PATH },
    { kind: "d1", name: "REPO_SEARCH", database: "rendro-repo-search", sameAs: { deployable: "ingest", binding: "REPO_SEARCH" }, need: "required", purpose: "Repository search; without it the search URL is a 404", doc: READ_PATH },
    { kind: "durable-object", name: "REPO_INGEST", className: "RepoIngestCoordinator", script: "ingest", need: "required", purpose: "First views and idle expiry ask the ingest coordinators", doc: "TECHNICAL.md#first-view-ingest-on-first-visit-242" },
    { kind: "ratelimit", name: "FIRST_VIEW_LIMIT", limit: 20, period: 60, need: "required", purpose: "First views of non-default branches; without it they are refused", doc: "TECHNICAL.md#first-view-admission-294" },
    { kind: "ratelimit", name: "SEARCH_LIMIT", limit: 60, period: 60, need: "required", purpose: "Per-client search rate; without it searches are not limited per client", doc: READ_PATH },
    { kind: "ratelimit", name: "RUM_LIMIT", limit: 60, period: 60, need: "required", purpose: "Beacon rate limit; without it /rum drops every beacon", doc: RUM },
    { kind: "analytics", name: "RUM_ANALYTICS", dataset: "rendro_rum", need: "required", purpose: "Real-user monitoring dataset; needs Analytics Engine enabled on the account", doc: RUM },
  ],
  wiring: [
    { kind: "custom-domain", pattern: "rendro.app", need: "required", purpose: "The web app's address", doc: "TECHNICAL.md#production-urls" },
  ],
};

const ingest: WorkerDeployable = {
  title: "Ingest Worker",
  worker: "rendro-ingest",
  config: "wrangler.ingest.toml",
  env: null,
  deploy: "pnpm exec wrangler deploy --config wrangler.ingest.toml",
  entry: "src/ingest/orchestrator/entry.ts",
  exports: ["RepoIngestCoordinator"],
  settings: [
    { kind: "secret", name: "IMAGE_PROXY_SECRET", need: "required", purpose: "Signs image proxy URLs in rendered pages; equals the serving Worker's value", doc: INGEST },
    { kind: "secret", name: "REPO_CONTENT_KEY", need: "required", purpose: "Seals private-repository content; without it private repositories are not ingested", doc: INGEST },
    { kind: "secret", name: "REPO_CONTENT_KEY_PREVIOUS", need: "optional", purpose: "The previous content key, during a key rotation only", doc: "TECHNICAL.md#key-rotation" },
    { kind: "var", name: "GITHUB_APP_ID", need: "required", purpose: "The GitHub App's ID: the issuer of its JWT, for installation tokens and redelivery", doc: APP_TOKENS },
    { kind: "secret", name: "GITHUB_APP_PRIVATE_KEY", need: "required", purpose: "The GitHub App's private key (PEM); signs the app JWT", doc: APP_TOKENS },
    { kind: "secret", name: "GITHUB_DEV_TOKEN", need: "forbidden", purpose: "A static installation token for development and tests, where the App is not configured", doc: INGEST },
    { kind: "var", name: "GITHUB_API_ORIGIN", need: "forbidden", purpose: "Points the client at a fake GitHub (tests)", doc: INGEST },
    { kind: "var", name: "GITHUB_ARCHIVE_ORIGINS", need: "forbidden", purpose: "Archive redirect origins of a fake GitHub (tests)", doc: INGEST },
    { kind: "var", name: "REPO_IDLE_EXPIRY_SECONDS", need: "forbidden", purpose: "Shortens the 30-day idle window (tests)", doc: INGEST },
  ],
  bindings: [
    { kind: "r2", name: "INGEST_BUCKET", bucket: "rendro-ingest", need: "required", purpose: "Content cache under gh/v1/", doc: INGEST },
    { kind: "queue-producer", name: "INGEST_QUEUE", queue: "rendro-ingest", need: "required", purpose: "One message per branch to bring up to date", doc: INGEST },
    { kind: "durable-object", name: "INGEST_COORDINATOR", className: "RepoIngestCoordinator", need: "required", purpose: "One coordinator per repository: single flight and dedupe", doc: INGEST },
    { kind: "d1", name: "REPO_SEARCH", database: "rendro-repo-search", need: "required", purpose: "The search index; without it ingest skips indexing", doc: INGEST },
  ],
  wiring: [
    { kind: "queue-consumer", producer: "INGEST_QUEUE", deadLetterQueue: "rendro-ingest-dlq", need: "required", purpose: "Consumes INGEST_QUEUE; failed messages go to the dead-letter queue", doc: INGEST },
    { kind: "cron", schedule: "*/10 * * * *", need: "required", purpose: "Re-checks branch heads and redelivers failed webhooks", doc: INGEST },
    { kind: "workers-dev", enabled: false, need: "required", purpose: "No public URL: the ingest Worker serves no routes", doc: INGEST },
  ],
};

const control: WorkerDeployable = {
  title: "Control Worker",
  worker: "rendro-control",
  config: "wrangler.control.toml",
  env: null,
  deploy: "pnpm exec wrangler deploy --config wrangler.control.toml",
  entry: "src/repo-access/entry.ts",
  exports: ["RepoAccessDirectory", "RepoAccessService"],
  settings: [
    { kind: "secret", name: "GITHUB_TOKEN_KEY", need: "required", purpose: "Seals stored user tokens; dedicated, never reused", doc: CONTROL },
    { kind: "secret", name: "GITHUB_WEBHOOK_SECRET", need: "required", purpose: "Verifies the GitHub App's webhook deliveries", doc: CONTROL },
    { kind: "secret", name: "GITHUB_APP_CLIENT_SECRET", need: "required", purpose: "Token refresh; without it an expired user token is a 503", doc: CONTROL },
    { kind: "var", name: "GITHUB_APP_CLIENT_ID", need: "required", purpose: "The GitHub App's OAuth client ID, for token refresh", doc: CONTROL },
    { kind: "secret", name: "CONVEX_INTERNAL_SECRET", need: "required", purpose: "Tells Convex about epochs and removals, so comment access ends at once", doc: CONTROL },
    { kind: "var", name: "CONVEX_URL", need: "required", purpose: "The Convex deployment the comment sink calls", doc: CONTROL },
    { kind: "var", name: "GITHUB_APP_ID", need: "required", purpose: "The GitHub App's ID: the issuer of its JWT, for installation tokens", doc: APP_TOKENS },
    { kind: "secret", name: "GITHUB_APP_PRIVATE_KEY", need: "required", purpose: "The GitHub App's private key (PEM); installation tokens are minted with it", doc: APP_TOKENS },
    { kind: "secret", name: "GITHUB_DEV_TOKEN", need: "forbidden", purpose: "A static installation token for development and tests, where the App is not configured", doc: CONTROL },
    { kind: "var", name: "GITHUB_API_ORIGIN", need: "forbidden", purpose: "Points the client at a fake GitHub (tests)", doc: CONTROL },
    { kind: "var", name: "GITHUB_WEB_ORIGIN", need: "forbidden", purpose: "Points token refresh at a fake GitHub (tests)", doc: CONTROL },
  ],
  bindings: [
    { kind: "durable-object", name: "REPO_ACCESS_DIRECTORY", className: "RepoAccessDirectory", need: "required", purpose: "Registry, per-user mirrors, sealed tokens and the epoch outbox", doc: CONTROL },
    { kind: "kv", name: "REPO_EPOCHS", namespace: "rendro-repo-epochs", need: "required", purpose: "Revocation epochs, read by the serving Worker", doc: CONTROL },
    { kind: "durable-object", name: "REPO_INGEST", className: "RepoIngestCoordinator", script: "ingest", need: "required", purpose: "A confirmed removal purges the repository's cached content", doc: "TECHNICAL.md#purging-removed-repositories" },
  ],
  wiring: [
    { kind: "route", path: "/v1/github/webhook", need: "required", purpose: "The GitHub App's webhook URL; the only public path", doc: "SETUP.md#production-readiness-checklist" },
    { kind: "workers-dev", enabled: false, need: "required", purpose: "No workers.dev URL: only the webhook route is public", doc: CONTROL },
  ],
};

const convex: ConvexDeployable = {
  title: "Convex",
  deployment: "prod",
  entries: "convex/**/*.ts",
  builtIn: ["CONVEX_CLOUD_URL", "CONVEX_SITE_URL"],
  settings: [
    { name: "SITE_URL", need: "required", purpose: "Canonical Worker origin; Better Auth base URL and trusted origin", doc: CONVEX },
    { name: "AUTH_SECRET", need: "required", purpose: "Better Auth signing", doc: CONVEX },
    { name: "CONVEX_INTERNAL_SECRET", need: "required", purpose: "Verifies the Workers' signed client IPs and internal calls; equals the Workers' value", doc: CONVEX },
    { name: "RESEND_API_KEY", need: "required", purpose: "Verification, reset and existing-account email", doc: CONVEX },
    { name: "AUTH_EMAIL_FROM", need: "required", purpose: "Sender address of the auth email", doc: CONVEX },
    { name: "GITHUB_APP_CLIENT_ID", need: "required", purpose: "The GitHub App's OAuth client ID; without it and the secret GitHub sign-in is off", doc: GITHUB_SIGN_IN },
    { name: "GITHUB_APP_CLIENT_SECRET", need: "required", purpose: "The GitHub App's OAuth client secret, for the sign-in code exchange", doc: GITHUB_SIGN_IN },
    { name: "AUTH_EMAIL_SIGN_IN", need: "optional", purpose: "\"off\" turns email sign-in and sign-up off once GitHub sign-in is configured; default on", doc: GITHUB_SIGN_IN },
  ],
};

export const workers: Record<DeployableKey, WorkerDeployable> = { serving, ingest, control };
export const convexDeployable = convex;
