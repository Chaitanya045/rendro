# Architecture observations

_Recorded 2026-10-15 from `main` at `6e22d7f`._

## Shape of the system

```text
Browser / CI (CLI)
      │ session cookie or scoped API key
      ▼
Cloudflare Worker (Hono)                         src/
  ├─ /api/auth/* proxy ──► Convex HTTP actions running Better Auth (convex/betterAuth/)
  ├─ metadata API ───────► Convex HTTP actions (convex/*Http.ts)
  └─ file delivery ──────► R2 through the native STORAGE binding (src/storage.ts; Miniflare locally)
```

- `src/worker.ts` (Workers) and `src/index.ts` (local Node via `@hono/node-server`)
  both mount the same routes from `src/app-routes.ts`. Each entry point owns its
  own middleware, static assets and error handling, so changes to one often
  need the same change in the other.
- Storage is the Worker's native R2 binding (`STORAGE`); there are no S3 keys.
  `src/storage.ts` is the only code that touches the bucket. The local Node server
  borrows Miniflare's R2 simulation (`src/local-storage.ts`).
- The browser never talks to Convex directly. Everything goes browser → Worker →
  Convex HTTP action. Much of the session-cache, signed-IP-proof and rate-limit
  machinery in `docs/TECHNICAL.md` exists because of that hop.

## UI layer

- No UI framework. Pages are TypeScript functions returning template-literal
  HTML (`src/routes/*-pages.ts`), escaped with `escapeHtml` (`src/routes/html.ts`).
  Inline scripts carry CSP nonces (`src/middleware/html-nonce.ts`).
- Browser behavior is vanilla TS bundled by esbuild into committed IIFEs in
  `public/*.js` (`scripts/build-*.ts`). The bundles are versioned. Changing their
  source requires `pnpm build:assets`, and `pnpm verify:assets` fails on drift.
  Management controller changes also need `MANAGEMENT_SHELL_VERSION` bumped
  (`src/routes/management-navigation.ts`).
- Hand-built pieces a framework would normally provide: select/menu component
  (`src/ui/select.ts`), query cache (`src/management-query/`, on TanStack
  query-core), client navigation (`src/routes/management-navigation.ts`),
  loading pages and an asset-version ledger (`scripts/asset-version-ledger.ts`).
- Publisher HTML renders in a sandboxed iframe. The parent (`src/viewer/`,
  `src/lazy-tree/`, `src/commentor/parent-*`) talks to it over postMessage.
  In-document link navigation needs a confirmation in the parent (#76, #78).

## Data and storage

- Convex tables are in `convex/schema.ts`. Several legacy tables (`threads`,
  `replies`, `api_keys`, `deleted_files`, `legacyCommentStatusReceipts`) remain
  for the slug-to-organization migration window.
- Deployments are immutable namespaces described by SHA-256 manifests. A push
  copies unchanged files server-side in batches of 16 (Worker subrequest budget)
  and activates atomically.

## Testing

- Vitest has two projects: `unit` (happy-dom/node, convex-test) and `browser`
  (`*-browser.test.ts`, real Chromium via Playwright, serial). See
  `docs/BROWSER_TESTS.md`.
- Before this effort, coverage only included `src/**/*.ts` and had no
  thresholds. `convex/`, `cli/`, `shared/` and `scripts/` were not measured.
- `pnpm verify` is the full local gate and runs in `.github/workflows/quality.yml`.

## Sharp edges seen so far

- Generated Convex bindings must be regenerated against the DEV deployment and
  committed exactly. CI has only an offline drift guard.
- The host running agents has about 15 GB RAM. Keep about 4 or fewer concurrent
  fixers running vitest/tsc.
- Merging to `main` does not deploy. Dev and prod Worker deploys are manual.
