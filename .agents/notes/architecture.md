# Architecture observations

_Recorded 2026-10-15 from `main` at `6e22d7f`; updated 2026-10-20 after #286 (GitHub-only pivot: uploads, organizations, projects, API keys and Google sign-in removed)._

## Shape of the system

```text
Browser
      │ session cookie, repository capability cookie
      ▼
Serving Worker (Hono, src/worker.ts)             wrangler.toml
  ├─ /api/auth/* proxy ──► Convex HTTP actions running Better Auth (convex/betterAuth/)
  ├─ /r/{owner}/{repo} ──► R2 snapshots, KV epochs, D1 search; control Worker on a capability miss
  └─ pages ──────────────► landing, email auth, /home, /account/security
Ingest Worker (src/ingest/orchestrator/)         wrangler.ingest.toml   GitHub → render → R2 + D1
Control Worker (src/repo-access/)                wrangler.control.toml  GitHub permissions, webhooks, epochs
```

- `src/worker.ts` (Workers) and `src/index.ts` (local Node via `@hono/node-server`)
  both mount the same routes from `src/app-routes.ts`. Each entry point owns its
  own middleware, static assets and error handling, so changes to one often
  need the same change in the other. The Node server has no read-path bindings:
  `/r/` works only in the E2E harness and on a configured Worker.
- Access to repository docs follows GitHub, mirrored by the control Worker. A
  cached page view verifies a signed capability cookie and reads one KV epoch;
  GitHub and Convex are reached only on a cookie miss.
- The browser talks to Convex directly only for comments (a short-lived JWT from
  `/api/auth/convex/token`); auth goes browser → Worker → Convex HTTP action. Much
  of the session-cache, signed-IP-proof and rate-limit machinery in
  `docs/TECHNICAL.md` exists because of that hop.

## UI layer

- No UI framework. Pages are TypeScript functions returning template-literal
  HTML (`src/routes/*-pages.ts`, `src/routes/app.ts` for the repository shell),
  escaped with `escapeHtml` (`src/routes/html.ts`). Inline scripts carry CSP
  nonces (`src/middleware/html-nonce.ts`).
- Browser behavior is vanilla TS bundled by esbuild into IIFEs in `public/*.js`
  (`scripts/build-*.ts`), git-ignored and versioned in `scripts/asset-versions.json`.
  Changing their bytes requires a version bump, `pnpm build:assets` and
  `pnpm record:assets`; `pnpm verify:assets` fails on drift.
- Rendered repository pages render in a sandboxed iframe. The shell
  (`src/viewer/`, `src/lazy-tree/`, `src/commentor/parent-*`) talks to it over
  postMessage, and only while the frame shows a document the shell loaded (#296).
  In-document link navigation needs a confirmation in the parent (#76, #78).

## Data and storage

- Convex tables are in `convex/schema.ts`: repository comment grants, threads and
  replies, write-quota buckets and audit events. Better Auth owns users,
  sessions and accounts.
- Snapshots are immutable per commit under R2's `gh/v1/` key schema; a branch
  pointer flips after a whole commit is rendered. Private content is sealed per
  repository.

## Testing

- Vitest has two projects: `unit` (happy-dom/node, convex-test) and `browser`
  (`*-browser.test.ts`, real Chromium via Playwright, serial). Playwright E2E runs
  the real Workers on workerd with a disposable local Convex. Visual baselines
  render in a pinned container. See `docs/BROWSER_TESTS.md`.
- Coverage is 100% per file across Node, browser and subprocess shards;
  `coverage-debt.json` is empty.
- `pnpm verify` is the full local gate and runs in `.github/workflows/quality.yml`.

## Sharp edges seen so far

- Generated Convex bindings must be regenerated against the DEV deployment and
  committed exactly. CI has only an offline drift guard.
- The host running agents has about 15 GB RAM. Keep about 4 or fewer concurrent
  fixers running vitest/tsc.
- Merging to `main` does not deploy. Dev and prod Worker deploys are manual.
