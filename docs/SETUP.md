# Rendro — Setup

Local development and deployment guide. For architecture, routes and runbooks, see [TECHNICAL.md](TECHNICAL.md); for the test layers, see [BROWSER_TESTS.md](BROWSER_TESTS.md).

## Prerequisites

- **Node.js** ≥ 22
- **pnpm** 10 (the repo pins `pnpm@10.18.3` via `packageManager`; `corepack enable` picks it up)
- **Convex**: an account for auth and the comment database
- **Cloudflare**: Workers, R2, KV, D1, Queues and Durable Objects for deployment
- **Resend**: optional locally; required for email sign-up, verification and password reset
- **Docker**: only for the visual baselines (`pnpm visual`), which render in a pinned Playwright container

## Local Development

### 1. Clone and install

```bash
git clone https://github.com/Chaitanya045/rendro
cd rendro
pnpm install
```

### 2. Configure the environment

```bash
cp .env.example .env
```

`pnpm dev` and `pnpm start` read `.env`. `src/config.ts` validates the Worker settings at startup; `src/index.ts` validates the local Node port.

| Variable | Required | Notes |
|---|---|---|
| `CONVEX_INTERNAL_SECRET` | Yes (≥32 chars) | Signs the trusted client IP for Convex and authorizes the Worker's internal Convex calls (`src/convex-internal.ts`); must equal the Convex value |
| `IMAGE_PROXY_SECRET` | Yes (≥32 chars) | Signs same-origin image proxy URLs (`/img/<sig>/<url>`) written at ingest. Dedicated; reuse no other secret |
| `REPO_CAPABILITY_SECRET` | Yes (≥32 chars) | Signs repository capability cookies and asset tickets (`/r/…`). Dedicated; reuse no other secret |
| `REPO_CONTENT_KEY` | Yes (≥32 chars) | Seals private-repository content in R2 (per-repository AES-256-GCM). Dedicated; the ingest Worker needs the same value |
| `REPO_CONTENT_KEY_PREVIOUS` | No (≥32 chars) | Only during a key rotation: the previous `REPO_CONTENT_KEY`, which still opens content sealed under it ([rotation](TECHNICAL.md#key-rotation)) |
| `CONVEX_URL` | No at startup; needed for the full app | From `convex dev` (step 3); defaults to empty, which disables sign-in and comments |
| `CONVEX_SITE_URL` | No | Derived from `CONVEX_URL` when unset |
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
pnpm exec convex env set AUTH_SECRET <random-32-plus-characters>
pnpm exec convex env set CONVEX_INTERNAL_SECRET <same-value-as-.env>
pnpm exec convex env set RESEND_API_KEY <value>
pnpm exec convex env set AUTH_EMAIL_FROM "Rendro <auth@your-domain>"
```

`SITE_URL` and `AUTH_SECRET` are required by Better Auth (`convex/auth.ts`). Without `RESEND_API_KEY` and `AUTH_EMAIL_FROM`, sign-up, verification and password reset email fail (`convex/authEmails.ts`), and email is the only sign-in method. The full list is in [TECHNICAL.md](TECHNICAL.md#environment-variables-convex).

### 4. Start the app

```bash
pnpm build:assets
pnpm dev
```

The app starts at `http://localhost:3000`. Sign up with an email address, follow the verification link from Resend, and sign in: you land on `/home`.

- `pnpm build:assets` generates the git-ignored bundles under `public/` (`lazy-tree.js`, `private-viewer.js`, `commentor-parent.js`, `commentor.js`, `rum.js`) that the repository shell and its frames load.
- The local Node server has none of the read path's bindings, so `/r/…` is a 404 under `pnpm dev`. The E2E harness (`pnpm e2e`) runs the real Workers with simulated R2, KV, D1 and Durable Objects and a fake GitHub, which is the way to exercise `/r/` locally ([BROWSER_TESTS.md](BROWSER_TESTS.md)).

## Deployment

### Convex

```bash
pnpm exec convex env set --prod SITE_URL https://rendro.app
pnpm exec convex env set --prod AUTH_SECRET <random-32-plus-characters>
pnpm exec convex env set --prod CONVEX_INTERNAL_SECRET <same-value-as-the-Workers>
pnpm exec convex env set --prod RESEND_API_KEY <value>
pnpm exec convex env set --prod AUTH_EMAIL_FROM "Rendro <auth@rendro.app>"
pnpm exec convex deploy
```

### Cloudflare Workers

Rendro runs as three Workers ([TECHNICAL.md](TECHNICAL.md#architecture)):

| Worker | Configuration | Role |
|---|---|---|
| Serving Worker (`rendro`, `rendro-dev`) | `wrangler.toml` | Pages, auth proxy, the `/r/` read path, image proxy, static assets |
| Ingest Worker (`rendro-ingest-dev`) | `wrangler.ingest.toml` | Renders repository Markdown into R2 and the D1 search index |
| Control Worker (`rendro-control-dev`) | `wrangler.control.toml` | Mirrors GitHub permissions and receives the GitHub App's webhooks |

`wrangler.toml` sets `NODE_ENV` as a var. Both production and `development` require exactly these four secrets at startup and in Wrangler: `CONVEX_INTERNAL_SECRET`, `IMAGE_PROXY_SECRET`, `REPO_CAPABILITY_SECRET` and `REPO_CONTENT_KEY`. No two may share a value. List secret names with `pnpm exec wrangler secret list` for production (`rendro`) and `pnpm exec wrangler secret list --env development` for development (`rendro-dev`). Production uses the top-level configuration; there is no named `--env production` environment.

`CONVEX_URL` and the optional `CONVEX_SITE_URL` override remain outside `secrets.required`: startup and `/health` work without them, but sign-in and comments need a Convex origin.

```bash
pnpm exec wrangler secret put CONVEX_INTERNAL_SECRET
pnpm exec wrangler secret put IMAGE_PROXY_SECRET      # openssl rand -hex 32; same value on the ingest Worker
pnpm exec wrangler secret put REPO_CAPABILITY_SECRET  # openssl rand -hex 32; serving Worker only
pnpm exec wrangler secret put REPO_CONTENT_KEY        # openssl rand -hex 32; same value on the ingest Worker
pnpm exec wrangler secret put CONVEX_URL
pnpm exec wrangler secret put CONVEX_SITE_URL         # optional
pnpm run deploy
```

`pnpm run deploy` runs `pnpm build:assets` before `wrangler deploy`; a bare `wrangler deploy` from a fresh checkout ships without the git-ignored bundles. For the `rendro-dev` Worker (`dev.rendro.app`), add `--env development` to each `wrangler secret put` and run `pnpm run deploy --env development`. Use the explicit `run`: `pnpm deploy` is an unrelated pnpm command. See [Deploy Commands](TECHNICAL.md#deploy-commands) and [Environment Variables (Workers)](TECHNICAL.md#environment-variables-workers).

#### GitHub repository reads (not configured yet)

`/r/` stays a 404 until these exist. The pieces are in the repository ([TECHNICAL.md](TECHNICAL.md#repository-permission-mirror-github-pivot-p5)); the owner provides the accounts, secrets and bindings once the GitHub App exists (P1):

1. Create a KV namespace for revocation epochs per environment (`pnpm exec wrangler kv namespace create rendro-repo-epochs`). Put its ID in `wrangler.control.toml` (`REPO_EPOCHS`) and bind the same namespace as `REPO_EPOCHS` in the serving Worker's `wrangler.toml`. KV Instant, when available to the account, shortens revocation from about a minute to about a second.
2. Set the control Worker's secrets: `GITHUB_TOKEN_KEY` (`openssl rand -hex 32`; dedicated, never reused), `GITHUB_WEBHOOK_SECRET` (the GitHub App's webhook secret), and `GITHUB_APP_CLIENT_SECRET` with the `GITHUB_APP_CLIENT_ID` var (the App's OAuth client, for token refresh). Use `wrangler secret put <NAME> --config wrangler.control.toml`.
3. Deploy the control Worker (`pnpm exec wrangler deploy --config wrangler.control.toml`), with Smart Placement or a location hint near Convex. Route only `/v1/github/webhook` to it publicly and set that URL as the App's webhook URL; its other endpoints are served only by its `RepoAccessService` entrypoint, which only a service binding can reach.
4. In `wrangler.toml`, add the `REPO_ACCESS` service binding to the control Worker's internal entrypoint (`service = "<control Worker>"`, `entrypoint = "RepoAccessService"`; without the entrypoint every permission check is a 503) and the `REPO_CONTENT` R2 binding to the ingest bucket. Deploy the control Worker before the serving Worker, since a service binding to a missing Worker fails the deploy.
5. P1 replaces `GITHUB_DEV_TOKEN` with installation tokens minted per installation, and calls `/v1/accounts/link` through `REPO_ACCESS` at sign-in.
6. For comments on repository docs (#254), give the control Worker the `CONVEX_URL` var and the `CONVEX_INTERNAL_SECRET` secret (the same values the serving Worker and Convex use). It then ends a revoked reader's comment access with the epoch, and hides an uninstalled repository's comments at once. Without them, comment access still ends, but only when its grant expires (at most five minutes).
7. Give the ingest Worker the serving Worker's `REPO_CONTENT_KEY` and `IMAGE_PROXY_SECRET` (`wrangler secret put <NAME> --config wrangler.ingest.toml`); without the content key, private repositories are not ingested. Bind the ingest Worker's coordinators in the control Worker (`REPO_INGEST`: a Durable Object binding to `RepoIngestCoordinator` with `script_name` set to the ingest Worker), so a removal GitHub confirmed also purges the repository's cached content (#263), and in the serving Worker (`REPO_INGEST`, for first views and idle expiry). Deploy the ingest Worker before the Workers that bind it.
8. In the serving Worker, add the `FIRST_VIEW_LIMIT` and `SEARCH_LIMIT` rate-limit bindings (`[[ratelimits]]`, as `[env.development]` in `wrangler.toml` has them, each with a `namespace_id` unique in the account) (#294). Without `FIRST_VIEW_LIMIT`, first views of branches other than the default are refused until a push builds them; without `SEARCH_LIMIT`, searches are not limited per client. Bind `REPO_SEARCH` to the ingest Worker's D1 database for search.

#### Keep the buckets private

Worker routes are the authorization boundary. Never enable a bucket's `r2.dev` URL or attach a custom domain. Verify with the scheduled check:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> CLOUDFLARE_API_TOKEN=<token> pnpm check:r2-public
pnpm check:r2-public --dry-run        # print the Cloudflare API requests; no credentials needed
```

It checks every bucket in the three Worker configurations. `.github/workflows/r2-public-access.yml` runs it daily and on demand. It needs two repository secrets: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, where the token is an API token (My Profile > API Tokens) with only **Account > Workers R2 Storage > Read**. Until both are set, the scheduled job fails with "was NOT verified" rather than passing silently. Pull requests that touch the script, the workflow or a Worker configuration run it as a dry run.

## Builds

```bash
pnpm build:assets   # public/lazy-tree.js, private-viewer.js, commentor-parent.js, commentor.js, rum.js
pnpm build:fonts    # public/fonts/*.woff2 and src/routes/font-manifest.ts
pnpm build:styles   # public/styles/*.css and src/routes/style-manifest.ts
pnpm build:wasm     # the committed comrak (Markdown) WebAssembly, rebuilt from source
```

The bundles are git-ignored and versioned in `scripts/asset-versions.json`: bump the bundle's constant in `src/viewer/asset-versions.ts` when its bytes change, then `pnpm record:assets`. Fonts, stylesheets and the WebAssembly engine are committed.

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` / `pnpm start` | Local Node server (`src/index.ts`) with or without file watching |
| `pnpm build:assets` / `pnpm record:assets` | Build the browser bundles into `public/`; record a new bundle version in the ledger |
| `pnpm run deploy` | Build assets and deploy the serving Worker |
| `pnpm e2e` | Playwright end-to-end suite on workerd and a disposable local Convex |
| `pnpm visual`, `pnpm visual:update`, `pnpm visual:repeat` | Visual baselines in the pinned Playwright container: compare, rewrite changed cells, check determinism |
| `pnpm a11y` | axe scans of the visual states on Chromium, Firefox and WebKit |
| `pnpm coverage` | Merged Node, browser and subprocess coverage with the 100%-per-file gate |
| `pnpm check:r2-public` | Verify no R2 bucket has an `r2.dev` URL or custom domain ([Keep the buckets private](#keep-the-buckets-private)) |
| `pnpm bench:hostile` | Time the renderer on hostile Markdown inputs |

## Quality Gates

```bash
pnpm typecheck                 # TypeScript
pnpm lint                      # ESLint
pnpm test                      # Vitest (unit and Chromium projects)
pnpm verify                    # all of the above, plus fonts, styles, wasm, build:assets, git diff --check, verify:assets
pnpm audit --audit-level=high
```

`pnpm verify:assets` fails if a built bundle differs from its recorded version. CI runs `quality.yml` (verify, the WebAssembly rebuild check, E2E on three engines, visual baselines, axe and coverage). See [CI workflows](TECHNICAL.md#ci-workflows).

## Project Structure

```
rendro/
├── src/
│   ├── index.ts, worker.ts   # Local Node server; serving Worker entry (env bridging, asset allowlist)
│   ├── app-routes.ts         # Route mounting shared by both entries
│   ├── config.ts, logger.ts  # Zod env validation; Pino logger with redaction
│   ├── auth-proxy.ts         # /api/auth proxy to Convex, sign-out
│   ├── middleware/           # Security headers, session, write and body admission
│   ├── routes/               # Landing, auth and account pages, the repository shell, 404s, assets
│   ├── repo-read/            # The /r/ read path: capability cookie, snapshots, frames, tree, search, comments
│   ├── repo-access/          # Control Worker: GitHub permission mirror, webhooks, epochs
│   ├── ingest/               # Ingest Worker: GitHub source, comrak rendering, sanitizer, orchestrator
│   ├── search/               # D1 search index
│   ├── viewer/               # Frame client: link bridge, ticket renewal, navigation prompts
│   ├── lazy-tree/            # Document tree and search UI
│   ├── commentor/            # Inline comment widget and the parent host
│   ├── rum/                  # Real-user monitoring beacon
│   └── styles/, ui/          # Shell and document stylesheets; shared menu styles
├── convex/
│   ├── schema.ts, convex.config.ts, auth.config.ts, http.ts
│   ├── auth.ts, authEmails.ts, authHttp.ts, sessionLifetime.ts, sessionReadLimit.ts, betterAuth/
│   ├── repoCommentAccess.ts, repoComments.ts, commentOperations.ts  # Repository comments
│   └── writeQuotas.ts, admissionBuckets.ts, security.ts, httpErrors.ts
├── shared/                   # Code shared by the Workers and Convex
├── scripts/                  # Asset, font, style and wasm builds; ledger; R2 exposure check; coverage gate
├── public/                   # Static assets (bundles are built, not committed)
├── tests/                    # Vitest suites and fixtures; ui-transitions.json registry
├── e2e/                      # Playwright suites, local backend harness, visual and axe specs
├── docs/                     # Product, technical, design docs; archive/ holds dated QA reports
├── .github/workflows/        # quality, stability, r2-public-access
├── wrangler.toml, wrangler.ingest.toml, wrangler.control.toml
└── convex.json
```
