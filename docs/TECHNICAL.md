# Docsync — Technical

Technology decisions, the data flow, the iterations, the research, and the experiments. For engineers and operators.

## The Cast

- **Browser** — the visitor. Opens `example.com/<org>` to read docs.
- **Docsync server** — a single Hono process on Node.js. Serves HTML, runs the SSO dance, brokers file access.
- **WorkOS** — identity provider. Routes users to the right corporate IdP, mints the SSO profile.
- **Identity provider (IdP)** — the customer's actual auth source (Okta, Entra, Google, etc.). The IdP is configured per WorkOS org; we never see the user's password.
- **MinIO** — object store. Holds raw HTML files. One bucket, namespaced by org.

(No application database — see "Why no database" below.)

## Data Flow

### Visitor reads a doc

```
Browser               Docsync                              WorkOS                MinIO
  │                      │                                     │                     │
  │ GET /acme-corp/x.html│                                     │                     │
  │─────────────────────>│                                     │                     │
  │                      │ 1. Read JWT cookie                  │                     │
  │                      │ 2. resolveOrg("acme-corp")         │                     │
  │                      │    (cache, then WorkOS lookup)     │                     │
  │                      │ 3. Check user.org == "acme-corp"     │                     │
  │                      │ 4. GetObject("acme-corp/x.html")     │                     │
  │                      │──────────────────────────────────────────────────────>│
  │                      │ 5. Stream bytes back                 │                     │
  │                      │<──────────────────────────────────────────────────────│
  │ 200 text/html         │                                     │                     │
  │<─────────────────────│                                     │                     │
```

### Visitor logs in

```
Browser               Docsync                WorkOS                IdP
  │                      │                      │                   │
  │ GET /acme-corp       │                      │                   │
  │─────────────────────>│                      │                   │
  │ 302 /api/auth/.../login (or single /api/auth/callback — see Phase 4) │
  │<─────────────────────│                      │                   │
  │                      │ getAuthorizationUrl  │                   │
  │                      │  { org: "org_01KW…", │                   │
  │                      │    redirectUri,      │                   │
  │                      │    state (org+nonce) }                   │
  │                      │─────────────────────>│                   │
  │                      │  URL                 │                   │
  │                      │<─────────────────────│                   │
  │ 302 → WorkOS SSO      │                      │                   │
  │<─────────────────────│                      │                   │
  │                      │                      │ route to IdP      │
  │                      │                      │──────────────────>│
  │ (user authenticates) │                      │                   │
  │<─────────────────────│                      │                   │
  │                      │                      │ 302 → /api/auth/  │
  │                      │                      │  callback?code=…  │
  │<─────────────────────│<─────────────────────│<──────────────────│
  │                      │ getProfileAndToken   │                   │
  │                      │  { code }            │                   │
  │                      │─────────────────────>│                   │
  │                      │ { profile: { id,     │                   │
  │                      │   email, orgId } }   │                   │
  │                      │<─────────────────────│                   │
  │                      │ validate orgId match  │                   │
  │                      │ sign JWT({ sub, email,│                   │
  │                      │   org: "acme-corp" })│                   │
  │                      │ Set-Cookie httpOnly  │                   │
  │ 302 /acme-corp       │                      │                   │
  │<─────────────────────│                      │                   │
```

### CLI push (publisher)

```
Repo                  CI                CLI                  Docsync                MinIO
  │                    │                 │                      │                     │
  │ Edit doc, git push │                 │                      │                     │
  │───────────────────>│                 │                      │                     │
  │                    │ docsync push    │                      │                     │
  │                    │────────────────>│                      │                     │
  │                    │                 │ 1. Walk ./docs       │                     │
  │                    │                 │ 2. MD5-hash each     │                     │
  │                    │                 │ 3. /api/sync/check?  │                     │
  │                    │                 │    key=…&hash=…      │                     │
  │                    │                 │─────────────────────>│                     │
  │                    │                 │ 4. "exists, matches?"│                     │
  │                    │                 │<─────────────────────│                     │
  │                    │                 │ 5. For new/changed:  │                     │
  │                    │                 │    /api/sync/upload   │                     │
  │                    │                 │─────────────────────>│                     │
  │                    │                 │ 6. PutObject         │                     │
  │                    │                 │                      │─────────────────────>│
  │                    │                 │ Done. 3 uploaded.    │                     │
  │                    │                 │<─────────────────────│                     │
```

The CLI is MD5-hashed against existing objects in MinIO — only changed files are uploaded.

## The org boundary — drawn three times

Every request to a doc passes three independent org checks:

```
1. URL:     /acme-corp/*       →  requested org = "acme-corp"
2. JWT:     cookie["org"]      =  "acme-corp"  (from SSO)
3. Storage: MinIO key prefix  =  "acme-corp/"

All three must agree. Mismatch anywhere = 403.
```

This means a token issued for one org cannot read files from another, even if a bug somewhere leaks the token. The org is the only key — there is no permission table, no role mapping, no ACL to forget to check.

## Why no database

The current product has no application database. Orgs and identities live in WorkOS. Files live in MinIO. The JWT cookie carries everything the server needs to authorize a request. There is no sync layer, no local cache of orgs (only a 5-min TTL for WorkOS lookups), no permission table to drift out of sync with reality.

A database may be added later (for things like per-user bookmarks, API keys, audit logs) but only when the product outgrows the zero-database model. Today it doesn't.

## What's optional (not in the current build)

- **A database (if ever needed)** — for things like per-user bookmarks, per-org API keys, or audit logs. The current build has no DB by design — JWT carries everything. See "Why no database" above.
- **CDN** — every request goes through the server. Adding a CDN in front of MinIO would cut latency, but adds a cache-invalidation problem on push.
- **Webhooks** — WorkOS events (org created, user invited) are not subscribed. Polling + cache TTL is the current pattern.

## Tech Stack — What and Why

### Hono (web framework)

**Chosen over Express.** Hono is tiny (~14kb), runs on every JS runtime (Node, Bun, Deno, Workers), and has first-class TypeScript and JSX support. Express is heavier and TS support is bolted on.

**Trade-off:** smaller ecosystem. Most Express middleware doesn't work. For our needs (cookie handling, JWT, raw response streaming) Hono's built-ins are enough.

### MinIO (object store)

**Chosen over localstack or a filesystem mount.** MinIO is S3-compatible, so swapping to real S3 in production is a one-line env change. The same SDK works against both. A filesystem mount would have meant writing our own directory traversal and locking logic.

**Trade-off:** another container to run locally. A `docker compose up minio` is a 30-second cost.

### jose (JWT)

**Chosen over jsonwebtoken.** jose is modern, ESM-first, supports all the modern JWS/JWE/JWK standards, and is smaller. The TypeScript types are first-class.

**Trade-off:** none for our use case. We sign HS256 — the simplest algorithm.

### better-auth (auth)

**Chosen over WorkOS and convex-auth.** better-auth has first-class Hono integration, Google OAuth provider, and SQLite-backed sessions. convex-auth is Convex-only (requires Convex functions). WorkOS was dropped due to the redirect URI configuration headache (N URIs for N orgs).

**Trade-off:** requires a database (SQLite via better-sqlite3) for sessions. The zero-DB design from Phase 3 is replaced by a single-file SQLite store for auth metadata only — docs remain in MinIO.

### pino (logging)

**Chosen over console.log.** Structured JSON output in production, pretty-printed in dev. `pino-pretty` plugin handles the dev formatting. Has child loggers for request context. The async API doesn't block the event loop.

**Trade-off:** another dep. Worth it for the request-IDs and per-route context.

### zod (env validation)

**Chosen over manual validation.** The env schema is the contract between the developer and the runtime. One Zod schema = one place to read what the app needs. Validation errors are formatted as a list, fail-fast at startup.

**Trade-off:** a 200kb dep. But we already pull zod for the SSO SDK, so it costs nothing extra.

### vitest (testing)

**Chosen over jest or mocha.** Vitest is fast (esbuild-based), has native TypeScript, native ESM, and a Jest-compatible API. Jest still doesn't have great ESM support.

**Trade-off:** some jest plugins don't work. For our tests (53 unit + integration), it just works.

## Org Isolation — Email Domain Based

Every request derives the org from the authenticated user's email domain and checks it against the file path:

```
1. Session: better-auth cookie → email: "alice@acme-corp.com"
2. Org:     emailToOrgSlug(email) → org = "acme-corp"
3. Path:    /files/acme-corp/api/index.html → org prefix check ("acme-corp/")
4. Storage: MinIO key prefix = "acme-corp/"

Org mismatch → 403.
```

The org is the email domain. There is no per-org env var, no permission table, no role mapping. Users from `acme-corp.com` only see `acme-corp/` files.

## Iterations

### Phase 1 — Manual OIDC, env-var org mapping (initial build)

The first version wrote its own OIDC client. Every org needed four env vars:

```
ORG_ACME_CORP_OIDC_ISSUER=https://accounts.google.com
ORG_ACME_CORP_OIDC_CLIENT_ID=...
ORG_ACME_CORP_OIDC_CLIENT_SECRET=...
ORG_ACME_CORP_DOMAINS=acmecorp.com
```

Plus the routing code had to call the IdP endpoints directly, decode the JWT manually, check the email domain.

**Why we left:** ~100 lines of OIDC dance code per provider, four env vars per org, and a manual email-domain allowlist. Onboarding a new customer required setting up an OIDC app in their IdP, getting the client secret, and configuring four env vars. Days of work.

### Phase 2 — WorkOS SDK, same env-var mapping

Replaced the OIDC client with the WorkOS SDK. Auth flow dropped to ~50 lines. Per-org config collapsed to one env var:

```
ORG_ACME_CORP_WORKOS_ORG_ID=org_01ABCDEF
```

**Why we left:** still N env vars for N orgs. For a 100-customer prod, that's 100 env vars to manage. Onboarding still required a dashboard click in WorkOS to find the org ID.

### Phase 3 — Option B: lookup by external_id (replaced)

Replaced the env-var mapping with a live WorkOS lookup. The WorkOS org's `external_id` field IS the URL slug. New customers = zero env config.

**Why we left:** the redirect URI headache. WorkOS requires every callback URL to be registered (`/api/auth/acme-corp/callback`, `/api/auth/startup-io/callback`, ...). For prod with 100+ orgs, this is 100+ dashboard clicks.

### Phase 4 — better-auth + email-domain orgs (current)

Dropped WorkOS entirely. Switched to better-auth with Google OAuth for sign-in, and email-domain-based org derivation (no org in the URL, no per-org WorkOS setup).

**Architecture:**

```
User visits / → "Sign in with Google" → Google OAuth →
  better-auth callback → session cookie → email = "alice@acme-corp.com" →
    derive org = "acme-corp" → check MinIO for "acme-corp/" →
      exists → doc tree | missing → "create org" form
```

- **Auth:** better-auth with SQLite sessions, Google OAuth provider
- **Org derivation:** `emailToOrgSlug(email)` — email domain IS the org
- **File access:** `/files/acme-corp/api/index.html` — org prefix validated against email-derived org
- **New org creation:** first user from a domain sees "create your org" form, submits to `POST /api/orgs`

**Why this is the right design:**
- Zero per-org configuration — no env vars, no WorkOS org mapping, no redirect URI registration
- One Google OAuth client for all tenants
- One callback URL for all sign-ins
- Org creation is self-service — users create their org on first visit
- The email domain IS the authorization boundary

**Trade-off:** requires a SQLite database for sessions. Docs remain in MinIO. Auth metadata + API keys live in SQLite.

## CLI & Per-Org API Keys

### Diff-based upload

The CLI (`docsync push`) walks the docs directory, MD5-hashes each file, and calls the sync check endpoint for each one. The server compares the hash against the MinIO ETag:

```
CLI                           Server                    MinIO
  │                              │                        │
  │ Hash each file (MD5)         │                        │
  │ GET /api/sync/check?         │                        │
  │   key=org/x.html&hash=abc    │                        │
  │─────────────────────────────>│                        │
  │                              │ HeadObject(org/x.html) │
  │                              │───────────────────────>│
  │                              │ { ETag: "def" }        │
  │                              │<───────────────────────│
  │  hash abc ≠ ETag def → upload│                        │
  │<─────────────────────────────│                        │
  │                              │                        │
  │ POST /api/sync/upload        │                        │
  │─────────────────────────────>│ PutObject(org/x.html)  │
  │                              │───────────────────────>│
```

Changed files only — no full re-upload.

### Per-org API keys

Each org gets a unique API key on creation (`docsk_...`). The key is SHA-256 hashed and stored in SQLite. Only the raw key is shown once — in the org creation page.

```
POST /api/orgs → createOrgApiKey("demo-org") → "docsk_Qx2f..."
                    ↓
              SHA-256 hash stored in api_key table
                    ↓
              Key shown once in browser
                    ↓
         User copies to CI: DOCSYNC_API_KEY=docsk_Qx2f...
```

**Validation flow:**

```
CLI sends: Authorization: Bearer docsk_Qx2f...
Server: SHA-256(docsk_Qx2f...) → lookup in api_key → org = "demo-org"
Upload key "demo-org/x.html" must start with "demo-org/" → enforced
```

The key is tied to one org — it can't upload to another org's prefix.

### Sync-deletes (`--sync-deletes`)

By default, `docsync push` only uploads changed files — it never deletes. Files removed from the local `docs/` folder stay in MinIO and remain served. This is the safe default for most CI pipelines.

The `--sync-deletes` flag enables full sync: files that exist in MinIO but not locally are deleted. Use it to keep the live docs in exact sync with the source repo.

```
$ docsync push --source ./docs --org acme-corp --sync-deletes

  ✓ acme-corp/index.html (unchanged)
  ↓ acme-corp/old-page.html (deleted)
  1 deleted, 0 uploaded, 2 skipped, 2 total.
```

**Safety:** the DELETE endpoint validates the API key's org prefix and rejects path traversal (`..`). A key for org A cannot delete files from org B.

## Research

### WorkOS Redirect URI wildcards (from the docs)

> "Wildcards can be used for **subdomains**, NOT path components."

So `https://*.example.com/api/auth/callback` works. `https://example.com/api/auth/*/callback` does not. This rules out the simplest "one URI for all orgs" solution while keeping path-based orgs.

### Discovered: programmatic redirect URI management

The WorkOS API has an endpoint for adding redirect URIs without going to the dashboard:

```
POST /user_management/redirect_uris
```

This means the "headache" can be partially automated — add the URI via API when a new org is provisioned. But it's still a one-by-one operation. The single-callback approach (Phase 4) is the cleaner answer.

### Subdomain vs single-callback vs per-org-URI

| Approach | Pros | Cons |
|---|---|---|
| **Per-org URI** (current) | Matches today's URL design | N URIs to manage, N dashboard clicks |
| **Single callback** (Phase 4) | One URI total | URL no longer has the org in the path |
| **Subdomain-based** (`acme.docs.example.com`) | Industry standard, one wildcard URI | DNS + wildcard cert + cross-subdomain cookies + bigger refactor |

For the current path-based design, single-callback is the right move. For a greenfield prod, subdomain-based is the right starting point.

## Experiments

### `bun` → `pnpm` migration

Started on Bun for the package manager and runtime. Discovered Bun doesn't auto-load `.env` (Node does, with `--env-file`). Switched to `pnpm` for the package manager and `tsx` for TypeScript execution, then `@hono/node-server` for the runtime.

**Why:** `pnpm` has the best monorepo story, `tsx` is the fastest TS runner, `@hono/node-server` is the supported Node adapter. Bun is still used for local dev elsewhere; we just don't depend on its `Bun.write` or `Bun.serve` globals.

### `Bun.serve` → `@hono/node-server`

The first version of `index.ts` used Bun's native serve:

```ts
export default { port: PORT, fetch: app.fetch };
```

Works only on Bun. Switched to:

```ts
import { serve } from "@hono/node-server";
serve({ fetch: app.fetch, port: PORT });
```

Now the server is portable to anything that runs Node.

### `tsc --noEmit` for type checking

Added `tsconfig.json` with `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`. The `pnpm typecheck` script runs `tsc --noEmit` — it checks types without emitting, so it runs fast and integrates with the editor.

**What it caught in the first pass:** unused imports (`stat`, `extname`, `basename` in the CLI), inline type assertions that hid bugs, dynamic imports where static would do. Now the codebase has zero type errors.

### `eslint` with TypeScript-ESLint flat config

ESLint 9+ uses the new flat config (`eslint.config.mjs`). Set up with:
- `@typescript-eslint/recommended-type-checked` for the type-aware rules
- `no-unused-vars` with `_` prefix for allowed unused
- `consistent-type-imports` for `import type`
- `no-non-null-assertion` banned
- Test file override for the no-non-null rule (tests need `as` for mocking)

`pnpm lint` runs `eslint .`, `pnpm fix` runs `eslint --fix .`.

### `vitest` test suite — 53 tests

Test coverage:
- **Config validation** (Zod schemas) — defaults, required fields, sync token
- **JWT sign/verify** — round-trip, expired, tampered, wrong algorithm, `alg:none` bypass attempt
- **WorkOS SSO** — unknown org, callback with valid/invalid code
- **MinIO tree builder** — single file, nested folders, empty, deep nesting, file/folder name collision
- **Routes (Hono)** — auth guard redirects, sync API auth, cross-org 403, malformed JSON
- **Edge cases** — URL-encoded paths, double slashes, very long URLs, expired JWT, no JWT

All tests mock the WorkOS SDK via `vi.mock` in `tests/setup.ts`. The mock factory defines a `NotFoundException` class so `instanceof` checks in `org-registry.ts` work correctly.

### Browser E2E with real WorkOS

Used the browser tool to simulate a real user:
- Sign in to WorkOS dashboard with Google
- Create org `org_01KW54PVSFW46HAGEQSX9SHHMA` (acme-corp) with `external_id="acme-corp"`
- Add `Test Provider` SSO connection
- Register redirect URI `http://localhost:3000/api/auth/acme-corp/callback`
- Open `http://localhost:3000/acme-corp` in browser
- Fill Test IdP form with `user@acmecorp.com` + first/last name
- Verify JWT set, listing rendered, streaming works

Created a second org (`org_01KW55PQ9DNXPPNCME1M7DEWW5`, startup-io) and verified:
- Same flow works for second org
- Cross-org access blocked at route layer (403)
- Cross-org signin blocked at WorkOS layer ("Profile domain does not belong to the target Organization")
- A user from startup-io cannot get a valid JWT for acme-corp (no shared IdP)

### `tsc --noEmit` as part of the gate

The full quality gate is now:
```
$ pnpm typecheck   →  0 errors
$ pnpm lint        →  0 errors
$ pnpm test        →  53/53 tests pass
```


## Lazy Tree & Infinite Scroll

The sidebar tree uses **one-level-at-a-time** fetching for scalability:

### Initial page load
```
Browser                          Server                    MinIO
  │                                │                         │
  │ GET /?dev_user=...             │                         │
  │───────────────────────────────>│                         │
  │                                │ listImmediate("org/")   │
  │                                │ S3 ListObjectsV2        │
  │                                │ Delimiter: "/"          │
  │                                │ (one level only)        │
  │                                │────────────────────────>│
  │                                │ files + folder markers  │
  │                                │<────────────────────────│
  │ HTML: top-level items only     │                         │
  │<───────────────────────────────│                         │
```

### Folder expansion (lazy)
```
User clicks folder → lazy-tree.js → GET /api/tree/:org?prefix=org/api/&limit=50
  → Server: listImmediate("org/api/", { maxKeys: 50 })
  → Returns: { children: [...], isTruncated: true, nextStartAfter: "org/api/doc-0050.html" }
  → Client renders children + "Load more" button if truncated
```

### Load more (pagination)
```
User clicks "Load more" → GET /api/tree/:org?prefix=...&startAfter=org/api/doc-0050.html&limit=50
  → Server: listImmediate(prefix, { maxKeys: 50, startAfter: ... })
  → Appends new items to existing children
```

**Performance:** Initial load ~77ms (top-level only). Folder expansion ~40ms (50 items per page). No recursive listing ever.

## Cross-Doc Navigation Sync

When a user clicks a link inside a doc that points to another doc in the same org:

```
Iframe (doc)                    Parent (tree page)
  │                                │
  │ User clicks <a href="/files/org/welcome.html">
  │ Injected script intercepts     │
  │ postMessage({type:"doc-navigate", path:"welcome.html"})
  │───────────────────────────────>│
  │                                │ loadDoc("org/welcome.html", true)
  │                                │ 1. Set iframe.src (navigate)    │
  │                                │ 2. syncActiveState (update tree)│
  │                                │ 3. history.pushState            │
  │ New doc loads in iframe        │
  │<───────────────────────────────│
  │                                │
  │ doc-loaded postMessage         │
  │───────────────────────────────>│
  │                                │ syncActiveState (no iframe reload)
  │                                │ Expands parent folders if needed
```

### Browser history (back/forward)
```
User clicks back → popstate event → loadDoc(state.docPath, false)
  → Loads doc in iframe (no pushState)
  → Updates tree active state
```

## Soft-Delete

Files are never hard-deleted from MinIO. Instead, deletions are tracked in SQLite:

```
deleted_file table: (orgSlug, fileKey, deletedAt)
```

- **Tree listing**: filtered out by `isDeleted(key)` check
- **Direct URL access**: still works (file stays in MinIO)
- **Re-upload**: automatically un-deletes (removes from `deleted_file` table)
- **CLI `--sync-deletes`**: marks deleted files, doesn't remove from storage

## UI Architecture

### Layout
```
┌─────────────────────────────────────────┐
│ Topbar (56px): logo, search, avatar     │
├──────────┬──────────────────────────────┤
│ Sidebar  │ Content Area (iframe)        │
│ (280px)  │                              │
│          │                              │
│ Org name │  ┌─────────────────────────┐ │
│ ──────── │  │ Doc HTML (from MinIO)   │ │
│ Tree     │  │ + Commentor widget      │ │
│ (lazy)   │  │ + Nav tracking script   │ │
│          │  └─────────────────────────┘ │
│ Sign out │                              │
├──────────┴──────────────────────────────┤
```

### Components
- **SSR page shell**: Hono renders header + sidebar + tree (top-level only) + placeholder
- **lazy-tree.js** (8.5KB IIFE): handles folder expansion, infinite scroll, active indicator, history
- **Commentor widget**: injected into each doc page (iframe), Convex-backed inline comments
- **Nav tracking script**: injected into each doc page, intercepts link clicks via postMessage

### Color scheme
Matches the commentor widget: white `#fff` background, blue `#0a66c2` accent, Inter font.
