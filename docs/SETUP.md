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

Everything production needs is listed once, in [`scripts/production-manifest.ts`](../scripts/production-manifest.ts): for the serving, ingest and control Workers, every binding (with its type, a service's entrypoint, Durable Object classes and their migrations, queue producers and consumers), required secret and var, custom domain and route. For Convex, every env var. Each item is marked required, optional or forbidden (development and tests only), with its purpose and its documentation section. `pnpm preflight:prod` checks production against the manifest. Follow its output rather than a list copied here.

### Production readiness checklist

Run it before every production deploy and after any change to a binding:

```bash
pnpm preflight:prod            # offline: the manifest against each Worker's production wrangler section; exit 1 if anything required is missing
pnpm preflight:prod --report   # the same checklist; always exit 0
pnpm preflight:prod --online   # owner only, with production credentials: also the secret names set on each production Worker and the Convex production env var names
```

| Deployable | Production configuration | Deploy |
|---|---|---|
| Serving Worker `rendro` | `wrangler.toml`, top level | `pnpm run deploy` |
| Ingest Worker `rendro-ingest` | `wrangler.ingest.toml`, top level | `pnpm exec wrangler deploy --config wrangler.ingest.toml` |
| Control Worker `rendro-control` | `wrangler.control.toml`, top level | `pnpm exec wrangler deploy --config wrangler.control.toml` |
| Convex | the production deployment (`--prod`) | `pnpm exec convex deploy` |

Production is the top level of each wrangler file, as `pnpm run deploy` deploys it. The development Workers (`rendro-dev`, `rendro-ingest-dev`, `rendro-control-dev`) are each file's `[env.development]`, which the tests load. The top levels of `wrangler.ingest.toml` and `wrangler.control.toml` are production skeletons (#336): name, entry, Durable Objects, queues and cron, but no R2 bucket, D1 database or KV namespace. Until those are created and bound, the preflight reports them missing.

Each line has a status:

| Status | Meaning |
|---|---|
| `ok` | Present and as the manifest expects |
| `MISSING` | Required and absent, a placeholder ID, pointing at the wrong resource, or a development-only setting found in production. The next line (`->`) says what to create and where. Offline runs fail on any of these unless `--report` is passed |
| `VERIFY` | Cannot be confirmed offline: a secret that may be set outside the file, a custom domain attached in the dashboard, or a Convex variable. `--online` settles the first and the last |
| `optional` | Read by the code, but production works without it (for example the previous key during a rotation) |
| `unused` | Online only: a name set in production that the code does not read. Delete it once no deployed code needs it |

Wire production in this order. The preflight prints the exact command for each missing item:

1. **Create the resources** once: the ingest R2 bucket, the D1 search database, the revocation-epoch KV namespace (KV Instant, when available to the account, shortens revocation from about a minute to about a second), the ingest queue and its dead-letter queue. Enable Analytics Engine on the account (`wrangler deploy` fails with code 10089 while it is off). Every ID goes into the production section; a placeholder ID is reported as missing.
2. **Ingest Worker.** Give it the serving Worker's `REPO_CONTENT_KEY` and `IMAGE_PROXY_SECRET` (`wrangler secret put <NAME> --config wrangler.ingest.toml`). Without the content key, private repositories are not ingested. Deploy it first: the other two Workers bind its `RepoIngestCoordinator`, and a binding to a missing Worker fails their deploy.
3. **Control Worker.** Set its secrets: `GITHUB_TOKEN_KEY` (`openssl rand -hex 32`; dedicated, never reused), the GitHub App's webhook secret and OAuth client, and the Convex URL and internal secret the serving Worker and Convex use. Deploy it with Smart Placement or a location hint near Convex. Route only `/v1/github/webhook` to it publicly and set that URL as the App's webhook URL. Its other endpoints are served only by its `RepoAccessService` entrypoint, which only a service binding can reach. Deploy it before the serving Worker.
4. **Serving Worker.** Bind the ingest bucket (`REPO_CONTENT`), the shared epoch namespace (`REPO_EPOCHS`), the control Worker (`REPO_ACCESS` with `entrypoint = "RepoAccessService"`; without the entrypoint every permission check is a 503), the search database, the ingest coordinators, the RUM dataset and the three rate limiters. Give each rate limiter a `namespace_id` unique in the account: the preflight refuses one that another configuration uses. Then `pnpm run deploy`.
5. **Convex.** Set every variable the manifest lists (`pnpm exec convex env set --prod <NAME> <value>`), then `pnpm exec convex deploy`.
6. **Confirm** with `pnpm preflight:prod --online`: no `MISSING` line.

P1 replaces `GITHUB_DEV_TOKEN` (optional in the manifest) with installation tokens minted per installation, and calls `/v1/accounts/link` through `REPO_ACCESS` at sign-in.

The preflight never prints a value. Offline it reads only the wrangler files. Online it asks the CLIs for names (`wrangler secret list --format json`, `convex env list --prod --names-only`), keeps only the names, discards stderr and reports output it cannot parse by its line count. `tests/production-manifest.test.ts` keeps the manifest honest. It fails when a Worker or Convex reads a binding, secret or env var that the manifest does not list (found statically in each deployable's module graph), or when the manifest lists one the code no longer reads. A new read therefore lands with its manifest entry, and the checklist picks it up.

### Convex

Set the variables the manifest lists for Convex (`SITE_URL` is `https://rendro.app`; `CONVEX_INTERNAL_SECRET` equals the Workers' value), then deploy:

```bash
pnpm exec convex env set --prod <NAME> <value>
pnpm exec convex deploy
```

### Cloudflare Workers

Rendro runs as three Workers ([TECHNICAL.md](TECHNICAL.md#architecture)):

| Worker | Configuration | Role |
|---|---|---|
| Serving Worker (`rendro`, `rendro-dev`) | `wrangler.toml` | Pages, auth proxy, the `/r/` read path, image proxy, static assets |
| Ingest Worker (`rendro-ingest`, `rendro-ingest-dev`) | `wrangler.ingest.toml` | Renders repository Markdown into R2 and the D1 search index |
| Control Worker (`rendro-control`, `rendro-control-dev`) | `wrangler.control.toml` | Mirrors GitHub permissions and receives the GitHub App's webhooks |

The secrets and vars each Worker needs are in the manifest. `[secrets] required` in each wrangler section makes Wrangler refuse a deploy while one is unset, and `src/config.ts` validates the serving Worker's at startup. No two secrets may share a value; generate each with `openssl rand -hex 32`. List secret names with `pnpm exec wrangler secret list` for production (`rendro`) and `pnpm exec wrangler secret list --env development` for development (`rendro-dev`). Production uses the top-level configuration; there is no named `--env production` environment.

`CONVEX_URL` and the optional `CONVEX_SITE_URL` override remain outside `secrets.required`: startup and `/health` work without them, but sign-in and comments need a Convex origin.

```bash
pnpm exec wrangler secret put <NAME>                                  # serving Worker
pnpm exec wrangler secret put <NAME> --config wrangler.ingest.toml    # ingest Worker
pnpm exec wrangler secret put <NAME> --config wrangler.control.toml   # control Worker
pnpm run deploy
```

`pnpm run deploy` runs `pnpm build:assets` before `wrangler deploy`; a bare `wrangler deploy` from a fresh checkout ships without the git-ignored bundles. For the development Workers, add `--env development` to each `wrangler secret put` and deploy: `pnpm run deploy --env development` for `rendro-dev` (`dev.rendro.app`), `pnpm exec wrangler deploy --config wrangler.ingest.toml --env development` for `rendro-ingest-dev`, and the same with `wrangler.control.toml` for `rendro-control-dev`. Without `--env`, the ingest and control commands target the production Workers. Use the explicit `run`: `pnpm deploy` is an unrelated pnpm command. See [Deploy Commands](TECHNICAL.md#deploy-commands) and [Environment Variables (Workers)](TECHNICAL.md#environment-variables-workers).

`/r/` stays a 404 in production until the [checklist](#production-readiness-checklist) passes: the read path's bindings are not wired there yet.

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
| `pnpm preflight:prod` | Check production's wrangler sections (and, with `--online`, its secret and Convex env var names) against the manifest ([Production readiness checklist](#production-readiness-checklist)) |
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
├── scripts/                  # Asset, font, style and wasm builds; ledger; R2 exposure check; coverage gate; production manifest and preflight
├── public/                   # Static assets (bundles are built, not committed)
├── tests/                    # Vitest suites and fixtures; ui-transitions.json registry
├── e2e/                      # Playwright suites, local backend harness, visual and axe specs
├── docs/                     # Product, technical, design docs; archive/ holds dated QA reports
├── .github/workflows/        # quality, stability, r2-public-access
├── wrangler.toml, wrangler.ingest.toml, wrangler.control.toml
└── convex.json
```
