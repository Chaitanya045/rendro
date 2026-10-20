# Rendro — Setup

Local development and deployment guide. For architecture, APIs, and runbooks, see [TECHNICAL.md](TECHNICAL.md); for CLI usage, see the [README](../README.md).

## Prerequisites

- **Node.js** ≥ 22
- **pnpm** 10 (the repo pins `pnpm@10.18.3` via `packageManager`; `corepack enable` picks it up)
- **Google Cloud** — OAuth 2.0 client for sign-in
- **Convex** — account for auth + database
- **Cloudflare** — Workers + R2 for deployment
- **Resend** — optional locally; required for email sign-up, verification, and password reset

## Local Development

### 1. Clone & Install

```bash
git clone https://github.com/Chaitanya045/rendro
cd rendro
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

`pnpm dev` and `pnpm start` read `.env`. `src/config.ts` validates Worker settings at startup; `src/index.ts` validates the local Node port. Google OAuth credentials belong only to Convex (step 3), and `BASE_URL` is unused:

| Variable | Required | Notes |
|---|---|---|
| `AUTH_SECRET` | Yes (≥16 chars; use 32+) | Signs legacy `/share/:token` links only. It does not need to match Convex |
| `CONVEX_INTERNAL_SECRET` | Yes (≥32 chars) | Sent with legacy API-key and soft-delete Convex calls (`src/convex-internal.ts`); must equal the Convex value |
| `IMAGE_PROXY_SECRET` | Yes (≥32 chars) | Signs same-origin image proxy URLs (`/img/<sig>/<url>`) written at ingest. Dedicated; reuse no other secret |
| `REPO_CONTENT_KEY` | Yes (≥32 chars) | Seals private-repository content in R2 (per-repository AES-256-GCM). Dedicated; reuse no other secret. The ingest Worker needs the same value |
| `REPO_CONTENT_KEY_PREVIOUS` | No (≥32 chars) | Only during a key rotation: the previous `REPO_CONTENT_KEY`, which still opens content sealed under it ([rotation](TECHNICAL.md#key-rotation)) |
| `CONVEX_URL` | No at startup; needed for the full app | From `convex dev` (step 3); defaults to empty, disabling legacy Convex calls and comments |
| `CONVEX_SITE_URL` | No | Derived from `CONVEX_URL` when unset |
| `RETENTION_SECRET` | No (≥32 chars) | Bearer for Convex's retention endpoints; only the scheduled purge reads it. Same value as in Convex |
| `NODE_ENV` | No | Defaults to `development`; Wrangler sets `production` |
| `PORT` | No (local Node server only) | Defaults to `3000`; must be an integer from 1 to 65535 |
| `LOG_LEVEL` | No | Pino level; defaults to `debug` outside production (`src/logger.ts`) |

Generate secrets with `openssl rand -hex 32`.

### 3. Start Convex

```bash
pnpm exec convex dev
```

Keep it running. The first run creates or links a dev deployment and writes `CONVEX_DEPLOYMENT`, `CONVEX_URL`, and `CONVEX_SITE_URL` to `.env.local`. The app does not read `.env.local`: copy `CONVEX_URL` (and optionally `CONVEX_SITE_URL`) into `.env`.

In a second terminal, set the Convex environment:

```bash
pnpm exec convex env set SITE_URL http://localhost:3000
pnpm exec convex env set GOOGLE_CLIENT_ID <value>
pnpm exec convex env set GOOGLE_CLIENT_SECRET <value>
pnpm exec convex env set AUTH_SECRET <random-32-plus-characters>
pnpm exec convex env set CONVEX_INTERNAL_SECRET <same-value-as-.env>
pnpm exec convex env set RESEND_API_KEY <value>
pnpm exec convex env set AUTH_EMAIL_FROM "Rendro <auth@your-domain>"
```

`SITE_URL`, `AUTH_SECRET`, and the Google values are required by Better Auth (`convex/auth.ts`). Without `RESEND_API_KEY` and `AUTH_EMAIL_FROM`, email sign-up, verification, password reset, and invitation email fail (`convex/authEmails.ts`); Google sign-in still works. The full list is in [TECHNICAL.md](TECHNICAL.md#environment-variables-convex).

### 4. Start the app

```bash
pnpm build:assets
pnpm dev
```

- There is no storage service to start and no storage setting to configure. Documents live in the `STORAGE` R2 binding from `wrangler.toml`, which the local server serves from Miniflare's R2 simulation (the same one `wrangler dev` uses), persisted under `.wrangler/state/`. Delete that directory to start with an empty bucket. Nothing talks to Cloudflare, and there is no access key.
- `pnpm build:assets` generates the git-ignored `public/commentor.js`, `public/commentor-parent.js`, and `public/lazy-tree.js` that the document viewer loads.

The app starts at `http://localhost:3000` (the first request waits a few seconds while the R2 simulation starts). Add `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI on the OAuth client.

### 5. Create the organization and project

Sign in, create or join an organization, then open **Projects** and create a project. The project overview shows the project ID; the organization ID is in the URL (`/organizations/<organization-id>`), and the onboarding push command includes both. Slugs are display fields, not authorization keys.

### 6. Create a scoped API key

Open **API keys** in the organization sidebar (`/organizations/<organization-id>/api-keys`; owners and admins only). For CI, select the project and grant only:

- `docs:read` and `docs:write` to push
- `publications:read` / `publications:write` only when that workflow also manages public docs (`publication create` also needs `docs:read`)

Set an expiry. The raw `rnd_live_<keyId>_<secret>` value is shown once. Keys prefixed `rendro_` are legacy slug-route keys and do not work with the project API. See [API keys](TECHNICAL.md#api-keys).

### 7. Push docs

```bash
pnpm cli:build
RENDRO_API_KEY=rnd_live_xxx ./bin/rendro.mjs push \
  --source ./docs \
  --organization <organization-id> \
  --project <project-id> \
  --endpoint http://localhost:3000
```

The CLI computes a SHA-256 manifest and starts a new staging deployment. Files that match the active deployment are copied server-side and only changed files are uploaded. The project pointer moves only after the server verifies every manifest file. If a step fails, the CLI marks the deployment failed and the active deployment is unchanged. There is no resume: re-running starts a new staging deployment ([Interrupted push](TECHNICAL.md#interrupted-push)).

### 8. Browse, share, and publish

The project page links to **Open documentation** and **Manage publications** (**View publications** for members). Project docs remain private to organization members. **Share document** in the viewer creates a seven-day revocable link pinned to the current deployment.

Create a public release in the Publications UI or CLI:

```bash
RENDRO_API_KEY=rnd_live_xxx ./bin/rendro.mjs publication create \
  --organization <organization-id> \
  --project <project-id> \
  --slug product \
  --path product-docs \
  --entry index.html \
  --title "Product documentation" \
  --endpoint http://localhost:3000

./bin/rendro.mjs publication list \
  --organization <organization-id> --project <project-id> \
  --endpoint http://localhost:3000
```

The public URL is `http://localhost:3000/p/product`. A tracked publication follows future active deployments; `--pin <deployment-id>` keeps it on one immutable version.

## Deployment

### Convex

```bash
pnpm exec convex env set --prod SITE_URL https://rendro.app
pnpm exec convex env set --prod GOOGLE_CLIENT_ID <value>
pnpm exec convex env set --prod GOOGLE_CLIENT_SECRET <value>
pnpm exec convex env set --prod AUTH_SECRET <random-32-plus-characters>
pnpm exec convex env set --prod CONVEX_INTERNAL_SECRET <same-value-as-the-Worker>
pnpm exec convex env set --prod RESEND_API_KEY <value>
pnpm exec convex env set --prod AUTH_EMAIL_FROM "Rendro <auth@rendro.app>"
pnpm exec convex env set --prod RETENTION_SECRET <random-32-plus-characters>
pnpm exec convex env set --prod MIGRATION_SECRET <random-32-plus-characters>  # only for the legacy migration
pnpm exec convex deploy
```

`RETENTION_SECRET` must also be a Worker secret (see [Scheduled retention](#scheduled-retention)); the Worker's nightly purge sends it to Convex. `MIGRATION_SECRET` belongs only in the operator environment that runs `pnpm migrate:legacy`; the Worker does not read it.

### Cloudflare Workers and R2

Use two **private** R2 buckets, bound as `STORAGE` in `wrangler.toml`: `rendro-docs` for production (the top-level configuration) and `dev-rendro` for the `development` environment (`rendro-dev`). A new account creates them first; the names in the file are the single source of truth. Do not create an S3 API token, an `r2.dev` URL or a custom domain: the Worker reaches the bucket through its binding, so there is no credential to leak.

`wrangler.toml` sets `NODE_ENV` as a var. Both production and `development` require exactly these five secrets at startup and in Wrangler: `CONVEX_INTERNAL_SECRET`, `AUTH_SECRET`, `IMAGE_PROXY_SECRET`, `REPO_CAPABILITY_SECRET` and `REPO_CONTENT_KEY`. `REPO_CAPABILITY_SECRET` signs repository capability cookies and asset tickets (`/r/…`, [TECHNICAL.md](TECHNICAL.md#repository-read-path-github-pivot-p4a)); it is Worker-only and must differ from every other secret. `REPO_CONTENT_KEY` seals private-repository content ([TECHNICAL.md](TECHNICAL.md#repository-content-lifecycle-github-pivot-p9b)); it must differ from every other secret and is shared only with the ingest Worker. List secret names with `pnpm exec wrangler secret list` for production (`rendro`) and `pnpm exec wrangler secret list --env development` for development (`rendro-dev`). Production uses the top-level configuration; there is no named `--env production` environment.

Configure the Worker settings below. `CONVEX_URL`, the optional `CONVEX_SITE_URL` override and `RETENTION_SECRET` remain outside `secrets.required`: startup and `/health` work without them, but auth and project routes need a Convex HTTP origin and the nightly purge needs `RETENTION_SECRET`. Google credentials are Convex-only; the Worker does not read `BASE_URL`.

```bash
pnpm exec wrangler secret put AUTH_SECRET
pnpm exec wrangler secret put REPO_CAPABILITY_SECRET  # openssl rand -hex 32; Worker only
pnpm exec wrangler secret put REPO_CONTENT_KEY        # openssl rand -hex 32; same value on the ingest Worker
pnpm exec wrangler secret put CONVEX_URL
pnpm exec wrangler secret put CONVEX_SITE_URL         # optional
pnpm exec wrangler secret put CONVEX_INTERNAL_SECRET
pnpm exec wrangler secret put RETENTION_SECRET        # same value as in Convex
pnpm exec wrangler secret put IMAGE_PROXY_SECRET      # openssl rand -hex 32
pnpm run deploy
```

`pnpm run deploy` runs `pnpm build:assets` before `wrangler deploy`; a bare `wrangler deploy` from a fresh checkout ships without the git-ignored viewer bundles. For the `rendro-dev` Worker (`dev.rendro.app`), add `--env development` to each `wrangler secret put` and run `pnpm run deploy --env development`. Use the explicit `run`: `pnpm deploy` is an unrelated pnpm command. See [Deploy Commands](TECHNICAL.md#deploy-commands) and [Environment Variables (Workers)](TECHNICAL.md#environment-variables-workers).

#### GitHub repository reads (not configured yet)

`/r/` stays a 404 until these exist; nothing below is needed for today's deploys. The pieces are in the repository ([TECHNICAL.md](TECHNICAL.md#repository-permission-mirror-github-pivot-p5)); the owner provides the accounts, secrets and bindings once the GitHub App exists (P1):

1. Create a KV namespace for revocation epochs per environment (`pnpm exec wrangler kv namespace create rendro-repo-epochs`). Put its ID in `wrangler.control.toml` (`REPO_EPOCHS`) and bind the same namespace as `REPO_EPOCHS` in the serving Worker's `wrangler.toml`. KV Instant, when available to the account, shortens revocation from about a minute to about a second.
2. Set the control Worker's secrets: `GITHUB_TOKEN_KEY` (`openssl rand -hex 32`; dedicated, never reused), `GITHUB_WEBHOOK_SECRET` (the GitHub App's webhook secret), and `GITHUB_APP_CLIENT_SECRET` with the `GITHUB_APP_CLIENT_ID` var (the App's OAuth client, for token refresh). Use `wrangler secret put <NAME> --config wrangler.control.toml`.
3. Deploy the control Worker (`pnpm exec wrangler deploy --config wrangler.control.toml`), with Smart Placement or a location hint near Convex. Route only `/v1/github/webhook` to it publicly and set that URL as the App's webhook URL; its other endpoints answer service bindings only.
4. In `wrangler.toml`, add the `REPO_ACCESS` service binding to the control Worker and the `REPO_CONTENT` R2 binding to the ingest bucket. Deploy the control Worker before the serving Worker, since a service binding to a missing Worker fails the deploy.
5. P1 replaces `GITHUB_DEV_TOKEN` with installation tokens minted per installation, and calls `/v1/accounts/link` at sign-in.
6. For comments on repository docs (#254), give the control Worker the `CONVEX_URL` var and the `CONVEX_INTERNAL_SECRET` secret (the same values the serving Worker and Convex use). It then ends a revoked reader's comment access with the epoch, and hides an uninstalled repository's comments at once. Without them, comment access still ends, but only when its grant expires (at most five minutes).
7. Give the ingest Worker the serving Worker's `REPO_CONTENT_KEY` (`wrangler secret put REPO_CONTENT_KEY --config wrangler.ingest.toml`); without it, private repositories are not ingested. Bind the ingest Worker's coordinators in the control Worker (`REPO_INGEST`: a Durable Object binding to `RepoIngestCoordinator` with `script_name` set to the ingest Worker), so a removal GitHub confirmed also purges the repository's cached content (#263), and in the serving Worker (`REPO_INGEST`, for first views and idle expiry). Deploy the ingest Worker before the Workers that bind it.
8. In the serving Worker, add the `FIRST_VIEW_LIMIT` and `SEARCH_LIMIT` rate-limit bindings (`[[ratelimits]]`, as `[env.development]` in `wrangler.toml` has them, each with a `namespace_id` unique in the account) (#294). Without `FIRST_VIEW_LIMIT`, first views of branches other than the default are refused until a push builds them; without `SEARCH_LIMIT`, searches are not limited per client.

#### Migrating from S3 access keys

Earlier releases reached R2 with an S3 endpoint and an access key pair (`MINIO_*` Worker secrets). After deploying a Worker that has the binding and confirming documents load:

1. Delete the old secrets from each Worker: `wrangler secret delete MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` and `MINIO_REGION` (add `--env development` for `rendro-dev`). They are now ignored.
2. **Revoke the R2 API token** in the Cloudflare dashboard (R2 > Manage API tokens), so the old key pair is dead everywhere, not just unused.
3. Delete the repository secrets `R2_ENDPOINT`, `R2_ACCESS_KEY`, `R2_SECRET_KEY` and `R2_BUCKET`. Retention no longer runs in GitHub Actions.

#### Keep the bucket private

Worker routes are the authorization boundary. Never enable the bucket's `r2.dev` URL or attach a custom domain. Verify with the scheduled check:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> CLOUDFLARE_API_TOKEN=<token> pnpm check:r2-public
pnpm check:r2-public --dry-run        # print the Cloudflare API requests; no credentials needed
```

`.github/workflows/r2-public-access.yml` runs it daily and on demand. It needs two repository secrets: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, where the token is an API token (My Profile > API Tokens) with only **Account > Workers R2 Storage > Read**. Until both are set, the scheduled job fails with "was NOT verified" rather than passing silently. Pull requests that touch the script, the workflow or `wrangler.toml` run it as a dry run.

### Scheduled retention

The Worker purges expired deployments from storage itself: a cron trigger (`[triggers]` in `wrangler.toml`, 03:23 UTC) calls `scheduled` in `src/worker.ts`, which deletes through the R2 binding and confirms each purge with Convex. Set the Worker secret `RETENTION_SECRET` to the same value as the Convex one (`wrangler secret put RETENTION_SECRET`, plus `--env development`). Without it the run logs `RetentionDisabled` and fails in the Cloudflare cron history. Eligibility rules are in [Retention](TECHNICAL.md#retention).

## Builds

```bash
pnpm cli:build      # bin/rendro.mjs (executable, zero runtime dependencies)
./bin/rendro.mjs --help

pnpm build:assets   # public/commentor.js, commentor-parent.js, lazy-tree.js,
                    # management-query.js, select.js, management-pages.js
```

`public/management-query.js`, `public/select.js`, and `public/management-pages.js` are committed; rebuild and commit them when their sources change. The other three bundles and `bin/` are git-ignored.

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` / `pnpm start` | Local Node server (`src/index.ts`) with or without file watching |
| `pnpm build:assets` | Build browser bundles into `public/` |
| `pnpm cli:build` | Build the CLI into `bin/rendro.mjs` |
| `pnpm run deploy` | Build assets and deploy the Worker |
| `pnpm check:r2-public` | Verify no R2 bucket has an `r2.dev` URL or custom domain ([Keep the bucket private](#keep-the-bucket-private)) |
| `pnpm migrate:legacy` | Copy legacy slug-prefixed objects into projects ([Legacy migration](TECHNICAL.md#legacy-migration)) |

QA fixture scripts (`scripts/run-permission-qa.mjs`, `scripts/run-workspace-qa.mjs`) target the development deployment only; see [Development QA fixtures](TECHNICAL.md#development-qa-fixtures).

## Quality Gates

```bash
pnpm typecheck                 # TypeScript
pnpm lint                      # ESLint
pnpm test                      # Vitest
pnpm verify                    # all of the above, plus build:assets, git diff --check, verify:assets
pnpm audit --audit-level=high
```

`pnpm verify:assets` fails if the committed bundles differ from a fresh build. CI runs `quality.yml` (`pnpm verify`, audit); `release.yml` attaches `bin/rendro.mjs` to the GitHub release for `v*` tags. See [CI workflows](TECHNICAL.md#ci-workflows).

## Project Structure

```
rendro/
├── src/
│   ├── index.ts              # Local Node server
│   ├── worker.ts             # Cloudflare Workers entry (storage binding, env bridging, cron)
│   ├── app-routes.ts         # Route mounting shared by both entries
│   ├── config.ts             # Zod env validation
│   ├── logger.ts             # Pino logger
│   ├── auth-proxy.ts         # /api/auth and /api/rendro proxy to Convex
│   ├── convex-internal.ts    # Internal-secret Convex calls (legacy)
│   ├── storage.ts            # R2 bucket binding: get/head/put/list/delete/copy
│   ├── storage-binding.ts    # The isolate's bucket and its fail-closed accessor
│   ├── retention.ts          # Scheduled purge of expired deployments
│   ├── stored-manifest.ts, bounded-body.ts
│   ├── api-keys.ts, soft-delete.ts, orgs.ts, publications.ts, share-links.ts  # legacy slug tenancy
│   ├── middleware/session.ts # Better Auth session lookup
│   ├── routes/               # Management pages, auth pages, deployment and publication APIs,
│   │                         # project/public/share viewers, legacy /docs routes
│   ├── commentor/            # Inline comment widget and parent-frame bridge
│   ├── lazy-tree/            # Document tree UI
│   ├── management-query/     # Client-side management data cache
│   └── ui/                   # Shared select/menu components
├── convex/
│   ├── schema.ts, convex.config.ts, auth.config.ts
│   ├── http.ts, rendroHttp.ts                   # HTTP router and management actions
│   ├── auth.ts, authEmails.ts, authorization.ts, security.ts, betterAuth/
│   ├── projects.ts, deployments.ts, deploymentHttp.ts
│   ├── publicationsV2.ts, publicationHttp.ts
│   ├── shareGrants.ts, shareGrantHttp.ts
│   ├── apiKeyCredentials.ts, credentialHttp.ts  # Scoped API keys
│   ├── documentThreads.ts, documentReplies.ts   # Project comments
│   ├── threads.ts, replies.ts, apiKeys.ts, deletedFiles.ts  # Legacy slug tables
│   ├── retention.ts, retentionHttp.ts, migrationHttp.ts
│   └── qaPermissionFixtures.ts, qaWorkspaceFixtures.ts  # Dev-only QA fixtures
├── shared/deployment-limits.ts  # Limits shared by CLI and Worker
├── cli/src/index.ts          # CLI source
├── scripts/                  # Asset/CLI builds, R2 exposure check, legacy migration, QA runners
├── public/                   # Browser bundles and static assets
├── tests/                    # Vitest suites and fixtures
├── docs/                     # Product, technical, design docs; archive/ holds dated QA reports
├── .github/workflows/        # quality, release, retention
├── wrangler.toml             # Worker config (production and development envs)
└── convex.json
```
