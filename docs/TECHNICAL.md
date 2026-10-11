# Rendro — Technical

Complete technical reference: architecture, data flow, API, design decisions, and operational details.

> For the chronological evolution of these decisions, see [docs/HISTORY.md](HISTORY.md).
> Dated QA and performance reports live in [docs/archive/](archive/README.md). They are point-in-time evidence, not current guidance.

---

## Architecture

```text
Browser / CI
      │ session cookie or scoped API credential
      ▼
Cloudflare Workers (Hono)
      ├── Better Auth HTTP proxy ──► Convex component (users, sessions, organizations, teams)
      ├── Rendro metadata API ─────► Convex app tables (HTTP actions)
      └── immutable file delivery ─► R2 via the S3 API
```

### Component Roles

| Component | Technology | Purpose |
|---|---|---|
| **Edge application** | Hono on Cloudflare Workers | Request routing, SSR, auth proxy, authorization handoff, sandboxed file streaming |
| **Identity and tenancy** | Better Auth Convex component | Google and email/password identity, email verification, sessions, organizations, teams, invitations, roles |
| **Application metadata** | Convex | Projects, immutable deployments, publications, scoped credentials, revocable shares, comments, audit events |
| **Blob storage** | Cloudflare R2, reached through the AWS S3 client (`src/minio.ts`, `MINIO_*` variables) | Deployment manifests and immutable objects under organization-ID prefixes |
| **CLI** | Node.js, bundled to one executable | Manifest hashing, delta upload, provenance, deployment commit, publication management |
| **Browser UI** | Server HTML + vanilla JavaScript | Organization/project management, document navigation, comments |

The Worker has no R2 binding. Local development uses MinIO with the same S3 client.

---

## Authentication

Better Auth runs inside Convex HTTP actions (`convex/auth.ts`). The Worker proxies `/api/auth/*` to Convex and never stores sessions itself.

### Sign-in methods

| Method | Behavior |
|---|---|
| Google OAuth | `POST /api/auth/sign-in/social`; Google redirects to `/api/auth/callback/google` |
| Email and password | `POST /api/auth/sign-up/email` and `/api/auth/sign-in/email`. Email verification is required before sign-in; verification is sent on sign-up and sign-in. Passwords are 15–128 characters |
| Password recovery | `/forgot-password` and `/reset-password`; reset tokens expire after one hour and revoke existing sessions |
| Initial password | `POST /api/auth/set-initial-password` (custom Convex route) lets a signed-in account without a password add one from `/account/security` |

Account linking trusts Google only when the local email is verified and the emails match. Sign-up responses do not reveal whether an address is already registered. Better Auth rate limits are stored in the database; sign-in and sign-up endpoints have tighter per-route limits. Verification, reset, invitation, and existing-account notices are sent through Resend (`RESEND_API_KEY`, `AUTH_EMAIL_FROM`).

### Google OAuth flow

```
1. Browser POST /api/auth/sign-in/social (callbackURL = return path, default "/")
2. Worker proxies to the Convex HTTP action
3. Better Auth stores OAuth state (verification table + signed state cookie)
4. Worker returns the Google URL and strips Domain from Set-Cookie
5. Browser authenticates with Google
6. Google redirects to /api/auth/callback/google?code=...&state=...
7. Worker proxies the callback with the state cookie
8. Better Auth validates state, exchanges the code, creates/updates the user and session
9. Convex sets the session cookie and redirects to the callback URL
10. Worker returns the redirect with Domain stripped from Set-Cookie
11. GET / with a session redirects to /organizations
12. Organization membership and role checks in Convex determine which organization and project routes the session may access
```

### Session middleware

`src/middleware/session.ts` runs on every route registered after it. If the request carries a `better-auth` cookie, it calls Convex `GET /api/auth/get-session` and sets `c.get("user")`. There is no application-side session cache, and Better Auth's cookie cache is disabled, so expiry and revocation take effect on the next request.

Requests under `/api/auth/`, `/api/rendro/`, and `/api/sync/` skip the lookup; Convex authorizes those calls itself.

Responses that performed a session lookup receive `Cache-Control: private, no-store`. Responses that pass through the middleware also receive numeric `Server-Timing` metrics: `session;dur=…` (when a lookup ran) and `render;dur=…`. The metrics contain no identity or response data.

### Workers Proxy Details

`src/auth-proxy.ts` handles four concerns:

1. **Header allowlist**: only `accept`, `content-type`, `cookie`, `origin`, and `user-agent` are forwarded. `Host` and `cf-*` headers are excluded.
2. **Domain stripping**: Convex sets `Domain=convex.site` on cookies. The Worker strips the Domain attribute so cookies bind to the Worker origin.
3. **Redirect control**: `redirect: "manual"` leaves redirects to the browser.
4. **Sign-out**: `GET /api/auth/sign-out` calls Convex sign-out with `POST`, then expires every known auth cookie (host and parent domain) and sends `Clear-Site-Data: "cookies"`.

The generic `/api/rendro/*` proxy uses the same allowlist, so it intentionally does **not** forward `Authorization`. Routes that accept API keys (deployment and publication routes, below) are implemented in the Worker and forward `Authorization` explicitly. The dedicated migration project route also forwards its operator bearer secret to the secret-gated Convex action.

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

### API keys

| Property | Value |
|---|---|
| Format | `rnd_live_<keyId>_<secret>` (8-byte hex key ID, 32-byte hex secret). The `rnd_live_<keyId>` prefix is stored for display; the full key is shown once |
| Storage | SHA-256 hash of the full key |
| Scopes | `docs:read`, `docs:write`, `publications:read`, `publications:write` |
| Binding | One organization, optionally one project |
| Expiry | Optional; the UI offers 30 days, 90 days (default), 1 year, or never |
| Management | Owners and admins create, list, and revoke keys |

Validation checks organization, optional project binding, required scope, expiry, and revocation on every request, and records `lastUsedAt`.

| Operation | Scope |
|---|---|
| Read active deployment or history | `docs:read` |
| Start, upload, copy, commit, or fail a deployment | `docs:write` |
| List publications | `publications:read` |
| Create or remove a publication | `publications:write` (create also reads the deployment, so it needs `docs:read`) |

Session users may use the same read/write publication endpoints: any member can read; owners and admins can write.

## Data Storage

### Convex Tables

The Better Auth component owns users, sessions, accounts, verification records, organizations, members, teams, team members, invitations, JWKs, and rate-limit state.

The application schema (`convex/schema.ts`) owns:

| Table | Purpose |
|---|---|
| `projects` | Organization-scoped documentation products and active deployment pointer |
| `deployments` | Immutable manifest metadata, status, provenance, predecessor, retention state |
| `publications` | Indexed global public slug, project/path mapping, tracked or pinned release mode |
| `shareGrants` | Hashed, expiring, revocable private document capabilities pinned to a deployment |
| `apiKeyCredentials` | Hashed organization/project credentials with scopes, expiry, revocation, and last-used timestamp |
| `documentThreads`, `documentReplies` | Project document comments |
| `auditEvents` | Actor/action/resource audit trail for privileged changes |
| `threads`, `replies`, `api_keys`, `deleted_files` | Legacy slug-based tables, retained until the legacy migration is verified |

### R2 Structure

```text
<bucket>/
└── tenants/{organizationId}/
    └── projects/{projectId}/
        └── deployments/{deploymentId}/
            ├── manifest.json
            ├── tree-index.json
            └── files/
                ├── index.html
                ├── assets/app.css
                └── reference/api.html
```

`manifest.json` holds `{ version: 1, files: [{ path, sha256, size, contentType }] }`, sorted by path. `tree-index.json` holds `{ version: 1, files: [{ path, size }] }`. Both are written by the Worker when the deployment starts. The viewers currently derive their tree from `manifest.json`. Each uploaded or copied object stores its SHA-256 as object metadata.

Deployment keys are immutable. A push writes objects under a new staging deployment, then commit changes the Convex project pointer. A failed or interrupted push cannot overwrite the active version. Superseded deployments remain available to pinned publications and unexpired shares until retention permits deletion.

---

## Workers Internals

### Request Pipeline

`src/worker.ts` registers middleware and routes in this order (Hono matches the first handler that responds). Steps 5 and 8–14 come from `mountPublicRoutes()` and `mountSessionRoutes()` in `src/app-routes.ts`:

```
Request
  │
  ├─ 1. DOMParser/Node polyfill (IIFE, module load time)
  ├─ 2. Env bridging (string c.env values → process.env, without overwriting)
  ├─ 3. CORS for legacy /api/sync/*
  ├─ 4. Debug request logging
  ├─ 5. Public routes, before session middleware
  │   ├─ /p/:slug, /p/:slug/tree, /p/:slug/files/*      publications
  │   ├─ /s/:token, /s/:token/files/*                   private shares
  │   ├─ /share/:token                                  legacy HMAC share links
  │   └─ /public/:org/:slug/*                           legacy public folders
  ├─ 6. Public static assets, before session middleware
  │   └─ /management-query.js, /select.js, /management-pages.js, /commentor-parent.js
  ├─ 7. Session middleware
  ├─ 8. Auth
  │   ├─ GET /api/auth/sign-out → POST to Convex, cookie cleanup
  │   └─ /api/auth/* → Convex proxy
  ├─ 9. Worker-implemented API routes (forward Authorization)
  │   ├─ /api/rendro/deployments/check|start|fail, /:id/files/*, /:id/copy, /:id/commit
  │   ├─ /api/rendro/publications (GET, POST), /api/rendro/publications/remove
  │   └─ POST /api/rendro/migration/project
  ├─ 10. /api/rendro/* → generic Convex proxy (no Authorization)
  ├─ 11. Auth pages: /sign-in, /sign-up, /verify-email, /forgot-password, /reset-password, /account/security
  ├─ 12. Management pages
  │   ├─ /organizations, /organizations/:o, /organizations/:o/onboarding
  │   ├─ /organizations/:o/people|teams|settings|projects|api-keys
  │   ├─ /organizations/:o/projects/:p, …/deployments, …/publications, …/shares
  │   ├─ /organizations/:o/projects/:p/docs, …/docs/tree, …/docs/files/*
  │   └─ /accept-invitation/:invitationId
  ├─ 13. App and legacy routes
  │   ├─ /  → landing page, or redirect to /organizations when signed in
  │   ├─ legacy /docs/:org…, /files/*, /api/tree/:org, /api/sync/*, /api/orgs, /api/publications, /api/share/create
  ├─ 14. /health → "ok"
  ├─ 15. /lazy-tree.js, /commentor.js → ASSETS binding
  ├─ 16. GET * → ASSETS binding, else shared 404 HTML
  └─ 17. Error handler → generic JSON 500
```

`src/index.ts` is the Node.js entry for local development (`pnpm dev`, `pnpm start`). It mounts the same route groups from `src/app-routes.ts` and serves browser assets with `serveStatic`.

Public routes and static assets run before the session middleware so they never trigger a session lookup. Their safety comes from record and capability validation, not route position.

### DOMParser Polyfill

The AWS SDK S3 client uses browser XML APIs for parsing ListObjectsV2 responses. Workers lacks these.

**Polyfill provides:**
- `globalThis.Node` with type constants (ELEMENT_NODE=1, TEXT_NODE=3, etc.)
- `globalThis.DOMParser` class with `parseFromString()` → Document-like object
- A minimal node class `X` implementing: `nodeType`, `nodeName`, `nodeValue`, `tagName`, `textContent`, `childNodes`, `firstChild`, `getElementsByTagName()`
- `documentElement` property pointing to root element (not #document node)

**Tree-shaking protection**: The polyfill is wrapped in an IIFE. Without it, esbuild evaluates `typeof DOMParser === "undefined"` at build time (where it IS defined) and removes the entire block.

### Convex access from the Worker

The Worker never opens a WebSocket to Convex. It calls Convex HTTP actions at `CONVEX_SITE_URL` for auth and `/api/rendro/*`. The legacy `api-keys.ts` and `soft-delete.ts` modules call the Convex query/mutation HTTP API at `CONVEX_URL` with `CONVEX_INTERNAL_SECRET`, through `src/convex-internal.ts`:

```typescript
POST ${CONVEX_URL}/api/query     Body: { "path": "module:function", "args": [{ ... }] }
POST ${CONVEX_URL}/api/mutation  Body: { "path": "module:function", "args": [{ ... }] }
```

If `CONVEX_SITE_URL` is unset, `src/config.ts` derives it from `CONVEX_URL` (`.cloud` → `.site`, local port 3210 → 3211).

---

## Deployment and Publication API

### Immutable deployment protocol

The CLI drives these Worker routes (`src/routes/deployments.ts`). Identity (`organizationId`, `projectId`) travels in the JSON body for start/fail and in the query string for the other calls.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/api/rendro/deployments/check` | `docs:read` | Return the active deployment and its manifest |
| POST | `/api/rendro/deployments/start` | `docs:write` | Validate the manifest and checksum, create a new staging deployment, write `manifest.json` and `tree-index.json` |
| POST | `/api/rendro/deployments/:id/copy` | `docs:write` | Copy unchanged files from the previous active deployment |
| PUT | `/api/rendro/deployments/:id/files/*` | `docs:write` | Upload one changed file |
| POST | `/api/rendro/deployments/:id/commit` | `docs:write` | Verify the object listing and activate the deployment |
| POST | `/api/rendro/deployments/fail` | `docs:write` | Mark a staging deployment failed |

Sequence used by `rendro push` (`cli/src/index.ts`):

1. Walk the source folder, compute SHA-256 and size per file, build a sorted manifest, and hash its JSON.
2. `check` returns the active manifest. Files with matching `(path, sha256, size)` are unchanged; the rest are changed.
3. `start` re-parses the manifest, rejects unsorted/duplicate/unsafe paths and checksum mismatches, then asks Convex to insert a `staging` deployment whose `previousDeploymentId` is the current active deployment. Every start creates a new deployment; staging deployments are never reused. If writing the manifest or tree index fails, the Worker marks the deployment failed.
4. `copy` accepts at most 16 paths per request (`MAX_REUSED_FILES_PER_REQUEST` in `shared/deployment-limits.ts`, chosen to stay under the Workers subrequest limit). For each path it requires a manifest entry, then `HEAD`s the previous deployment's object and requires matching size and stored SHA-256 before copying.
5. `PUT files/*` accepts only paths in the manifest. The body must match the manifest size (oversized bodies are cancelled) and SHA-256. The CLI uploads changed files in batches of `--concurrency` (default 8).
6. `commit` lists the deployment's `files/` prefix and requires it to equal the manifest's paths exactly (409 otherwise). Convex then requires the deployment to still be `staging` and the project's active deployment to still equal `previousDeploymentId` ("Active deployment changed; rebase and retry"). It marks the previous deployment `superseded`, the new one `active`, and moves the project pointer in one mutation.
7. If copy, upload, or commit throws, the CLI calls `fail` with the error message and exits non-zero.

Deployment statuses: `staging` → `active` → `superseded`, or `staging` → `failed`.

Convex also serves `GET /api/rendro/deployments/active` and `GET /api/rendro/deployments` (latest 100) for sessions and `docs:read` keys, and `GET /api/rendro/deployments/staging` for the Worker.

### Publications

| Method | Path | Required access | Purpose |
|---|---|---|---|
| GET | `/api/rendro/publications` | Member, or `publications:read` | List publications |
| POST | `/api/rendro/publications` | Owner/admin, or `publications:write` + `docs:read` | Create a publication |
| POST | `/api/rendro/publications/remove` | Owner/admin, or `publications:write` | Remove a publication |
| GET | `/p/:slug` | Anonymous | Public read-only shell |
| GET | `/p/:slug/tree` | Anonymous | Paginated published document list |
| GET | `/p/:slug/files/*` | Anonymous | Manifest-validated sandboxed object |

Publication slugs are globally indexed. A publication maps one project path (`pathPrefix`, `entryFile`) to either the project's active deployment (`track_active`) or an explicit `pinned` deployment. Before creating one, the Worker resolves the target deployment, rejects `staging` or `failed` deployments, and requires the entry file to be an HTML file in that deployment's manifest. Uploading never makes content public. Public responses use `Cache-Control: public, max-age=0, must-revalidate`.

### Revocable private shares

`POST /api/rendro/shares` (any organization member) creates a 256-bit random token. `expiresInSeconds` must be between 60 seconds and 30 days; the document toolbar requests 7 days. Convex stores only the token's SHA-256 hash, expiry, creator, document path, and pinned deployment. `/s/:token` resolves the hash on every request, so expiry or revocation takes effect immediately. A grant exposes its exact HTML document and same-tree non-HTML assets, never the project tree or another HTML document. Responses use `Cache-Control: private, no-store`. Owners and admins revoke grants with `POST /api/rendro/shares/revoke`.

Legacy `/share/:token` links are separate: an HMAC-SHA256 of the object key and a 7-day expiry, signed with the Worker's `AUTH_SECRET` (`src/share-links.ts`).

### Endpoint inventory

Convex HTTP routes (`convex/http.ts`). The Worker serves the rows marked *Worker* itself and forwards the rest through the generic proxy.

| Method | Path | Access |
|---|---|---|
| GET, POST | `/api/auth/*` | Better Auth |
| POST | `/api/auth/set-initial-password` | Session |
| GET, POST | `/api/rendro/projects` | List: member. Create: owner/admin |
| GET | `/api/rendro/projects/get` | Member |
| GET | `/api/rendro/management/access` | Member; returns organization identity and the caller's membership only |
| GET | `/api/rendro/management/members` | Member; cursor-paginated (100) |
| GET | `/api/rendro/management/team-members` | Owner/admin; cursor-paginated (50) |
| GET | `/api/rendro/management/recent-deployment` | Member |
| GET, POST | `/api/rendro/credentials` | Owner/admin |
| POST | `/api/rendro/credentials/revoke` | Owner/admin |
| GET | `/api/rendro/credentials/validate` | API key |
| POST | `/api/rendro/deployments/start` | `docs:write` (*Worker* front) |
| GET | `/api/rendro/deployments/active` | Member or `docs:read` |
| GET | `/api/rendro/deployments/staging` | `docs:write` |
| POST | `/api/rendro/deployments/commit` | `docs:write` (reached through *Worker* `/:id/commit`) |
| POST | `/api/rendro/deployments/fail` | `docs:write` (*Worker* front) |
| GET | `/api/rendro/deployments` | Member or `docs:read` |
| GET, POST | `/api/rendro/publications` | See Publications (*Worker* front) |
| POST | `/api/rendro/publications/remove` | See Publications (*Worker* front) |
| GET | `/api/rendro/publications/public` | Anonymous; used by `/p/*` |
| GET, POST | `/api/rendro/shares` | Member |
| POST | `/api/rendro/shares/revoke` | Owner/admin |
| GET | `/api/rendro/shares/public` | Anonymous; used by `/s/*` |
| GET | `/api/rendro/retention/candidates` | `RETENTION_SECRET` bearer |
| POST | `/api/rendro/retention/purged` | `RETENTION_SECRET` bearer |
| POST | `/api/rendro/migration/project` | `MIGRATION_SECRET` bearer (*Worker* front) |

Organization, member, team, and invitation operations use Better Auth's organization plugin endpoints under `/api/auth/organization/*`.

### Management data access

Management screens gate retained data on `GET /api/rendro/management/access?organizationId=…`. It returns the organization's `id`, `name`, `slug`, the caller's `userId`, and their member record (`id`, `userId`, `role`), with `Cache-Control: private, no-store`. It does not load the roster. The browser starts this check alongside each scoped data read and withholds the data until access is confirmed; completed permission results are not cached. Every backend operation still authorizes independently.

---

## Document Viewer

### Routes

| Viewer | Shell | Frame | Tree |
|---|---|---|---|
| Project (signed in) | `/organizations/:o/projects/:p/docs?doc=<path>` | `…/docs/files/<path>` | `…/docs/tree` |
| Publication (anonymous) | `/p/:slug?doc=<path>` | `/p/:slug/files/<path>` | `/p/:slug/tree` |
| Private share (anonymous) | `/s/:token` | `/s/:token/files/<path>` | none |
| Legacy (email-domain org) | `/docs/:org/:path` | `/files/:org/:path` | `/api/tree/:org` |

The project and publication viewers share `renderScopedDocumentShell()` in `src/routes/app.ts`. The project shell resolves the active deployment through Convex with the session cookie, reads `manifest.json`, and selects `?doc=` or `index.html` (falling back to the first HTML file). Unknown paths return the shared 404 page.

`…/docs/tree` returns HTML document paths from the active manifest in pages of 200 (`{ documents, cursor }`). `…/docs/files/*` serves only manifest entries with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and either `sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'` (HTML) or `default-src 'none'` (other types) as the Content-Security-Policy. HTML responses get a small injected script for navigation messages, the shell shortcut, and the comment configuration; stored publisher bytes are never modified.

### Component Architecture

```
Server (Hono SSR)
  │
  ├─ renderScopedDocumentShell(options)
  │   ├─ Topbar (back link, title, share, theme, account menu; mobile "More document actions" menu)
  │   ├─ Sidebar (#doc-sidebar, resizable, mobile drawer)
  │   │   ├─ data-tree-org / data-document-base attributes
  │   │   └─ #tree-container with #active-indicator
  │   ├─ Main area
  │   │   ├─ #main-placeholder
  │   │   └─ #content-frame (sandboxed iframe)
  │   ├─ Inline scripts (theme, shell hide/show, shortcut forwarding, share feedback, account menu)
  │   ├─ <script src="/lazy-tree.js?v=…">
  │   └─ commentor-parent.js (project viewer)
  │
  ├─ renderNotFoundPage(options)  (src/routes/not-found.ts)
  │   └─ Shared 404 HTML for missing routes, documents, and iframe objects
  │
Client (lazy-tree.js, ~25KB IIFE built from src/lazy-tree/)
  │
  ├─ Scoped viewers: fetch every page of …/tree once, then build folder levels client-side
  ├─ Legacy viewer: GET /api/tree/:org?prefix=… per folder, with "Load more" pagination
  ├─ File click → loadDoc(path, pushState)
  │   ├─ Optimistically select row + updateIndicator
  │   ├─ Add html.doc-loading and set iframe.src to the frame URL
  │   ├─ On iframe load, keep tree feedback for the rest of the 520ms minimum window
  │   └─ history.pushState (?doc=<path> for scoped viewers, /docs/:org/:path for legacy)
  ├─ postMessage listener (current content iframe only)
  │   ├─ doc-navigate → loadDoc(path, pushState)
  │   ├─ doc-loaded → syncActiveState(path)
  │   └─ shell-toggle → Ctrl/Cmd+Shift+H inside the iframe toggles the shell
  └─ popstate / initial URL → loadDoc(path)
```

The script URLs carry `?v=` cache-busting versions that change with each rebuild; read the current value in `src/routes/app.ts` rather than copying it.

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

Zero JavaScript. Multiple open folders stack with increasing top offset.

---

## Inline Comments

Project documentation uses an opaque, publisher-controlled sandboxed iframe. The trusted parent shell (`public/commentor-parent.js`, built from `src/commentor/parent-entry.ts`) fetches a short-lived Convex JWT from `/api/auth/convex/token`, owns the authenticated Convex client, and holds the real-time subscription.

```text
publisher iframe -> scoped messages -> trusted parent shell -> authenticated Convex
publisher iframe <- scoped results  <- trusted parent shell <- reactive pages
```

The iframe receives only document-scoped comment data and operation results, never a JWT or session credential. The parent derives organization, project, and document from its trusted configuration and frame URL, allowlists comment operations, and confines thread mutations to that document. Server-side membership and thread ownership checks in `convex/documentThreads.ts` and `convex/documentReplies.ts` remain authoritative. Author fields come from the authenticated identity.

### Comment permissions

Project comment queries and mutations require current organization membership and the exact organization/project/document scope. Authors can delete their own threads and replies; organization owners and admins can delete anyone's comments. Other members cannot. Archive/unarchive uses the same author-or-admin rule because it hides a thread. The server returns a per-comment `canDelete` flag in thread pages, reply previews, and reply pages; the widget hides Delete (and thread Archive/Unarchive) unless permitted. These flags are presentation hints: mutations recheck the current identity and role.

Resolve/reopen intentionally remains available to any organization member with write access for collaborative triage, as do creating threads and adding replies. Author IDs always come from the authenticated identity. Reply removal verifies that the reply belongs to the scoped thread and deletes only that reply; deleting a thread retains the existing tombstone and batched reply cleanup. Shared/public read-only viewers have no comment mutation access. These organization-role rules apply to project comments; the legacy slug-based API described below retains its separate authorization model.

Thread and reply history uses bounded reactive Convex pages. Explicit load-older controls preserve access to the full history; loaded pages remain subscribed rather than becoming a stale snapshot. Read limits account for reply previews and bounded author projections as well as raw thread rows. Deletion hides the thread immediately using a tombstone, then removes replies in scheduled batches of 100 before deleting the thread record. Organization membership is checked by indexed organization/user lookup, not by searching the first page of an organization roster.

The legacy same-origin viewer (`/docs/:org`) loads `commentor.js` directly in the document and uses the legacy `threads`/`replies` tables, which authorize by email-derived organization slug. Worker-only legacy API-key and soft-delete functions require `CONVEX_INTERNAL_SECRET`, which must match in the Worker and Convex environments.

### Anchor Format

```typescript
type Anchor =
  | { kind: "text-range"; quote: string; path: string[]; startOffset: number; endOffset: number }
  | { kind: "element"; path: string[] }
```

The anchor identifies text within a document and tolerates minor edits.

---

## Deployment

### URL Scheme

| Purpose | URL |
|---|---|
| Organization chooser | `/organizations` |
| Organization overview | `/organizations/:organizationId` |
| Onboarding | `/organizations/:organizationId/onboarding` |
| People, teams, settings, API keys | `/organizations/:organizationId/people`, `/teams`, `/settings`, `/api-keys` |
| Projects | `/organizations/:organizationId/projects` |
| Project overview and deployments | `/organizations/:organizationId/projects/:projectId`, `…/deployments` |
| Authenticated project docs | `/organizations/:organizationId/projects/:projectId/docs` |
| Publication management | `/organizations/:organizationId/projects/:projectId/publications` |
| Private share management | `/organizations/:organizationId/projects/:projectId/shares` |
| Invitation acceptance | `/accept-invitation/:invitationId` |
| Public publication | `/p/:slug` |
| Revocable private share | `/s/:token` |

Local and deployed environments use the same Better Auth session and organization checks.

### Production URLs

| Service | URL |
|---|---|
| Web app | `https://rendro.app` (`https://dev.rendro.app` for the development environment) |
| Worker | Cloudflare Workers custom-domain deployment |
| Convex API | `CONVEX_URL` |
| Convex HTTP actions | `CONVEX_SITE_URL` |
| Blob storage | Cloudflare R2 S3 endpoint |

### Deploy Commands

```bash
pnpm exec convex deploy
pnpm run deploy
```

`pnpm run deploy` rebuilds the browser assets before uploading the Worker. Use
the explicit `run`: plain `pnpm deploy` invokes pnpm's unrelated workspace
deployment command. For development use `pnpm run deploy --env development`. Do not
replace it with a bare Wrangler deployment from a fresh checkout: ignored
comment/navigation bundles are generated release artifacts, not source files.

`public/management-query.js`, `public/select.js`, and `public/management-pages.js` are tracked; `pnpm verify` rebuilds them and fails if they drift from source. `public/commentor.js`, `public/commentor-parent.js`, `public/lazy-tree.js`, and `bin/rendro.mjs` are ignored and built in the release path. When management controllers or templates change, rebuild assets and bump `MANAGEMENT_SHELL_VERSION` in `src/routes/management-navigation.ts`; a shell whose version does not match the loaded bundle falls back to full navigation.

### Environment Variables (Workers)

`src/config.ts` validates the Worker environment at startup. The table lists every named string setting read by Worker code; `ASSETS` is the separate static-asset fetch binding in `src/worker.ts`. Google OAuth credentials are read only by Convex, and `BASE_URL` is unused. The local Node entry reads `PORT` separately.

Both production (top-level) and `development` declare the same required secrets: `CONVEX_INTERNAL_SECRET`, `AUTH_SECRET`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, and `MINIO_SECRET_KEY`. Wrangler checks these at deploy time, and `src/config.ts` validates them at startup. Production commands use the top-level configuration without an `--env` flag; development commands use `--env development`.

| Variable | Storage | Purpose |
|---|---|---|
| `NODE_ENV` | Wrangler var | Runtime mode; `production` selects JSON logs at `info` level |
| `CONVEX_URL` | Var/secret (optional at startup) | Convex deployment URL for legacy calls and browser comments; defaults to empty, disabling those features. Set for the full app |
| `CONVEX_SITE_URL` | Var/secret (optional) | Convex HTTP action origin for auth and project routes; derived from `CONVEX_URL` when unset. Startup and `/health` work without either URL; backend routes do not |
| `CONVEX_INTERNAL_SECRET` | Secret (required by `wrangler.toml`, ≥32 chars) | Legacy Worker-only Convex functions; same value in Convex |
| `AUTH_SECRET` | Secret (required, ≥16 chars) | Signs legacy `/share/:token` HMAC links. Better Auth signing happens in Convex |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Secrets (required, nonempty) | R2 S3 access |
| `MINIO_BUCKET`, `MINIO_REGION`, `MINIO_FORCE_PATH_STYLE` | Vars/secrets | R2 bucket configuration (defaults `docs`, `us-east-1`, `true`) |
| `LOG_LEVEL` | Var (optional) | Pino log level; defaults to `debug` outside production, `info` in production |
| `PORT` | Local only; not read by Worker | Validated in `src/index.ts`; Node.js server port (integer 1–65535, default 3000) |

### Environment Variables (Convex)

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client (required at runtime) |
| `AUTH_SECRET` | Better Auth signing (required at runtime) |
| `SITE_URL` | Canonical Worker origin; Better Auth base URL and trusted origin (required at runtime) |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Verification, reset, invitation, and account-link security email |
| `CONVEX_INTERNAL_SECRET` | Authorizes Worker-only legacy functions (`convex/security.ts`); same value as the Worker |
| `RETENTION_SECRET` | Bearer secret accepted only by retention HTTP actions |
| `MIGRATION_SECRET` | Bearer secret accepted only by the staged migration control action |

### CI workflows

| Workflow | Trigger | Runs |
|---|---|---|
| `.github/workflows/quality.yml` | Pull requests, pushes to `main`/`development`, manual | `pnpm verify` and `pnpm audit --audit-level=high`, read-only permissions, no deployment credentials |
| `.github/workflows/release.yml` | `v*` tags | Builds `bin/rendro.mjs` and attaches it to a GitHub release |
| `.github/workflows/retention.yml` | Daily cron, manual | `pnpm cleanup:retention` |

No workflow deploys the Worker or Convex, or publishes to npm.

---

## Operational Runbooks

### Interrupted push

1. On a copy, upload, or commit error, the CLI calls `/api/rendro/deployments/fail` itself, so the new deployment is marked `failed` and the active deployment is unchanged.
2. Re-run the same `rendro push` command. It starts a new staging deployment; unchanged files are copied from the active deployment again.
3. If commit returns "Active deployment changed; rebase and retry", another push activated first. Re-run the push.
4. A process killed before it can call `/fail` leaves a deployment in `staging`. It never becomes active, and retention does not purge staging deployments.
5. Confirm the project page shows the new deployment as `active`; the predecessor becomes `superseded`.
6. Never change the project pointer or copy files manually. Commit is the atomic boundary.

### Revoke leaked access

- API credential: the organization's API keys page → Revoke. Validation checks revocation on every request.
- Private share: revoke it from the project's Private shares page, or call `POST /api/rendro/shares/revoke` with its grant ID. The token hash stops resolving immediately.
- Public publication: remove it from the project Publications page or with `rendro publication remove`. `/p/:slug` returns 404 afterward.

### Retention

`pnpm cleanup:retention` purges failed deployments older than 24 hours and superseded deployments older than 30 days, up to 50 per run. Active and staging deployments, deployments pinned by a publication, and deployments referenced by unexpired, unrevoked shares are excluded. `.github/workflows/retention.yml` runs daily. Required secrets: `CONVEX_SITE_URL`, `RETENTION_SECRET`, and `R2_ENDPOINT`/`R2_ACCESS_KEY`/`R2_SECRET_KEY`/`R2_BUCKET` (mapped to `MINIO_*`). Convex records `deployment.purged` audit events.

### Legacy migration

Legacy migration remains supported: slug-based publications, comments, `/share`, `/public`, and `/docs/:org` remain available, and production migration verification has not been recorded. Keep the migration tool until that verification is complete. It copies slug-prefixed object bytes into immutable deployments using the same Worker start/upload/commit protocol as `rendro push`.

1. Set the same random `MIGRATION_SECRET` in Convex and the operator environment. Set `RENDRO_ENDPOINT` to the target Worker origin (default `http://localhost:3000`) and the `MINIO_*` variables to the source bucket. Set `CONVEX_URL` and `CONVEX_INTERNAL_SECRET` to the authoritative legacy Convex database used by that Worker and bucket; apply refuses to continue if deletion state cannot be read.
2. Create a JSON array containing `legacyOrgSlug`, Better Auth `organizationId`, an organization-scoped migration `apiKey`, and optionally `projectId`, `projectName`, and `legacyApiKey`. The current key needs `docs:write`; publication migration additionally needs `docs:read`, `publications:read`, and `publications:write`. The legacy key reads `/api/publications`. The target project must be empty or contain an identical completed migration from this legacy slug.
3. Run `pnpm migrate:legacy -- --map targets.json` for a read-only inventory.
4. Run again with `--apply`. For a non-local Worker, also supply `--confirm-endpoint <Worker origin>` (for example, `--confirm-endpoint https://rendro.example`). Apply and rollback print the sanitized Worker origin, source storage origin/bucket, source Convex origin, and organization/project mappings before any remote writes; the confirmation must match the displayed Worker origin. The tool queries `deletedFiles:filterFn` (the `deleted_files` table, indexed by full object key), excludes soft-deleted objects, then hashes the remaining objects and creates/reuses a dedicated project. It sends the sorted manifest to `/api/rendro/deployments/start`, reads `deployment.deploymentId`, uploads bytes through `PUT /api/rendro/deployments/:id/files/*`, then commits through `POST /api/rendro/deployments/:id/commit`. The Worker writes the manifest/tree index and validates uploaded hashes and sizes. When `legacyApiKey` is supplied, the tool reads the current legacy publication records and recreates them as pinned mappings. Removed publication records are not recreated. Files inside published folders that legacy public routes cannot serve (non-HTML or ambiguous paths) are excluded from the deployment, since v2 can serve any manifest entry. A deleted/missing entry document stops migration before destination writes. Deletion and publication state are checked again before publishing; changes stop publication.
5. Preserve the emitted `migration-rollback-*.json`, which is checkpointed throughout apply, including partial failures. Run `pnpm migrate:legacy -- --map targets.json --apply --rollback migration-rollback-….json` (also supplying `--confirm-endpoint <Worker origin>` for non-local targets) to revoke publications recorded by that run (including identical mappings reused on a retry). Migrated projects and bytes remain available privately for audit. Rollback does not restore or delete deployments.
6. Compare object/file counts and sample private/public routes before retiring legacy paths. Do not derive new organization IDs from old slugs.

Example `targets.json` (keep credential-bearing files out of version control):

```json
[
  {
    "legacyOrgSlug": "acme",
    "organizationId": "<Better Auth organization ID>",
    "apiKey": "<current scoped API key>",
    "legacyApiKey": "<legacy API key>"
  }
]
```

```bash
pnpm migrate:legacy -- --map targets.json          # default: inventory only
pnpm migrate:legacy -- --map targets.json --apply  # local writes
# Non-local apply or rollback additionally requires --confirm-endpoint <Worker origin>
```

The script loads `.env` when present. Dry run lists source object counts and target mappings without hashing/downloading objects, calling HTTP endpoints, or writing files; it does not validate destination credentials or publication conflicts. Repeating apply with the same source reuses the completed deployment and identical pinned publications. Changed source content, ordinary existing deployments, and conflicting publication mappings are rejected rather than overwritten. An upload or commit failure triggers a best-effort failure callback; retrying after a committed deployment resumes publication work. A killed process can leave an unused staging deployment, as with the CLI. Freeze legacy content, deletion/restore, and publication writes throughout apply and retries so the visibility snapshot and source bytes remain consistent. This is a snapshot migration, not ongoing synchronization of later legacy revocations; coordinate cutover before resuming writes.

Legacy objects, publication records, comments, and routes are preserved. This tool migrates object bytes and optional publication mappings; it excludes soft-deleted objects rather than translating tombstones, and does not translate legacy comments, API keys, or HMAC share links. Documents outside live publication prefixes remain private. No share grants are created, so expired/invalid legacy HMAC links and revoked v2 grants are never converted into fresh access. Review those separately before retiring v1 routes. Publication slugs are global in v2, so duplicate legacy slugs across organizations require an explicit naming decision.

### Development QA fixtures

Two scripts run guarded Convex fixture actions against the development Convex deployment (`deafening-beagle-38`, serving `https://dev.rendro.app`). Never point them at production. Both refuse to run unless the Convex `SITE_URL` is `https://dev.rendro.app`, and both print only sanitized counts, never sessions or credentials.

| Command | What it does |
|---|---|
| `node scripts/run-permission-qa.mjs` | Creates synthetic owner/admin/member/outsider users and isolated organizations, runs the deployed HTTP permission matrix (roles, cross-tenant IDs, teams, invitations, expired/revoked sessions), and cleans up. Exits non-zero unless every check passes and zero fixtures remain |
| `node scripts/run-workspace-qa.mjs seed <organizationId> <runId>` | Adds 120 synthetic members, 12 teams, and 120 projects to an existing organization whose slug is `qa-regression-<runId>` (`runId` is 16 hex characters) |
| `node scripts/run-workspace-qa.mjs cleanup <organizationId> <runId>` | Removes those fixtures and the organization. Refuses if the organization has deployments, publications, shares, or API keys |

Fixture runs test deployed HTTP authorization. They do not replace signed-in multi-user browser testing or email delivery checks.

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

1. There is no search. Rendro does not index document content.
2. Publisher HTML is rendered in sandboxed iframes and can still produce its own internal scroll behavior.
3. Publication slugs are global, so product naming policy must account for collisions.
4. Retention cleanup needs R2 credentials in the scheduled GitHub environment, and does not remove abandoned `staging` deployments.
5. Legacy slug-based routes remain only for the staged migration window and must be removed after production verification.
6. The first Convex HTTP action after a cold start can add latency.
