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

`src/middleware/session.ts` runs on every route registered after it. If the request carries a session-token cookie, it calls Convex `GET /api/auth/get-session` and sets `c.get("user")`. The Worker keeps successful identity lookups in a per-isolate LRU (`src/session-cache.ts`), bounded to 1,024 entries including in-flight lookups. Keys are SHA-256 hashes of the session cookie **value**, never raw tokens. Cookie names must also match; ambiguous multiple-token headers bypass caching. Entries contain only allowlisted user fields and normalized session expiry, never the session payload/token. Concurrent misses for the same cookie share the first lookup only; failures are removed before backoff and retries run independently without entering the cache. Missing, invalid, expired, malformed, failed (including 429/5xx/timeouts), or negative results are not retained. Better Auth's cookie cache remains disabled.

The TTL is **at most 15 seconds**, capped by session expiry and measured from the start of the lookup; hits never extend it. Numeric/ISO expiry is normalized and checked before caching. **Cached identity may be ≤15 seconds old**, including revocations handled by another isolate or directly by Convex. Caching is restricted to scoped organization/project pages and invitations, whose downstream authorization checks read live session and membership state. All other routes use fresh identity: this includes landing, sign-in, sign-up (Get started), account pages, and legacy document/publication/storage routes. Redirects away from authentication pages never use a cached or coalesced identity. There is no stale-on-error fallback after that deadline. Sign-out evicts the cookie in the handling isolate before and after forwarding, including failed forwarding. Other Worker auth operations that can revoke sessions (single/all/other-session revocation, password changes/resets, account deletion) evict the caller before and after forwarding and clear the isolate cache on successful mutation, because they may target sessions other than the caller's. Rejected/anonymous calls do not flush other users' entries. Eviction also prevents earlier in-flight reads from repopulating the cache. Authoritative session and membership denials also evict the presented cookie before being translated into redirects or opaque 404s; direct Better Auth missing-session responses evict as well. This is not a distributed invalidation guarantee: other isolates expire naturally within the TTL, but authentication redirects still independently revalidate there. Document/ticket and management authorization still freshly reads persisted session/membership/project access in Convex, so those checks can deny a revoked session immediately even during the identity-cache interval.

Requests under `/api/auth/`, `/api/rendro/`, and `/api/sync/` skip the lookup; Convex authorizes those calls itself. Ticketed viewer assets (`…/docs/view/:ticket/files/*`) also skip this redundant Worker lookup, even if cookies accompany the request: their ticket is decrypted and its session/membership/project access is freshly revalidated by Convex on every request. Only session-token cookies are forwarded for Worker session and viewer authorization reads; unused `session_data` cookies (including secure/chunked variants) cannot poison these reads.

HTTP `/get-session` reads use atomic fixed 60-second windows in the Better Auth component's existing rate-limit table. The primary limit is 600 reads per window, keyed by `session-read:` plus SHA-256 of the decoded token, **only after verifying the exact configured session-token cookie's HMAC and finding its active persisted session**. Unknown, expired, unsigned, or non-session values (including renamed signed OAuth-state cookies) share a 120-read verified-IP fallback. Raw tokens and client-supplied identifiers are never stored as rate-limit keys; valid sessions retain their bucket across IP changes and alternate cookie encodings. A separate 6,000-read verified-IP backstop runs before session resolution, providing capacity for ten sessions at the full 600-read allowance (many more at cached browsing rates). Direct unverified callers share `no-trusted-ip`. Each bucket's start time stays fixed during the window; accepted and rejected traffic cannot delay replenishment, and `Retry-After` reports time until reset. Better Auth's inactivity-based limiter is disabled for this endpoint and the selected organization GETs described below; credential/reset/verification limits and exact-path verifier exemptions are unchanged.

Measured with the actual Worker viewer routes and Better Auth handler (`tests/private-viewer-assets.test.ts`), a cold shell → tree → canonical content → renewal chain previously issued `[1, 1, 1, 1]` HTTP session reads; it now issues `[1, 0, 0, 0]`, and a warm chain issues zero. Ordinary navigation without renewal is 3 → 1 cold / 0 warm. The four downstream authorization reads remain fresh: total persisted resolutions for the four-route chain drop from 8 to 5 cold / 4 warm, excluding additional ticket assets (one fresh authorization each). The existing #43 request-local adapter wrapper already removes the duplicate limiter/endpoint resolution; its one-resolution-per-HTTP-read regression remains in place. Coalescing removes simultaneous cold-miss fan-out as well as sequential repeated reads.

The 600/minute allowance leaves 3× headroom even for **uncached** browsing at the round-4 1.2-second cadence: 50 navigations × (3 session reads + a pessimistic renewal on every navigation) = 200 reads/minute per session. This accommodates cache churn/multiple isolates and direct browser auth reads without weakening the 120/minute unverified-IP limit or credential endpoint limits. The local simulated regression (`tests/session-cache-browsing.test.ts`) uses real Convex HTTP actions, the production Better Auth adapter and fixed-window mutations backed by `convex-test`, two distinct owner/member sessions on one IP, and eight document paths. In ten simulated minutes, 182 navigations produce 62 HTTP session reads versus 728 uncached; the stricter 1,000-navigation run (1.2-second cadence for both users, renewal every navigation) produces 78 versus 4,000. All 728 / 4,000 fresh downstream authorizations succeed, with zero 503/429. These are deterministic local simulations with storage substitutes, not deployed Convex contention/load benchmarks.

The limiter resolves the signed token once, normalizes the Convex adapter's numeric `expiresAt` (also accepting Date/ISO values, failing closed on invalid values), and replaces only the current endpoint context's adapter reference with a wrapper that returns that result, including null, to Better Auth's unconditional `findSession` call. The shared adapter remains untouched; later requests and other tokens resolve afresh. Better Auth still owns expiry deletion and refresh writes.

A component cron runs every five minutes, paging 100 rows at a time through the `lastRequest` index at a fixed expired-window cutoff. It deletes only the three `session-read` and three `organization-read` namespaces and schedules continuation pages, preserving all built-in credential/reset/verification buckets, including stale ones. The scan also cleans existing custom rows without a data migration; schema regeneration targets `schema.generated.ts`, keeping the custom index in `schema.ts`.

Session lookup infrastructure failures return retryable 503 responses, with one bounded retry of the lookup GET only. Viewer downstream deployment/session-authorization reads likewise distinguish authoritative denial/absence (404) from 429, 5xx, network errors, a five-second timeout including body reads, and malformed responses (503 with `Retry-After`, styled retry HTML or JSON). Failures never replay protected writes or discard the session cookie.

Responses that performed a session lookup receive `Cache-Control: private, no-store`. Responses that pass through the middleware also receive numeric `Server-Timing` metrics: `session;dur=…` (when a lookup ran) and `render;dur=…`. The metrics contain no identity or response data.

### Organization lookup limits and request counts (#71)

Round 5 recorded one `get-full-organization` 429, duplicated under the `member` and `rep2-member` instrumentation labels. This endpoint previously used Better Auth 1.6.23's database limiter: `window: 60`, `max: 100`, keyed by `verified-client-IP|/organization/get-full-organization`, without a custom rule. Its database implementation updates `lastRequest` on every accepted hit; replenishment requires **60 seconds of inactivity**, not a new minute. Continuous browsing eventually consumes 100 hits, and signing into a new session behind the same IP does not reset that bucket. This differs from the #43 session-read limiter and is not covered by the #60 Worker session cache. `tests/organization-read-limit.test.ts` reproduces the failure across minute boundaries with a fresh session. The E2E report does not include the persisted limiter row or response headers; the mechanism is established by the installed source/configuration and the local reproduction, not a production DB inspection.

The Worker obtains IPs from trusted ingress, signs IP/method/path/query/time with `CONVEX_INTERNAL_SECRET`, and forwards the proof. Convex removes caller-supplied verified headers and accepts only a valid signature within 60 seconds. Better Auth trusts only `x-rendro-verified-client-ip`; direct/unverified requests share `no-trusted-ip`. No proxy or sign-out behavior changes in #71.

Explicit rules:

- GET `/organization/get-full-organization`, `/organization/list`, and `/organization/list-invitations`: **600 combined reads per authenticated user per fixed 60-second window**, keyed by SHA-256 of the persisted user's ID after signed-session verification. Fresh sessions, query strings and changed IPs cannot split this allowance. The atomic Convex mutation retains a **6,000-read/IP/window backstop**, applied before session lookup, plus **120 unverified reads/IP/window**. These are separate organization namespaces; existing session-read bounds are unchanged. Failed reads still consume their applicable buckets. The existing cleanup cron removes expired organization buckets as well.
- Sign-in/email remains **5/60 seconds/IP**; sign-up/email, password-reset requests and verification email remain **5/hour/IP**. Invitation creation is explicitly **10/60 seconds/IP**, allowing the UI’s ten-invitation batch (stricter than its former default of 100). Other credential and mutation endpoints retain Better Auth's existing rules. Only the three exact GET paths bypass its inactivity limiter; no wildcard or write exemption is introduced.

Controllers share one fresh access check within each explicit page load, clearing it on load completion, failure or mutation. Each subsequent navigation/load checks access again. Worker page guards and all Convex API handlers continue to authorize their own requests. Full organization/member/role responses are not cached across navigation. Server-rendered project data seeds the existing 30-second data cache, whose hits still require fresh identity/membership authorization. The switcher caches sanitized organization labels for 30 seconds; local/cross-tab membership writes invalidate immediately, and changes made by another user appear on the next lookup after the short freshness interval. Cached labels never authorize access.

Measured by executing the actual rendered controllers, SSR bootstrap and navigation/query runtime (`tests/organization-browsing.test.ts`), with an owner, one project and no teams, these are **browser API calls** (excluding the document and its server-side guard):

| Page | Initial before → after | First client navigation (cold cache) before → after | Repeat after SSR before → after | Auth org reads per load, before/after |
| --- | --- | --- | --- | --- |
| Overview | 5 → 4 | 6 → 5 | 5 → 4 | 2 / 2 (full + invitations) |
| Projects | 1 → 1 | 2 → 2 | 1 → 1 | 0 / 0 |
| Project | 1 → 1 | 2 → 2 | 2 → 1 | 0 / 0 |
| People | 3 → 2 | 4 → 3 | 4 → 3 | 2 / 2 (full + invitations) |
| API keys | 3 → 2 | 4 → 3 | 3 → 2 | 0 / 0 |
| Shares | 2 → 2 | 3 → 3 | 3 → 2 | 0 / 0 |
| Teams | 1 → 1 | 2 → 2 | 2 → 2 | 1 / 1 (full) |
| Deployments | 2 → 2 | 3 → 3 | 2 → 1 | 0 / 0 |
| Total (eight pages) | 18 → 15 | 26 → 23 | 22 → 16 | 5 / 5 |

The repeat column measures the first client return after server rendering; later warm visits also avoid project refetches in the old implementation. Initial loads additionally make one server-side access/project guard request and one Worker session lookup on a cold identity cache (zero on a warm cache). Each client navigation makes one fresh access call, already included above. Non-admin overview/people omit invitations; non-admin keys omit credentials/projects. At 100+ members the existing paginated member completion makes additional authorized management API calls; expanded team rosters also use management APIs, not auth endpoints. Switcher/chooser: one shared list request on a cold cache, zero on repeated opens/navigation within 30 seconds; then one refresh, or immediate refresh after an invalidating write. Previously that display cache had no time expiry.

GET org 429/503 responses use `Retry-After` (seconds or HTTP date; legacy `X-Retry-After` is also accepted). Two automatic retries at most, each delayed 1–2 seconds; longer waits or exhausted retries produce the styled page/menu retry state with sanitized copy. Navigation aborts pending retry timers. Writes are never retried.

The fast burst regression runs the production fixed-window reducer for **two users × 68 navigations/minute × 10 minutes × three org reads/navigation = 4,080 lookups**, with zero rejections. This exceeds twice round 5's roughly 34 total navigations/minute and conservatively includes the switcher and invitations on every navigation. A complementary HTTP/Convex test seeds those verified per-minute counts and samples both users at window starts/ends for ten continuous minutes, then signs in freshly and reads the organization. Boundary tests cover user/IP limits, unverified probes, revoked membership/session, sign-in and invitation limits. Tests simulate time, not deployed network capacity.

Release requires a **Convex deploy** for the auth options/plugin and component mutation/cleanup, plus the Worker/client asset release. No schema migration is needed.

### Cookie-authenticated write admission

Custom Convex HTTP writes declare their admission policy at registration. The shared `shared/request-admission.ts` helper requires an exact match to the origin of Better Auth's configured `SITE_URL`, rejects absent/opaque/foreign origins and `Sec-Fetch-Site: cross-site`, and requires `application/json` for JSON bodies (charset parameters are allowed). Origin checks never replace persisted session, membership, role, or scope authorization. Initial-password setup additionally reads the persisted session and checks its creation time against Better Auth's `sessionConfig.freshAge` (24 hours by default); stale sessions must sign in again.

Scoped bearer-key and operator-secret actions do not use cookie authority and are exempt. Mixed publication actions apply cookie admission before any session fallback; merely supplying an Authorization header does not exempt that fallback. The Worker also checks its cookie writes, including legacy organization/publication writes, using `SITE_URL` when set or the trusted ingress URL origin. Bodyless legacy DELETEs require origin checks but no JSON body. Dedicated and generic proxies preserve Origin and Fetch Metadata; publication proxies retain the original content type so rewriting a JSON body cannot grant admission.

Release Worker header forwarding before or alongside the Convex admission checks. No schema migration or management asset version bump is required.

Management controllers and account forms submit JSON to relative application URLs, allowing the browser to supply Origin. Browser regressions cover those mutations and same-site sibling rejection; HTTP tests also cover opaque origins. `tests/request-policy-matrix.test.ts` inventories actual Convex HTTP registrations, Worker mutation registrations, and public state-changing RPCs. Comment RPCs use explicit session JWTs and legacy internal RPCs use an explicit secret; ambient cookies do not authorize them.

### Workers Proxy Details

`src/auth-proxy.ts` handles four concerns:

1. **Header allowlist**: only `accept`, `content-type`, `cookie`, `origin`, `sec-fetch-site`, and `user-agent` are forwarded. `Host` and `cf-*` headers are excluded.
2. **Domain stripping**: Convex sets `Domain=convex.site` on cookies. The Worker strips the Domain attribute so cookies bind to the Worker origin.
3. **Redirect control**: `redirect: "manual"` leaves redirects to the browser.
4. **Sign-out**: `GET /api/auth/sign-out` shows confirmation; a same-origin `POST` calls Convex sign-out, then expires every known auth cookie (host and parent domain) and sends `Clear-Site-Data: "cookies"`.

The generic `/api/rendro/*` proxy uses the same header allowlist, with an exact GET-path exception for `/api/rendro/credentials/validate`, `/api/rendro/deployments/active`, `/api/rendro/deployments/staging`, and `/api/rendro/deployments`: these forward `Authorization` for scoped API-key validation. Other generic and Better Auth routes remain cookie-only. Dedicated deployment write and publication routes forward `Authorization` explicitly; deployment commits go through the Worker's storage checks. Pass-through requests retain authenticated client-IP forwarding. The dedicated migration project route also forwards its operator bearer secret to the secret-gated Convex action.

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

Validation checks organization, optional project binding, required scope, expiry, and revocation on every request, and records `lastUsedAt` only on success. `GET /api/rendro/credentials/validate` returns 200 with the principal for an accepted key, 401 for missing, malformed, expired, revoked, or insufficient keys, and 400 when organization or scope is missing. Unexpected backend failures remain sanitized server errors (502 through the Worker). The CLI uses `/api/rendro/deployments/check` for its preflight; that endpoint also permits member sessions and returns 403 when neither identity authorizes the request.

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
  │   └─ /management-query.js, /select.js, /management-pages.js, /commentor-parent.js, /private-viewer.js
  ├─ 7. Session middleware
  ├─ 8. Auth
  │   ├─ GET /api/auth/sign-out confirms; same-origin POST → Convex, cookie cleanup
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

### Response security headers

`src/middleware/security-headers.ts` is the outermost Hono middleware in both the Worker and Node entry points, including static files, redirects, preflights, 404s and errors. Every response gets `X-Content-Type-Options: nosniff`, a default `Referrer-Policy: strict-origin-when-cross-origin`, and a restrictive `Permissions-Policy` disabling camera, microphone, geolocation, payment, USB, display capture, motion sensors, autoplay, encrypted media, fullscreen, picture-in-picture, MIDI, credential retrieval, wake locks and XR. Route-specific referrer policies (especially `no-referrer`) are preserved. HTTPS requests additionally get `Strict-Transport-Security: max-age=15552000`, without `preload`; local HTTP does not. The request URL is authoritative, not an untrusted forwarded-protocol header. Adding `includeSubDomains` is an owner decision pending confirmation that every subdomain is HTTPS-only.

| Route class | Framing | Content Security Policy / exceptions |
|---|---|---|
| Landing, auth, account, other app HTML and ordinary 404s | `frame-ancestors 'none'`; `X-Frame-Options: DENY` | `default-src 'self'`; per-request script and style nonces; no inline event handlers or eval; explicit font/image/connect sources below |
| Organization/project management HTML | Same deny policy | Nonced scripts; inline styles allowed for dynamically inserted management page CSS and loading states |
| Docs shells (`…/docs`, `/docs/:org…`), publication shells (`/p/:slug`, `/public/:org/:slug`) | Same deny policy; `frame-src 'self'` permits their document iframe | Nonced scripts; Tailwind CDN script allowed; inline styles allowed for Tailwind runtime CSS and shell layout updates |
| Private project HTML (`…/docs/files/*`, `…/docs/view/:ticket/files/*`) | `frame-ancestors 'self'`; `X-Frame-Options: SAMEORIGIN` | Preserve `sandbox allow-scripts allow-forms allow-popups allow-downloads` (no `allow-same-origin`); keep `no-referrer`, `private, no-store`, ticket base, renewal, and comments bridge |
| Publication/share HTML (`/p/:slug/files/*`, `/s/:token/files/*`, `/public/:org/:slug/files/*`, legacy `/share/:token`) | Same self-only framing | Opaque sandbox as above, without app resource restrictions or nonce rewriting; publisher scripts, styles, resource origins and base URLs remain publisher-controlled |
| Share shell (`/s/:token`) | Deny framing; `frame-src 'self'` | App policy with nonced scripts/styles; preserve `no-referrer` and private caching |
| Legacy authenticated documents (`/files/*` → `/docs/:org/:path`; frame `/legacy-view/:org/files/*`, assets `/legacy-view/:org/view/:ticket/files/*`) | Shell denies framing; document frames are self-only | Same opaque sandbox as project docs: `sandbox allow-scripts allow-forms allow-popups allow-downloads`, never `allow-same-origin`; private/no-store, no-referrer, ticket assets and parent comment bridge |
| JSON/API, redirects, and static/document assets | No added framing restriction | Baseline headers only; existing asset `default-src 'none'`, cache, CORS and cookie headers remain intact; no HTML policy is applied |

All trusted HTML uses `Cache-Control: no-store`: landing and anonymous pages, auth/account/invitation pages (including sign-in errors), organization/project management, legacy and modern docs shells, legacy and modern publication shells, share shells, and styled 404/410 pages. Existing private policies retain `private, no-store`. No shell uses a hash-based cache exception; publication shells deliberately give up public revalidation caching so each navigation receives a fresh nonce. Successful publisher documents, publication tree/sitemap responses, and static/document assets retain their existing cache policies and receive no app nonces. The legacy starter document stored during org creation also has no request nonce.

Styled HTML errors on document URLs use the trusted nonce policy, with self-only framing so they remain visible in the owning viewer; successful publisher documents retain their sandbox policies.

Trusted HTML policies also use `object-src 'none'`, `base-uri 'self'`, and `form-action 'self' https://accounts.google.com`. The sign-in UI calls the same-origin Better Auth proxy and navigates to Google's returned OAuth URL; this policy does not restrict top-level navigation. `connect-src` permits self, the exact configured `CONVEX_URL` and `CONVEX_SITE_URL` HTTP(S) origins, and the corresponding WS(S) origin for `CONVEX_URL`. Local Convex HTTP/WS URLs work without production-wide wildcard allowances. Google Fonts uses `fonts.googleapis.com` stylesheets and `fonts.gstatic.com` fonts; images allow self, data URLs and `lh3.googleusercontent.com`. Tailwind's `cdn.tailwindcss.com` script is permitted only on viewer/publication shells.

**Inline allowances:** scripts never use `'unsafe-inline'`, `'unsafe-eval'`, or `'unsafe-hashes'`. Trusted templates explicitly emit a cryptographically random 144-bit nonce from request-local async context; responses are not scanned to authorize arbitrary script tags, and publisher HTML is not rewritten. Management's fetched-page fallback applies the **active document's** nonce when executing its validated controller, rather than the next response's nonce. Landing/auth/share-shell style blocks are nonced. `style-src 'unsafe-inline'` is limited to management and viewer shells because their runtime inserts style elements. `style-src-attr 'unsafe-inline'` supports existing authored attributes and interactive sizing/loading behavior on app pages. Publisher sandbox policies deliberately do not impose script/style source lists, so user-authored HTML continues to work in its isolated origin.

`tests/security-headers.test.ts` covers route policies, nonce isolation, HTTPS detection, existing private protections and non-HTML responses. `tests/security-headers-browser.test.ts` runs Chromium against actual Worker routes on an isolated local server, with fixture auth/storage/comment backends, a `securitypolicyviolation` listener in every frame and CSP console checks. It exercises landing, sign-in errors and auth error redirects, email verification, ordinary and share 404/410s, `/docs/:org` 404s, management navigation, ticket-backed CSS and the real comments postMessage host/widget. The suite uses the shared offline Chromium harness and runs in the serialized browser project included by `pnpm verify` (see [Chromium tests](BROWSER_TESTS.md)). Font/CDN responses are deterministic fixtures; unexpected external requests fail the suite. The former `CSP_SMOKE_EXTERNAL` switch is no longer supported by this offline suite. It does not perform a live Google login or contact production Convex.

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

### API-key HTTP rate limits

Convex is authoritative: `convex/apiKeyHttp.ts` wraps credential validation, every deployment action (start, active, staging, commit, fail, list), and publication create/list/remove. Limiting runs before body parsing or business logic, so malformed requests also count. A read-only hash lookup verifies an active, unexpired key; a shared token bucket uses the credential's database ID, never a raw key or caller-selected tenant/scope. Scope, project, organization, expiry and revocation authorization still run for each operation. Failed operations consume capacity too; cookie-only session routes retain their session authorization path.

The official `@convex-dev/rate-limiter` component provides persisted, transactional token buckets across Convex instances. There was no application-level limiter to reuse; Better Auth's database limiter covers only `/api/auth/*`. Version 0.3.2 is pinned because it supports the existing Convex 1.42 dependency, avoiding an unrelated backend upgrade. The component is registered in `convex/convex.config.ts`; **Convex deploy required** when releasing this change.

- **Verified credential:** refill 6,000 requests/minute (100/second), capacity 12,000. API-key actions share this credential budget across projects and IPs, except failure cleanup. Following the component's contention guidance, 50 shards split the total rate and capacity (2 requests/second and 240 burst tokens each); two-choice shard selection may reject near exhaustion before every token is spent.
- **Failure cleanup (`/deployments/fail`):** a separate per-credential bucket refills 60 requests/minute with capacity 20, so exhausted upload budgets cannot block retention cleanup. Scope and tenant checks still apply.
- **Invalid, expired, revoked, malformed or missing key on key-required routes:** refill 120 requests/minute (2/second), capacity 240 per verified IP. Invalid Authorization on session-capable routes also counts. IPs come only from #29's method/path/query-bound signed ingress metadata, verified using `CONVEX_INTERNAL_SECRET`. Deployment and publication Worker handlers sign their rewritten backend target/method, including staging reads for PUT uploads. Direct callers, absent secrets and invalid/stale signatures share one `unverified` bucket; raw forwarding headers cannot select a bucket. Valid credentials use their own budgets even when their IP's failed-attempt budget is exhausted. A verified key with insufficient scope/tenant access still consumes its credential budget. Each failed-key attempt atomically updates an expiry registry with its component debit. An hourly cron resets buckets inactive for at least an hour (well beyond the two-minute full refill), deleting registry and component rows together in batches of 100 with scheduled continuations. Concurrent reuse conflicts with cleanup in the same transaction, preserving active budgets.

Request accounting from `cli/src/index.ts` and `src/routes/deployments.ts`: with C changed files and U reused files, a successful push makes **C + ceil(U / 16) + 3 Worker requests**, and **C + ceil(U / 16) + 4 Convex HTTP actions**. The fixed cost is active check, start, staging check at commit, and commit; each changed file and each 16-file copy batch adds one staging authorization. Failure cleanup adds one action; publication creation adds two (deployment read + publication write). Default upload concurrency is eight. A 10,000-file cold push costs 10,004 tokens, leaving 1,996 burst tokens without relying on elapsed time. A following 500-changed/9,500-reused push costs 1,098 tokens, still within that initial burst. Tests execute both real Convex HTTP sequences with time frozen. Sustained requests replenish at 100/second. These are application request limits, not file-size or storage-work quotas.

Exhaustion returns `429`, `Retry-After` rounded up to whole seconds (minimum one), and `{ "error": "Rate limit exceeded", "code": "rate_limited" }`. Worker proxies preserve the status/body/header. This is an explicit error class in `httpErrors.ts`; unexpected limiter/backend faults remain sanitized 500s (502 through the Worker). Rate-limit responses do not log secrets, keys, request bodies or IPs.

The CLI reports `429 Rate limited. Retry after Ns.` It retries only 429 responses for reads, same-byte file PUTs, copies of immutable manifest files to the same staging keys, and idempotent failure cleanup. Up to three retries use exponential delays (1, 2, 4 seconds), honor the greater `Retry-After` seconds/date value, and add 0–249ms jitter. A wait over 60 seconds stops with the rate-limit message. If failure cleanup remains rejected, the CLI exits non-zero and reports both the original deployment error and the cleanup failure, identifying the deployment that may remain staging. Start, commit and publication mutations are not automatically replayed; transport errors and 5xx responses are not retried. Start creates a new deployment and commit changes the active pointer, so their outcomes must not be guessed after an ambiguous response.

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
| Legacy (email-domain org) | `/docs/:org/:path` (old `/files/:org/:path` redirects here) | `/legacy-view/:org/files/:path` | `/api/tree/:org` |

Legacy `/docs/:org` and nested document URLs preserve email-domain access to existing legacy organizations during migration. Signed-out requests redirect to sign-in with a return path. Missing or inaccessible organizations return the shared styled 404, including when the requested slug matches the signed-in user's domain; they never start v1 organization creation. New organizations use the v2 management flow at `/organizations` (the 404 links to `/organizations?choose=1` so existing members can also choose **New organization**).

The project and publication viewers share `renderScopedDocumentShell()` in `src/routes/app.ts`. The project shell resolves the active deployment through Convex with the session cookie, reads `manifest.json`, and selects `?doc=` or `index.html` (falling back to the first HTML file). Unknown paths return the shared 404 page.

`…/docs/tree` returns HTML document paths from the active manifest in pages of 200 (`{ documents, cursor }`). `…/docs/files/*` serves only manifest entries with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and either `sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'` (HTML) or `default-src 'none'` (other types) as the Content-Security-Policy. HTML responses get a small injected script for navigation messages, the shell shortcut, and the comment configuration; stored publisher bytes are never modified.

### Document fragments

Private project, publication (including legacy publication), and legacy docs use
one link bridge from `src/viewer/navigation.ts`. Bare `#fragment` links refer to
the current document independently of the injected ticket/publisher base. Explicit
same-document links scroll in place, without navigating the iframe or touching
comment anchors/drafts. Targets are percent-decoded and matched by ID, then legacy
`<a name>`; empty `#` and an unmatched case-insensitive `#top` scroll to the top.
Missing targets do nothing.

Fragment-only clicks use **`history.replaceState`** in the parent, preserving its
existing state and avoiding a history entry per heading. Document changes retain
the tree's existing `pushState`, now including the destination fragment. The iframe's
pending navigation uses `location.replace` so it cannot add a second history entry. The parent
passes its hash to the frame after load, including on reload and document
back/forward; tree clicks clear the previous document's hash. Bridge messages check
the current frame source and expected origin, and hashes are bounded to 4096
characters and used only as data (never raw selectors or HTML).

Private shares use the same fragment bridge with their single-document shell.
Their shell records the granted path in `doc` and the publisher query in
`docQuery`, matching private/public viewer query encoding. Queries (including the
leading `?`) are bounded to 4096 characters and cannot contain literal fragments
or line breaks. The share route rejects invalid queries and any `doc` other than
the grant's document; query keys and encoded traversal strings remain data, never
paths or share tokens. The iframe reports its query and fragment after native
loads/history restoration; the shell replaces the current entry without adding
history entries. Reload and copied URLs restore the same query and fragment.
They synchronize parent deep links without broadening the grant to other HTML
files. Legacy `/share/:token` serves the document directly and retains native
browser fragment handling.

### Viewer asset MIME and CORS

`src/routes/asset-headers.ts` supplies MIME, `nosniff`, and opaque-origin CORS headers for public (`/p/:slug/files/*`), share (`/s/:token/files/*`), and private project assets. Font extensions are case-insensitive and override older manifest MIME values: `.woff2` → `font/woff2`, `.woff` → `font/woff`, `.ttf` → `font/ttf`, `.otf` → `font/otf`, and `.eot` → `application/vnd.ms-fontobject`. Other manifest MIME values are preserved; shares use the shared extension map. This correction does not require republishing existing deployments. Sandbox asset failures identified by image/font/CSS/JavaScript Accept types or extensions use a plain body and `nosniff`, preserving their 403/404 status and access checks. HTML document failures retain styled error pages; no capability URLs are echoed in asset errors.

After their existing access checks, public and share files send the fixed `Access-Control-Allow-Origin: null`, matching ticket-authorized private files. All three publisher documents have an opaque sandbox origin. The fixed allowance serves this origin without extending CORS reads to every website origin (`*`) or reflecting caller input. Shares remain token-scoped and `private, no-store`; public files retain public revalidation caching. CORS is not authorization: any opaque origin that possesses a share/ticket URL can use that capability, subject to the existing revocation, scope, session, and membership checks. Cookie-authenticated canonical private file URLs still send **no** CORS allowance; private relative resources must use the injected ticket base. No viewer file response enables `Access-Control-Allow-Credentials`.

The allowance applies uniformly to font requests, `<img crossorigin="anonymous">`, `<script type="module">`, and ordinary publisher `fetch()` GETs, including HTML reads within the route's existing scope. Opaque-origin requests must be non-credentialed (default same-origin credentials or explicit `credentials: "omit"`). Credentialed cross-origin reads and preflight-requiring methods/custom headers remain unsupported; these read-only routes do not add OPTIONS handlers or expose application APIs. Root-relative/external resources remain subject to their destination's CORS policy; private publisher fetches should resolve relative paths against the current `document.baseURI` to inherit the ticket. None of these headers changes the sandbox, CSP, referrer policies, or access validation.

`tests/viewer-asset-headers.test.ts` covers every font MIME across public/share/private-ticket/private-cookie routes, other CORS resources, fixed origins, and denied responses. `tests/viewer-fonts-browser.test.ts` uses the shared isolated Chromium harness, real viewer routes/shells and a local original font fixture to verify loaded font faces, anonymous images, modules and fetches in all three opaque viewers without CORS errors or subresource cookies.

### Private viewer asset authorization

The project iframe remains an **opaque-origin sandbox**, both in the shell attribute and the HTML response CSP. It never gets `allow-same-origin`; Better Auth's SameSite cookie policy is unchanged. The trusted parent can initiate a cookie-authenticated document navigation, but requests made by the sandbox itself cannot depend on that cookie.

The server uses a dedicated parser-based streaming injector to establish the ticket `<base>` before publisher resources, including documents with an implicit head, omitted head/body tags, or a doctype/comment prelude. The cosmetic head injector keeps its existing behavior. It points at `…/docs/view/<ticket>/files/<document-path>`. Relative stylesheets, images, scripts, CSS `@import`, nested CSS `url()`, and fonts therefore inherit the ticket prefix. The iframe's canonical `src` remains `…/docs/files/<document-path>` so the tree, deep links, and parent-mediated comments retain their existing document identity. Same-document fragment links stay in the current frame. Public publications and private-share routes use their existing access models.

- **Ticket:** a randomized, authenticated-encrypted JWE (`dir` / `A256GCM`), valid for 15 minutes. A domain-separated SHA-256 key is derived from the Worker's existing `AUTH_SECRET`; rotating that secret invalidates outstanding viewer tickets. The encrypted payload binds the organization, project, active manifest, and only the signed session-token cookie. No readable session material, API key, or cached session-data cookie is exposed to publisher code.
- **Every request:** decrypt and validate the ticket, then ask Convex for the active deployment using the recovered session-token cookie. Convex freshly checks the persisted session, organization membership, and project ownership. The active manifest must still match the ticket, and the requested path must appear in that manifest before R2 is read. There is no authorization cache. Session revocation, membership removal, or changing the active deployment denies subsequent requests; already-rendered bytes cannot be recalled.
- **Responses:** private assets and renewal responses are `private, no-store` with `Referrer-Policy: no-referrer`. Ticket-authorized responses permit `Access-Control-Allow-Origin: null` for opaque-origin fonts/modules, without credentialed CORS. The ticket is a scoped read capability, not a session replacement or permission to call application/comment APIs.
- **Renewal:** `private-viewer.js` asks the trusted parent for a replacement after five minutes, checking once a minute and on focus, visibility, pageshow, or resource errors. The parent accepts messages only from its current opaque content frame and calls cookie-authenticated `…/docs/viewer-ticket?manifestKey=…`. A ticket cannot renew itself. New URLs replace the base and current image/media/stylesheet URLs in place. CSS Syntax tokenization resolves scoped `url()` values (quoted, unquoted, and escaped), string candidates in `image-set()` / `-webkit-image-set()`, `src()` strings, and `@import` strings in inline styles and `<style>` blocks to explicit renewed URLs; Chromium otherwise retains the old base in parsed CSS. URL tokens are handled across properties, including font sources (preserving `format()`), cursor, masks, list/border images, and generated content. Fragment-only references such as `filter: url(#id)` and data/blob/absolute/protocol-relative publisher URLs remain unchanged; only absolute CSS URLs previously emitted by the renewal client are renewed again. For each scoped stylesheet link, an adjacent clone retains the same attributes/media and cascade position while loading the renewed `href`. The active sheet is removed only after the replacement loads; a failed replacement is discarded and retried on a later renewal with exponential backoff (one minute, capped at fifteen). Per-link serialization coalesces overlapping renewals to the latest ticket, keeping at most one pending clone per active sheet. Reloading the parent reloads its `@import` graph, including nested imports; the link load event waits for these sheets, and nested CSS/image/font URLs inherit the new ticket. This keeps deferred resources working without reloading the document or losing comment drafts. Resuming a suspended tab can briefly fail a resource before renewal retries it. Offline, revoked, and expired-session viewers fail closed; reload the shell after signing in again. Superseded deployments also fail closed: after fresh session, membership and project authorization, renewal for a different project-scoped manifest returns `409 { code: "deployment_superseded" }` without issuing a ticket. The trusted shell announces "A newer version of this document was published." with a non-blocking Reload button. Renewal heartbeats and resource-error-triggered renewals both detect this state. Reload is user-initiated and preserves the entire current shell URL (document path, publisher query and fragment), along with the existing user/document-scoped sessionStorage comment drafts and pending operation identities. Stale responses after frame navigation are ignored; there is no automatic reload loop. The comment bridge’s `commentor-viewer-reload` message is also only a request for this parent-owned notice: publisher code and the widget share an opaque frame, so neither the sender nor claimed user activation authorizes navigation. Repeated requests leave the visible notice and its polite announcement unchanged. Private and legacy private shells provide the Reload control; share and public shells ignore this message. Widget-version recovery first offers the notice, then waits for the reader’s parent-side Reload.

**Publisher URL contract:** use document-relative URLs (including relative paths inside CSS). URLs hard-coded to the canonical private `…/docs/files/` prefix and absolute/root-relative asset URLs cannot inherit the ticket and are not rewritten. An existing publisher `<base href>` is resolved against the canonical document URL: if it points within this project's private file tree, the injected base preserves its path/query/fragment through the ticket route. External or out-of-tree bases are left in control and receive no ticket base or renewal client activation. Publisher base markup is preserved, and (as required by HTML) must precede URL-bearing resources. Publisher scripts must not replace the managed ticket base. Configure the documentation generator's relative asset/base setting before publishing. Publisher JavaScript should resolve new resources against `document.baseURI` at request time rather than retaining ticket URLs beyond their lifetime. The renewal client updates common DOM resource attributes and styles, not arbitrary URL strings held in application state. Open the project shell for long-lived viewing; standalone file tabs have no trusted parent to renew tickets.

**Logging:** Node and Worker request logs redact the ticket path segment; errors log only their type and redacted path. Wrangler disables raw invocation logs and URL-bearing traces in both environments. Any additional reverse proxy, access-log sink, analytics, or tracing integration must similarly redact these paths before recording them. Never persist full private viewer URLs. Short-lived tickets are visible to the publisher document by design and must be treated as private capabilities.

The Chromium regression runs as part of `pnpm verify` using an isolated local server and an opaque sandbox, with a fake clock that enforces ticket expiry. Install its browser with `pnpm exec playwright install --with-deps chromium`; Linux hosts can use `/usr/bin/chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. CI installs Chromium before verification. No deployed backend or private data is used.

### Legacy private documents and comments

Legacy storage and modern project storage have disjoint authorization boundaries. Legacy tickets bind an explicit namespace prefix; issuance and every object read reject reserved or ambiguous namespaces and noncanonical paths. Modern tickets and active manifests must belong to the requested project namespace. Existing data is not moved: ambiguous historical keys fail closed across legacy viewer, sharing, publication, tree, and sync access. Previously issued legacy viewer tickets without a storage scope must be renewed by the authenticated parent or replaced by reopening the document.


Legacy `/files/:org/:path` bookmarks redirect (302) to the existing `/docs/:org/:path` shell after the same email-domain authorization and file/deletion checks. Query strings are retained and browsers carry the fragment across the redirect; the shell forwards it to the document. The legacy tree and signed-share action stay unchanged. The shell loads `/legacy-view/:org/files/:path` with the same sandbox attribute and response CSP as project docs. Publisher HTML never receives `allow-same-origin`, including when a frame URL is opened directly. CSS/images/scripts keep their stored content types; relative assets and nested CSS resolve through the ticket base. Relative links and old `/files/:org/…` document links navigate through the parent. Same-document anchors stay inside the document. Stored objects and v1 comment keys are not migrated or rewritten.

The legacy viewer reuses the streaming head injector and renewal client. Its encrypted tickets have a separate audience/key domain, bind the legacy slug and session-token cookie, expire after 15 minutes, and expose only that legacy tree. Every ticket request freshly validates the session against Better Auth, checks its current email-domain slug, and checks soft deletion before reading storage. The trusted parent alone renews tickets at `/legacy-view/:org/viewer-ticket?manifestKey=:org`; the shared renewal protocol's `manifestKey` field carries the legacy slug because v1 has no immutable deployment manifest. Legacy writes remain mutable, and deletion/session changes deny future reads. The modern relative-resource/publisher-base contract above also applies here. Ticket paths are redacted in application logs.

Legacy comments use the existing versioned parent/iframe protocol with a backend adapter to `threads`/`replies`. Authentication, durable drafts, operation IDs, and session-change checks live in the trusted parent. The iframe never receives a session or Convex auth token. The parent derives scope from its canonical frame URL, and the backend independently validates identity and the supplied document scope. Existing threads, replies, anchors, resolve/unresolve, archive/unarchive, deletion, and live updates remain available; v1 still returns the full reply list inline. New writes have stable IDs, deduplicated create/reply operations, explicit status targets with 30-day retry receipts, and identity-only deletion tombstones. Older widgets may omit IDs/status targets and retain their old toggle contract. New records bind authors by authenticated user ID; preexisting records use their stored author email.

**Legacy moderation:** archive/delete are author-only, including reply deletion. The v2 author/admin override does **not** apply to legacy comments: v1 has no admin membership or trusted Better Auth organization binding. Never match organizations by slug to infer moderation rights. Follow-up: establish an operator-provided legacy-to-organization mapping before adding an admin override. Same-domain readers may still comment, reply, and resolve/unresolve. These checks are enforced server-side, and query responses supply the widget's deletion/archive permissions.

Deploy the additive Convex schema/functions before the Worker/browser bundles; no object or comment backfill is required. Existing legacy data and URLs remain live for migration verification. The legacy browser regression uses the shared offline Chromium harness against real Worker routes, the actual bridge/adapter/widget, and a fixture Convex transport executing the v1 queries/mutations.

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
  │   ├─ doc-navigate → parent authorization / confirmation → loadDoc(path, push/replace)
  │   ├─ doc-loaded → acknowledge expected path (no navigation or tree fetch)
  │   └─ shell-toggle → Ctrl/Cmd+Shift+H inside the iframe toggles the shell
  └─ popstate / initial URL → loadDoc(path)
```

The script URLs carry `?v=` cache-busting versions that change with each rebuild; read the current value in `src/routes/app.ts` rather than copying it.

### Document navigation authorization

Any browser-recognized activation gesture inside the opaque document frame can
authorize document navigation, including interaction with the in-frame comment
toolbar or widget. This is accepted by design: the publisher controls that frame
and can overlay or intercept its input, so a widget gesture there is a document
gesture. The widget is not a separate trusted input boundary.

Parent-owned UI input is reserved before its control handles it and never
authorizes a document-requested navigation. This includes Review, Open, Dismiss,
the sidebar, the theme toggle and the sign-out overlay. Open explicitly confirms
only the immutable destination displayed by the parent; its activation cannot
authorize a different document request.

Navigation remains confined to the current project/deployment namespace.
`validRelativeDocumentPath` rejects literal traversal and malformed path segments;
the shell prepends its own `ORG` namespace and encodes each path segment beneath
the fixed document route. Encoded traversal, schemes and foreign org/project
prefixes cannot replace that route or namespace. The server separately enforces
deployment/publication scope. The parent updates only its viewer route, and the
opaque iframe sandbox does not permit top navigation, even with activation.

The private, public and legacy tree shells own one navigation gate for their
entire lifetime. A valid `doc-navigate` from the current content frame requires
`navigator.userActivation.isActive === true` and an unused activation. The shell
marks it used before replacing the iframe. Every 100ms it observes activation;
only an observed `false` rearms the gate, and another request still requires
`true`. Time alone never authorizes navigation, so this does not depend on a
browser-specific activation timeout. Suspended/background polling fails closed.
Back/Forward also marks the current activation used before restoring a document.
Traversal ends the history burst separately: a subsequent parent-confirmed link
starts a new entry so that Back can return to that restored document.

An unverified or already-used activation offers a small parent-owned “Open
linked document” notice. Its bounded path/query/fragment is assigned with
`textContent`, never HTML. The first destination stays fixed while visible;
repeated requests do not rewrite it, steal focus, or add notices. Dismissal
leaves a parent-owned “Review linked document” button. While dismissed, later
requests replace one bounded pending destination (path, query and fragment),
de-duplicating identical targets without changing the DOM or announcing updates.
Only the reader's Review action reopens the prompt and freezes that destination
for confirmation; frame messages and elapsed time cannot reopen it. This avoids
timer-driven nagging while preserving access to later links even without the
activation API. Parent document navigation clears both the prompt and pending
destination. Focus moves only for explicit parent Review/Dismiss actions. The native button
works with mouse and keyboard even when the activation API is absent. Shell
`toggle` messages also fail closed when the API is absent. Share viewers retain
their native, document-scoped navigation path.

A first authorized navigation pushes history; explicit parent confirmations or
tree selections while activation remains consumed replace that entry. Fragment
reports also replace, never push. One Back therefore returns before the burst.
Without the activation API, only parent controls can navigate, and confirmations
within five seconds of the previous navigation replace its history entry. Rapid
legitimate document links during one activation (about five seconds in Chromium)
may need confirmation. A false-to-true transition missed between polling ticks
also needs confirmation; this conservative trade-off preserves ordinary first
mouse/keyboard links without treating iframe gesture claims as authority.

**Why not consume activation directly?** The [HTML activation model](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation)
consumes activation across the frame tree, but `UserActivation` only exposes
read-only state. Its direct consume command is WebDriver-only, unavailable to
page code. [Chromium documents `window.open()` consumption](https://developer.chrome.com/blog/user-activation),
and [Firefox's window implementation](https://searchfox.org/mozilla-central/source/dom/base/nsGlobalWindowOuter.cpp)
consumes when opening a new window, not when reusing an existing one.
[WebKit documents consuming window/share flows](https://webkit.org/blog/13862/the-user-activation-api/)
and also lists notification permission and payment-request UI. These operations
have visible effects; attempting an invalid call or reusing a window is not a
portable side-effect-free consume primitive. We therefore use observed
inactivity, not a popup, permission prompt, or guessed timeout. The activation
path applies to modern Chromium, [Firefox 120+](https://www.mozilla.org/en-US/firefox/120.0/releasenotes/),
and [Safari 16.4+](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/).

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

The legacy opaque viewer (`/docs/:org`) loads `commentor.js` inside its sandbox and routes comments through the same parent bridge, using an adapter for the legacy `threads`/`replies` tables. These tables retain email-domain authorization with author-only archive/delete until an operator-provided organization mapping exists (see Legacy private documents and comments above). Worker-only legacy API-key and soft-delete functions require `CONVEX_INTERNAL_SECRET`, which must match in the Worker and Convex environments.

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

`public/management-query.js`, `public/select.js`, and `public/management-pages.js` are tracked; `pnpm verify` rebuilds them and fails if they drift from source. `public/commentor.js`, `public/commentor-parent.js`, `public/lazy-tree.js`, `public/private-viewer.js`, and `bin/rendro.mjs` are ignored and built in the release path. When management controllers or templates change, rebuild assets and bump `MANAGEMENT_SHELL_VERSION` in `src/routes/management-navigation.ts`; a shell whose version does not match the loaded bundle refetches current HTML, falling back to full navigation if that HTML is incompatible. Bump `MANAGEMENT_QUERY_VERSION` or `SELECT_VERSION` in `src/routes/management-asset-versions.ts` when those bundles change. After `pnpm build:assets`, run `pnpm record:assets` to append the new version’s SHA-256 to `scripts/asset-versions.json`. The recorder and `pnpm verify:assets` reject changed bytes at an existing version. CI also compares the ledger against the PR base (or previous push), rejecting rewritten or deleted historical hashes. The viewer versions (`LAZY_TREE_VERSION`, `PRIVATE_VIEWER_VERSION`, and `COMMENTOR_PARENT_VERSION` in `src/viewer/asset-versions.ts`) also use this ledger and recording workflow, even though their built bundles are ignored. Bump the corresponding version before recording changed bytes. Builds never update the ledger automatically.

### Environment Variables (Workers)

`src/config.ts` validates the Worker environment at startup. The table lists every named string setting read by Worker code; `ASSETS` is the separate static-asset fetch binding in `src/worker.ts`. Google OAuth credentials are read only by Convex, and `BASE_URL` is unused. The local Node entry reads `PORT` separately.

Both production (top-level) and `development` declare the same required secrets: `CONVEX_INTERNAL_SECRET`, `AUTH_SECRET`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, and `MINIO_SECRET_KEY`. Wrangler checks these at deploy time, and `src/config.ts` validates them at startup. Production commands use the top-level configuration without an `--env` flag; development commands use `--env development`.

| Variable | Storage | Purpose |
|---|---|---|
| `NODE_ENV` | Wrangler var | Runtime mode; `production` selects JSON logs at `info` level |
| `CONVEX_URL` | Var/secret (optional at startup) | Convex deployment URL for legacy calls and browser comments; defaults to empty, disabling those features. Set for the full app |
| `CONVEX_SITE_URL` | Var/secret (optional) | Convex HTTP action origin for auth and project routes; derived from `CONVEX_URL` when unset. Startup and `/health` work without either URL; backend routes do not |
| `CONVEX_INTERNAL_SECRET` | Secret (required by `wrangler.toml`, ≥32 chars) | Legacy Worker-only Convex functions; same value in Convex |
| `AUTH_SECRET` | Secret (required, ≥16 chars) | Encrypts scoped private viewer tickets and signs legacy `/share/:token` HMAC links. Better Auth signing happens in Convex |
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
4. Run again with `--apply`. For a non-local Worker, also supply `--confirm-endpoint <Worker origin>` (for example, `--confirm-endpoint https://rendro.example`). Apply and rollback print the sanitized Worker origin, source storage origin/bucket, source Convex origin, and organization/project mappings before any remote writes; the confirmation must match the displayed Worker origin. The tool queries `deletedFiles:filterFn` (the `deleted_files` table, indexed by full object key), excludes soft-deleted objects, then hashes the remaining objects and creates/reuses a dedicated project. It sends the sorted manifest to `/api/rendro/deployments/start`, reads `deployment.deploymentId`, uploads bytes through `PUT /api/rendro/deployments/:id/files/*`, then commits through `POST /api/rendro/deployments/:id/commit`. The Worker writes the manifest/tree index and validates uploaded hashes and sizes. When `legacyApiKey` is supplied, the tool reads the current legacy publication records and recreates them as pinned mappings. Removed publication records are not recreated. Files inside published folders that legacy public routes cannot serve (non-HTML or ambiguous paths) are excluded from the deployment, since v2 can serve any manifest entry. A deleted/missing entry document stops migration before destination writes. Before any destination write, the complete inventory (including private and deleted objects), publication prefixes, and entry paths must survive the shared v2 publication/deployment path functions unchanged; invalid paths and normalization collisions abort the target with the offending paths listed. The single terminal slash in a legacy folder prefix is its delimiter; extra slashes, whitespace trimming, decoding, and dot segments cannot silently change scope. Case and Unicode code points remain distinct, exactly as in v2. Deletion and publication filtering use the validated paths; the migration never repairs or remaps an unsafe source path. Deletion and publication state are checked again before publishing; changes stop publication.
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
