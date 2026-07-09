# Rendro — History & Architecture

A chronological account of every technical decision, trade-off, and phase from inception to production.

---

## Phase 0: Vision (Week 1)

**Problem**: Documentation tools force teams into proprietary editors (Confluence, Notion) or complex build pipelines (Docusaurus, Nextra). Engineers want docs versioned alongside code, edited as plain HTML, and deployed instantly.

**Core insight**: The file IS the document. No database, no CMS, no rich-text editor. HTML files in a Git repo, CI pushes them to object storage, visitors read them live. Auth is the only server-side concern.

**Initial stack decision:**
- **MinIO** (S3-compatible) for blob storage — one bucket, org-prefixed keys
- **Hono** (Node.js) for the web server — lightweight, TypeScript-first, multi-runtime
- **better-auth** with SQLite for sessions — quick to set up, Google OAuth support
- **Vanilla JS** for the tree UI — zero framework overhead, 8KB IIFE
- **Convex** for comments — real-time, serverless, no ops

---

## Phase 1: docsync — Core Platform (Week 1-2)

### What was built

**SSR doc platform with tree UI:**
- Server-rendered page shell (Hono) with header, sidebar, content iframe
- Lazy tree: top-level items rendered server-side, folders expand via API calls
- Document streaming: `GET /files/:key` proxies to MinIO, streams raw HTML to iframe
- Commentor widget: injected into doc pages, Convex-backed inline comments

**Tree features (iterative):**
1. **Basic tree** — recursive `listObjects` fetches all files on page load
2. **Lazy loading** — `listImmediate` returns one level at a time, Delimiter:"/" for folders
3. **Infinite scroll** — paginated tree API with `MaxKeys`/`StartAfter`, "Load more" button
4. **Sticky headers** — CSS `position: sticky` with depth-based `top` and z-index
5. **Active indicator** — sliding highlight bar showing current doc position
6. **Cross-doc navigation** — postMessage between iframe and parent syncs tree + history
7. **Browser history** — pushState/popstate for back/forward navigation
8. **Dark mode** — toggle in header, persisted to localStorage, shared with commentor

**Auth (initial):**
- better-auth with SQLite (`better-sqlite3`) for session storage
- Google OAuth provider
- Email-domain-based org derivation: `alice@acme-corp.com` → org `acme-corp`
- Org creation: first user from domain creates org folder in MinIO

**CLI (initial):**
- TypeScript source, esbuild bundling
- Hash-based diffing: MD5 local vs MinIO ETag
- Walk → check → upload pipeline

### Key decisions

| Decision | Choice | Why |
|---|---|---|
| Tree rendering | Vanilla JS | Zero deps, 8KB, works with SSR |
| Lazy vs eager | Lazy (`listImmediate`) | One S3 call per level, not O(n) |
| Sticky headers | CSS sticky | Zero JS, GPU-accelerated |
| iframe vs fetch | iframe | Native nav, sandboxed scripts |
| Soft-delete | Convex table | Single query vs N S3 tag calls |

---

## Phase 2: Rename & Convex Migration (Week 2-3)

### docsync → Rendro

Rebranded from "docsync" to "Rendro" — shorter, more memorable, no descriptive baggage.

**Changes:**
- Package name, CLI command, env vars, file paths
- `DOCSYNC_API_KEY` → `RENDRO_API_KEY`
- `docsync-auth.db` → kept for backward compat

### SQLite → Convex migration

**Problem**: SQLite on the server works for local dev but is a single point of failure. Comments were already in Convex — why not everything?

**Migration**: Non-auth data moved to Convex:
- `api_keys` table — key hashes per org (was SQLite)
- `deleted_files` table — soft-delete records (was SQLite)
- `threads`, `replies` — already in Convex

**Trade-off**: SQLite for auth sessions kept because better-auth's SQLite adapter works well. Auth migration deferred.

---

## Phase 3: Cloudflare Workers & D1 (Week 3-4)

### Why Workers

- **Global edge**: 300+ data centers, sub-100ms response from anywhere
- **Serverless**: No Node.js process to manage, no Docker, no scaling concerns
- **R2 integration**: Zero egress fees, native S3 API
- **Cost**: Free tier handles thousands of requests/day

### Deployment prep

**Workers-compatible changes:**
- Removed `better-sqlite3` (native binary, doesn't work in Workers)
- Switched auth to `memoryAdapter` (Workers-compatible)
- Lazy `ConvexClient` init (avoids WebSocket in global scope)
- `nodejs_compat` flag in wrangler.toml

**D1 for auth (attempted):**
- Cloudflare D1 as session store with `better-auth-cloudflare` / `d1Native`
- **Failed**: Tables not auto-created by drizzle adapter
- **Fix**: Manually created D1 schema (user, session, account, verification tables)
- **Result**: Worked temporarily, later replaced by Convex

**R2 for docs:**
- Replaced MinIO with Cloudflare R2
- Same S3 API, zero egress, global distribution
- `wrangler.toml` configured with R2 bucket binding

**DOMParser polyfill:**
- AWS SDK S3 client uses `DOMParser` for XML parsing
- Workers runtime lacks browser DOM APIs
- Built IIFE polyfill: `XmlNode` class, XML parser, `documentElement`, `nodeValue`
- **esbuild tree-shaking issue**: Conditional guard evaluated at build time → polyfill removed
- **Fix**: IIFE pattern prevents tree-shaking

### OAuth debugging saga

The OAuth flow broke repeatedly in Workers. Root causes discovered:

1. **D1 tables not created** → `no such table: verification` → manually created schema
2. **DOMParser not defined** → AWS SDK failed at XML parsing → built polyfill
3. **polyfill tree-shaken** → esbuild removed conditional code → IIFE pattern
4. **Cookie header stripped** → Workers proxy dropped cookies → curated header allowlist
5. **Set-Cookie Domain=convex.site** → browser rejected cookies → strip Domain attribute
6. **redirect loops → 522** → fetch followed 302 redirects → `redirect: "manual"`
7. **wrangler deploying wrong project** → picked up todo-app → `--config wrangler.toml`

### Session verification (broken)

- Token in DB vs signed JWT in cookie → lookup mismatch
- `verifySession` query looked up raw token → never matched
- Fix: use better-auth's built-in `get-session` endpoint

---

## Phase 4: Convex Auth (Week 4-5)

### Why Convex for auth

D1 worked but had issues:
- No built-in migration system for better-auth schema
- Workers I/O limitation: `ConvexClient` (WebSocket) can't persist across requests
- Two databases (Convex + D1) meant two systems to maintain

**Decision**: Run better-auth entirely in Convex HTTP actions. Workers proxies requests.

### Architecture

```
Browser → Workers (Hono) → Convex HTTP action (better-auth + convexAdapter)
                          → R2 (doc streaming)
```

**Convex side:**
- `@convex-dev/better-auth` component registered in `convex.config.ts`
- Auth tables (user, session, account, verification) in Convex component
- HTTP action (`convex/http.ts`) handles all `/api/auth/*` routes
- `convexAdapter(ctx)` connects better-auth to Convex tables

**Workers side:**
- Auth proxy: forward requests to Convex, strip Domain from Set-Cookie
- Cookie forwarding: curated header allowlist (cookie, content-type)
- Session middleware: calls Convex `get-session` to validate cookies

### Workers I/O fix

`ConvexClient` uses WebSocket — Workers can't reuse WebSocket across requests.

**Fix**: `api-keys.ts` and `soft-delete.ts` use raw HTTP calls to Convex REST API:
```ts
POST https://<deployment>.convex.cloud/api/query
POST https://<deployment>.convex.cloud/api/mutation
```

No WebSocket, no persistent connection, fully Workers-compatible.

### Static file serving

`lazy-tree.js` and `commentor.js` returned 404 in Workers because Hono catches all routes before ASSETS binding.

**Fix**: Explicit routes for static files that call `env.ASSETS.fetch()`.

---

## Phase 5: CLI & CI (Week 5)

### CLI distribution

- **Zero dependencies**: Uses only Node.js built-ins (crypto, fs, path)
- **npm package**: 4.7KB, `npm install -g rendro`
- **Direct download**: `curl -sL .../bin/rendro.mjs -o rendro`
- **Bin entry**: `package.json` → `"bin": {"rendro": "./bin/rendro.mjs"}`

### CI/CD

- GitHub Actions workflow in test repo
- On push to main: walk docs → hash check → upload changed → delete removed
- `RENDRO_API_KEY` secret for auth
- 200 docs uploaded in 4m30s (avg 1.3s per file)

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Workers                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Hono App                                                   │  │
│  │  ├─ DOMParser/Node polyfill (IIFE)                         │  │
│  │  ├─ Env bridging middleware                                 │  │
│  │  ├─ Session middleware → Convex get-session                 │  │
│  │  ├─ Auth proxy /api/auth/* → Convex HTTP actions            │  │
│  │  ├─ App routes (landing, org creation, tree rendering)      │  │
│  │  ├─ Docs routes (file streaming, sync API, tree API)       │  │
│  │  ├─ Static files (ASSETS binding)                           │  │
│  │  └─ Sign-out handler (GET → POST proxy)                     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐     ┌──────────────┐      ┌──────────┐
   │  Convex   │     │  R2 Bucket   │      │ GitHub   │
   │  - Auth   │     │  rendro-docs │      │  Actions │
   │  - Cmts   │     │  org/**.html │      │  CI Sync │
   │  - Keys   │     └──────────────┘      └──────────┘
   │  - Del    │
   └──────────┘
```

## Database & Storage

### Convex Tables

| Namespace | Table | Purpose |
|---|---|---|
| **Component** | `user` | User accounts |
| **Component** | `session` | Login sessions (JWT tokens) |
| **Component** | `account` | OAuth provider accounts |
| **Component** | `verification` | OAuth state tokens |
| **Component** | `jwks` | JWT signing keys |
| **App** | `threads` | Comment threads |
| **App** | `replies` | Comment replies |
| **App** | `api_keys` | API key hashes |
| **App** | `deleted_files` | Soft-delete records |

### R2 Structure

```
rendro-docs/
├── gmail/
│   ├── index.html
│   ├── api/
│   │   └── overview.html
│   └── getting-started/
│       └── quickstart.html
└── acme-corp/
    └── handbook.html
```

## API Surface

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /` | Session | Landing / org docs |
| `GET /health` | None | Health check |
| `POST /api/orgs` | Session | Create org + generate API key |
| `GET /files/:key{.+}` | Session | Stream HTML doc (with commentor injection) |
| `GET /api/tree/:org` | Session | Lazy-load tree children |
| `POST /api/auth/*` | Proxy | Auth → Convex |
| `GET /api/auth/*` | Proxy | Auth → Convex |
| `GET /api/auth/sign-out` | Proxy | Sign-out handler |
| `POST /api/sync/upload` | API Key | Upload doc |
| `GET /api/sync/check` | API Key | Check file + hash |
| `GET /api/sync/list` | API Key | List org files |
| `DELETE /api/sync/delete` | API Key | Soft-delete file |

## Key Technical Decisions

| # | Decision | Alternatives Considered | Why |
|---|---|---|---|
| 1 | HTML over Markdown | Markdown with renderer | Publisher owns rendering, no sanitization pipeline |
| 2 | Convex for auth | D1, KV, Durable Objects | Built-in schema, HTTP actions, better-auth component |
| 3 | Workers proxy to Convex | Direct Convex HTTP, D1 | Serverless, no database maintenance, global edge |
| 4 | DOMParser polyfill | fast-xml-parser, Node.js bundle | Minimal, self-contained, no extra deps |
| 5 | Hash-based diffing | Timestamps, git-based | Content determines staleness, deterministic in CI |
| 6 | iframe doc rendering | fetch + innerHTML | Native navigation, sandboxed scripts |
| 7 | Soft-delete over hard-delete | Hard delete | Recovery window, direct URL access preserved |
| 8 | CSS sticky headers | IntersectionObserver | Zero JS, GPU-accelerated, natural stacking |
| 9 | Email-domain orgs | Per-org config, WorkOS | Zero setup, self-service, no dashboard |
| 10 | Zero-dep CLI | Bundled runtime | Instant install, no dependency conflicts |

## Lessons Learned

1. **esbuild tree-shakes conditionals** — `typeof DOMParser === "undefined"` evaluates at build time. Use IIFE for runtime guards.
2. **Workers WebSocket can't cross requests** — `ConvexClient` must be per-request. Use REST API instead.
3. **Set-Cookie Domain mismatch kills auth** — proxy must strip Domain attribute from upstream cookies.
4. **wrangler picks wrong project** — always use `--config wrangler.toml`.
5. **better-auth state is in cookies, not DB** — OAuth state validation requires the `__Secure-better-auth.state` cookie, not just the DB entry.
6. **fetch follows redirects by default** — use `redirect: "manual"` to prevent 302 loops causing 522 errors.

## Current State (July 2026)

- **Deployed**: `https://rendro.app` on Cloudflare Workers
- **Auth**: Convex component (better-auth) with Google OAuth
- **Storage**: R2 (docs), Convex (auth, comments, keys)
- **CLI**: npm package (4.7KB), zero dependencies
- **CI**: GitHub Actions auto-sync on push
- **Docs**: 200 styled HTML files across 6 topic folders
- **Tests**: 53 unit tests passing
