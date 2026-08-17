# Rendro — Technical

Complete technical reference: architecture, data flow, API, design decisions, and operational details.

> For the chronological evolution of these decisions, see [docs/HISTORY.md](HISTORY.md).

---

## Architecture

```text
Browser / CI
      │ session cookie or scoped API credential
      ▼
Cloudflare Workers (Hono)
      ├── Better Auth HTTP proxy ──► Convex component (users, sessions, organizations, teams)
      ├── Rendro metadata API ─────► Convex app tables
      └── immutable file delivery ─► R2
```

### Component Roles

| Component | Technology | Purpose |
|---|---|---|
| **Edge application** | Hono on Cloudflare Workers | Request routing, SSR, auth proxy, authorization handoff, sandboxed file streaming |
| **Identity and tenancy** | Better Auth Convex component | Google/email identity, verified email, sessions, organizations, teams, invitations, roles |
| **Application metadata** | Convex | Projects, immutable deployments, publications, scoped credentials, revocable shares, comments, audit events |
| **Blob storage** | Cloudflare R2 | Deployment manifests and immutable objects under organization-ID prefixes |
| **CLI** | Node.js, bundled to one executable | Manifest hashing, delta upload, provenance, deployment commit, publication management |
| **Browser UI** | Server HTML + vanilla JavaScript | Organization/project operations, lazy document navigation, comments |

---

## Full Auth Flow

```
1. User visits rendro.app → "Sign in with Google" button
2. Browser POST /api/auth/sign-in/social
3. Workers proxy → Convex HTTP action
4. Convex betterAuth stores OAuth state in verification table + signed cookie
5. Convex returns Google OAuth URL with state param
6. Worker returns URL (strips Domain from Set-Cookie)
7. Browser redirects to Google
8. User authenticates with Google
9. Google redirects to /api/auth/callback/google?code=...&state=...
10. Browser sends state cookie + URL params
11. Workers proxy → Convex (forwards cookie header)
12. Convex betterAuth validates:
    a. State cookie signature (signed JWT)
    b. State parameter matches cookie value
    c. State exists in verification table (not expired)
13. Convex exchanges code for tokens with Google
14. Convex creates/updates user in Convex DB
15. Convex creates session (signed JWT token) in Convex DB
16. Convex sets session cookie (__Secure-better-auth.session_token)
17. Convex returns 302 redirect to /
18. Worker returns redirect (strips Domain from Set-Cookie)
19. Browser stores session cookie, follows redirect
20. Browser GET / with session cookie
21. Worker session middleware:
    a. Reads cookie header
    b. Calls Convex GET /api/auth/get-session with cookie
    c. If user returned → c.set("user", user)
22. Organization membership and role checks in Convex determine which organization and project routes the session may access.
```

### Cookie Flow

| Cookie | Set During | Purpose | Format |
|---|---|---|---|
| `__Secure-better-auth.state` | Sign-in (step 4) | OAuth state validation | signed JWT |
| `__Secure-better-auth.session_token` | Callback (step 16) | Session identification | signed JWT |

Both cookies are:
- HttpOnly — not accessible to JavaScript
- Secure — HTTPS only
- SameSite=Lax — sent on same-site navigation
- Path=/ — available to all paths
- No explicit Domain — scoped to request origin (rendro.app)

### Workers Proxy Details

The proxy handles three concerns:

1. **Cookie forwarding**: Curated allowlist of safe headers (cookie, content-type). Host and cf-* headers excluded to prevent misrouting.

2. **Domain stripping**: Convex sets `Domain=convex.site` on cookies. Workers strips the Domain attribute so cookies bind to `rendro.app`.

3. **Redirect control**: `redirect: "manual"` prevents fetch from following 302 redirects — the browser handles redirections.

---

## Tenant Isolation

Every protected operation starts with an opaque Better Auth organization ID. Human-readable slugs are display and URL fields only; they never grant access.

```text
session/API credential
  → organizationId membership or credential binding
  → optional projectId binding
  → role/scope check
  → metadata lookup
  → R2 key derived from stored IDs
```

Enforcement layers:

1. **Identity:** Better Auth validates the session. API keys are random credentials stored only as SHA-256 hashes.
2. **Organization authorization:** Convex resolves current membership and role (`owner`, `admin`, or `member`).
3. **Project authorization:** every project/deployment/publication record stores `organizationId`; cross-organization IDs fail before storage access.
4. **Storage namespace:** committed files live below `tenants/{organizationId}/projects/{projectId}/deployments/{deploymentId}/`.
5. **Public capability:** anonymous publication and share routes resolve an indexed Convex record. They never accept an arbitrary organization prefix.

## Data Storage

### Convex Tables

The Better Auth component owns users, sessions, accounts, verification records, organizations, members, teams, team members, invitations, JWKs, and rate-limit state.

The application schema owns:

| Table | Purpose |
|---|---|
| `projects` | Organization-scoped documentation products and active deployment pointer |
| `deployments` | Immutable manifest metadata, status, provenance, predecessor, retention state |
| `publications` | Indexed global public slug, project/path mapping, tracked or pinned release mode |
| `shareGrants` | Hashed, expiring, revocable private document capabilities pinned to a deployment |
| `apiKeyCredentials` | Hashed organization/project credentials with scopes, expiry, revocation, and last-used timestamp |
| `auditEvents` | Actor/action/resource audit trail for privileged changes |
| `threads`, `replies`, `deleted_files` | Documentation comments and compatibility data |

### R2 Structure

```text
rendro-docs/
└── tenants/{organizationId}/
    └── projects/{projectId}/
        └── deployments/{deploymentId}/
            ├── manifest.json
            └── files/
                ├── index.html
                ├── assets/app.css
                └── reference/api.html
```

Deployment keys are immutable. A push uploads changed objects under a staging deployment, writes its manifest, then atomically changes the Convex project pointer. A failed or interrupted push cannot overwrite the active version. Superseded deployments remain available to pinned publications and unexpired shares until retention permits deletion.

---

## Workers Internals

### Request Pipeline

```
Request
  │
  ├─ 1. DOMParser polyfill (IIFE, module load time)
  ├─ 2. Env bridging (c.env → process.env)
  ├─ 3. CORS (for /api/sync/*)
  ├─ 4. Request logging
  ├─ 5. Session middleware (Convex get-session)
  ├─ 6. Route matching
  │   ├─ /api/auth/sign-out → sign-out handler
  │   ├─ /api/auth/* → Convex proxy
  │   ├─ / → app routes
  │   ├─ /docs/:org → app shell with tree only
  │   ├─ /docs/:org/:path* → app shell with selected document, or shared 404 HTML if the object is missing/deleted
  │   ├─ /files/* → doc streaming, or shared 404 HTML inside the iframe when the object is missing/deleted
  │   ├─ /api/sync/* → sync API
  │   ├─ /api/tree/* → tree API
  │   ├─ /lazy-tree.js → ASSETS binding
  │   ├─ /commentor.js → ASSETS binding
  │   ├─ * → ASSETS binding fallback
  │   └─ /health → text response
  └─ 7. Error handler
```

### DOMParser Polyfill

The AWS SDK S3 client uses browser XML APIs for parsing ListObjectsV2 responses. Workers lacks these.

**Polyfill provides:**
- `globalThis.Node` with type constants (ELEMENT_NODE=1, TEXT_NODE=3, etc.)
- `globalThis.DOMParser` class with `parseFromString()` → Document-like object
- `XmlNode` class implementing: `nodeType`, `nodeName`, `nodeValue`, `tagName`, `textContent`, `childNodes`, `firstChild`, `getElementsByTagName()`
- `documentElement` property pointing to root element (not #document node)

**Tree-shaking protection**: The polyfill is wrapped in an IIFE. Without it, esbuild evaluates `typeof DOMParser === "undefined"` at build time (where it IS defined) and removes the entire block.

### ConvexClient → HTTP Migration

`ConvexClient` from `convex/browser` uses WebSocket for real-time sync. Workers can't reuse WebSocket connections across requests. All Convex calls now use raw HTTP:

```typescript
// Query
POST https://<deployment>.convex.cloud/api/query
Body: { "path": "module:function", "args": [{ ... }] }

// Mutation
POST https://<deployment>.convex.cloud/api/mutation
Body: { "path": "module:function", "args": [{ ... }] }
```

Affected modules: `api-keys.ts`, `soft-delete.ts`, `session.ts` (middleware).

---

## Deployment and Publication API

The Worker proxies `/api/rendro/*` to Convex. Session requests are authorized by organization membership; CI requests use scoped API credentials.

### Immutable deployment protocol

| Method | Path | Required scope | Purpose |
|---|---|---|---|
| POST | `/api/rendro/deployments/start` | `docs:write` | Create/reuse staging deployment and return manifest diff |
| GET | `/api/rendro/deployments/staging` | `docs:write` | Recover an interrupted staging deployment |
| POST | `/api/rendro/deployments/:id/files/*` | `docs:write` | Upload one changed staging object |
| POST | `/api/rendro/deployments/:id/manifest` | `docs:write` | Upload the canonical manifest |
| POST | `/api/rendro/deployments/commit` | `docs:write` | Verify manifest and atomically activate deployment |
| POST | `/api/rendro/deployments/fail` | `docs:write` | Mark an unrecoverable staging deployment failed |
| GET | `/api/rendro/deployments/active` | `docs:read` | Resolve the current project pointer |
| GET | `/api/rendro/deployments` | `docs:read` | List immutable history |

The CLI computes SHA-256 for every file and the canonical manifest. Start returns files whose `(path, sha256, size)` match the active manifest. Those objects are copied server-side into the new deployment; only changed files cross the client connection. Commit rejects missing or mismatched manifests.

### Publications

| Method | Path | Required access | Purpose |
|---|---|---|---|
| GET/POST | `/api/rendro/publications` | member read / admin write, or publication scope | List or create explicit public mappings |
| POST | `/api/rendro/publications/remove` | admin or `publications:write` | Remove a publication |
| GET | `/p/:slug` | Anonymous | Public read-only shell |
| GET | `/p/:slug/tree` | Anonymous | Paginated published document list |
| GET | `/p/:slug/files/*` | Anonymous | Manifest-validated sandboxed object |

Publication slugs are globally indexed. A publication maps one project path to either the project’s active deployment or an explicit pinned deployment. Creating one is an intentional UI/CLI operation; uploading never makes content public.

### Revocable private shares

`POST /api/rendro/shares` creates a 256-bit random capability. Convex stores only its SHA-256 hash, expiry, creator, document path, and pinned deployment. `/s/:token` resolves the hash on every request, so expiry or revocation takes effect immediately. A grant exposes its exact HTML document and same-tree non-HTML assets, never the project tree or another HTML document.

---

## Tree UI

### Component Architecture

```
Server (Hono SSR)
  │
  ├─ renderOrgTreePage(user, org, tree)
  │   ├─ Topbar (logo, hide shell, copy signed URL, theme, avatar)
  │   ├─ Sidebar
  │   │   ├─ data-tree-org attribute
  │   │   └─ #tree-container
  │   │       ├─ #active-indicator
  │   │       └─ renderTree(tree) — top-level only
  │   ├─ Main area
  │   │   ├─ #main-placeholder (shown when no doc selected)
  │   │   └─ #content-frame (iframe, hidden initially)
  │   ├─ Inline scripts (theme, shell hide/show, iframe shortcut forwarding, copy feedback, avatar menu)
  │   └─ <script src="/lazy-tree.js?v=24">
  │
  ├─ renderNotFoundPage(options)
  │   ├─ Shared Broken Document Graph HTML from `src/routes/not-found.ts`
  │   ├─ `/docs/:key` checks `isDeleted` + S3 `headObject` before shell render
  │   ├─ `/files/:key` returns iframe-safe 404 HTML for stale/missing objects
  │   └─ Worker catch-all checks ASSETS first, then returns the shared 404 page
  │
Client (lazy-tree.js, ~15KB IIFE)
  │
  ├─ handleClick(event)
  │   ├─ Folder click → expand(collapse)
  │   │   ├─ Already loaded? → toggle .open class
  │   │   └─ Not loaded? → GET /api/tree/:org?prefix=...
  │   │       └─ Render children + Load more button if truncated
  │   ├─ File click → loadDoc(path, pushState)
  │   │   ├─ Optimistically select row + updateIndicator
  │   │   ├─ Add html.doc-loading and set iframe.src = /files/:org/:path
  │   │   ├─ On iframe load, retain tree feedback for the remainder of the 520ms minimum window
  │   │   └─ history.pushState to /docs/:org/:path
  │   └─ Load more click → next page
  │
  ├─ navigateToDoc(relPath)
  │   ├─ Expand ancestor folders iteratively
  │   └─ Highlight active item + indicator
  │
  ├─ postMessage listener
  │   ├─ doc-navigate → loadDoc(path, pushState)
  │   ├─ doc-loaded → syncActiveState(path)
  │   └─ shell-toggle → toggle parent shell when Ctrl/Cmd+Shift+H is pressed inside the document iframe
  │
  └─ popstate / initial URL
      ├─ /docs/:org/:path → window.RENDRO_INITIAL_DOC or path parse → loadDoc(path)
      └─ legacy ?doc=... → history.replaceState(/docs/:org/:path) → loadDoc(path)
```

### Document Loading Lifecycle

Document loading has no standalone DOM loader and never covers the iframe. The selected tree row is the only loading-feedback surface:

1. `loadDoc()` calls `syncActiveState()` before changing `iframe.src`, so the row and 4px active indicator move immediately.
2. `showDocLoader()` adds `html.doc-loading`. Despite its legacy function name, it does not show a separate loader element.
3. CSS keeps row text/icons readable, runs `docRowShimmer` left-to-right on `.tree-item.active::before`, and applies the synchronized `docPillRecoil` transform to the active pill. The active indicator remains static.
4. `frame.onload` calls `hideDocLoader(frame, loadId)`. The iframe is already visible; only the CSS loading class remains until the `520ms` minimum feedback window ends.
5. `activeDocLoadId` prevents an older iframe response or clear timer from changing a newer navigation state.
6. `frame.onerror` or the `15s` timeout calls `showDocLoadError()`, replacing `doc-loading` with `doc-loading-error` and leaving a static error tint on the active row.
7. `prefers-reduced-motion: reduce` disables shimmer and recoil animation while retaining the active-row state.
8. Neither class currently emits a live-region/status announcement; the timeout tint is color-only. This remains an accessibility gap.

The iframe stays at full opacity throughout. There is no fixed header line, main-area progress bar, document skeleton, or active-indicator pulse.

### Sticky Headers (CSS)

```css
.tree-folder.open > .tree-item {
  position: sticky;
  top: calc(var(--depth) * 30px);  /* 0px, 30px, 60px... */
  z-index: calc(10 - var(--depth)); /* 10, 9, 8... */
  background: var(--sidebar-bg);
}
.tree-folder.open > .tree-folder-content {
  overflow: visible; /* unblock sticky positioning */
}
```

Zero JavaScript. GPU-accelerated by the browser. Multiple open folders stack with increasing top offset.

---

## Inline Comments

### Architecture

```
Doc HTML (iframe)                    Convex
  │                                    │
  │ User selects text                   │
  │ Commentor captures anchor           │
  │   (text quote + element path)       │
  │ POST thread/create                  │
  │────────────────────────────────────>│
  │                                    │ Thread stored
  │                                    │<───────────────
  │ Thread rendered as inline pin       │
  │                                    │
  │ Reply to thread                     │
  │ POST reply/add                      │
  │────────────────────────────────────>│
  │                                    │ Reply stored
  │                                    │<───────────────
```

The widget fetches a short-lived Convex JWT from
`/api/auth/convex/token` before subscribing. Every thread read and mutation
requires that signed identity and checks its email-derived organization against
the thread's organization. Thread and reply author fields are derived from JWT
claims; the client cannot submit or override them. Worker-only API-key and
soft-delete functions require `CONVEX_INTERNAL_SECRET`, which must match in the
Worker and Convex environments.

### Anchor Format

```typescript
type Anchor =
  | { kind: "text-range"; quote: string; path: string[]; startOffset: number; endOffset: number }
  | { kind: "element"; path: string[] }
```

The anchor uniquely identifies text within a document, surviving minor edits.

---

## Deployment

### URL Scheme

| Purpose | URL |
|---|---|
| Organization settings | `/organizations/:organizationId` |
| Project settings/history | `/organizations/:organizationId/projects/:projectId` |
| Authenticated project docs | `/organizations/:organizationId/projects/:projectId/docs` |
| Publication management | `/organizations/:organizationId/projects/:projectId/publications` |
| Public publication | `/p/:slug` |
| Revocable private share | `/s/:token` |

Local and deployed environments use the same Better Auth session and organization checks. Development impersonation inputs are ignored.

### Production URLs

| Service | URL |
|---|---|
| Web app | `https://rendro.app` |
| Worker | Cloudflare Workers custom-domain deployment |
| Convex API | `CONVEX_URL` |
| Convex HTTP actions | `CONVEX_SITE_URL` |
| Blob storage | Cloudflare R2 S3 endpoint |

### Deploy Commands

```bash
pnpm exec convex deploy --cmd "push"
pnpm exec wrangler deploy --config wrangler.toml
```

### Environment Variables (Workers)

| Variable | Storage | Purpose |
|---|---|---|
| `NODE_ENV`, `BASE_URL` | Wrangler vars | Runtime mode and canonical origin |
| `CONVEX_SITE_URL` | Wrangler var/secret | Convex HTTP action origin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Secrets | Google OAuth |
| `AUTH_SECRET` | Secret | Better Auth signing; same value in Convex |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Secrets | R2 S3 access |
| `MINIO_BUCKET`, `MINIO_REGION`, `MINIO_FORCE_PATH_STYLE` | Vars/secrets | R2 bucket configuration |

### Environment Variables (Convex)

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client |
| `AUTH_SECRET` | Better Auth signing; same value as Worker |
| `SITE_URL` | Canonical Worker origin |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Verification, reset, invitation, and account-link security email |
| `RETENTION_SECRET` | Bearer secret accepted only by retention HTTP actions |
| `MIGRATION_SECRET` | Bearer secret accepted only by the staged migration control action |

---

## Operational Runbooks

### Interrupted push

1. Re-run the same `rendro push` command. The CLI queries the project’s staging deployment and reuses matching uploaded objects.
2. If the manifest changed, start creates a new staging deployment and marks the obsolete one failed.
3. Confirm the project page shows the new deployment as `active`; the predecessor becomes `superseded`.
4. Never change the project pointer or copy files manually. Commit is the atomic boundary.

### Revoke leaked access

- API credential: Organization settings → API keys → Revoke. Validation checks revocation on every request.
- Private share: call `POST /api/rendro/shares/revoke` with its grant ID. The token hash stops resolving immediately.
- Public publication: remove it from the project Publications page. `/p/:slug` returns 404 afterward.

### Retention

`pnpm cleanup:retention` purges failed deployments older than 24 hours and superseded deployments older than 30 days. Active deployments, pinned publications, and deployments referenced by unexpired shares are excluded. `.github/workflows/retention.yml` runs daily. Required secrets: `CONVEX_SITE_URL`, `RETENTION_SECRET`, and the R2 endpoint/access key/secret/bucket. Convex records `deployment.purged` audit events.

### Legacy migration

Legacy slug-prefixed objects are migrated by copy, never in place:

1. Set the same random `MIGRATION_SECRET` in Convex and the operator environment.
2. Create a JSON array containing `legacyOrgSlug`, Better Auth `organizationId`, an organization-scoped migration `apiKey`, and optionally `projectId`, `projectName`, and `legacyApiKey`. A supplied project must be empty; otherwise the protected migration endpoint rejects it.
3. Run `pnpm migrate:legacy -- --map targets.json` for a read-only inventory.
4. Run again with `--apply`. The tool creates/reuses an empty dedicated project, hashes legacy objects, copies them into one immutable deployment, commits it, and recreates legacy publications as pinned mappings when `legacyApiKey` is supplied.
5. Preserve the emitted `migration-rollback-*.json`. The migration does not delete old objects or old routes. Run `pnpm migrate:legacy -- --map targets.json --rollback migration-rollback-….json` to revoke all migrated publications; migrated bytes remain private for audit.
6. Compare object/file counts and sample private/public routes before retiring legacy paths. Do not derive new organization IDs from old slugs.

## Key Technical Decisions

| Decision | Reason |
|---|---|
| Better Auth organization IDs are the tenant key | Membership, teams, invitations, and roles stay in one canonical authorization model |
| Immutable deployment namespaces | Interrupted writes cannot corrupt the active site; rollback and provenance are explicit |
| Convex metadata, R2 bytes | Indexed relationships and authorization remain separate from cheap blob storage |
| SHA-256 manifests and server-side reuse | CI sends only changed files without relying on mutable object ETags |
| Explicit tracked or pinned publications | Upload remains private; public release intent and version behavior are auditable |
| Hashed, revocable credentials and share grants | Raw secrets are shown once and can be expired or revoked without changing storage |
| Server HTML and vanilla JavaScript | The operational UI stays compatible with the existing no-framework browser architecture |
| iframe document rendering | Publisher HTML remains isolated from application chrome |

## Known Limitations

1. Search is publisher-provided; Rendro only filters loaded tree pages.
2. Publisher HTML is rendered in sandboxed iframes and can still produce its own internal scroll behavior.
3. Publication slugs are global, so product naming policy must account for collisions.
4. Retention cleanup needs R2 credentials in the scheduled GitHub environment.
5. Legacy slug-based routes remain only for the staged migration window and must be removed after production verification.
6. The first Convex HTTP action after a cold start can add latency.
