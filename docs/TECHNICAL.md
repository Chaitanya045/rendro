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
E2E uses disposable S3Proxy filesystem storage. The Worker DOM shim exposes
iterable named XML attributes with a length, matching the AWS SDK browser parser;
empty S3 listing fields (including continuation tokens) deserialize as empty strings.

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

The local authentication regression suite (`e2e/auth.spec.ts`) exercises these
flows against workerd and the disposable Convex backend, with captured mail and
a local Google protocol fixture. Original signup verification and resend are
separate journeys; reset mismatch asserts no request, and the shared sign-out
helper waits for method loading to settle before clicking the moving footer control.
Sign-out asserts hidden, inert protected containers in both tabs. Expiry tests age disposable backend records;
rate-limit tests use the unchanged production limiter. See
[Browser tests](BROWSER_TESTS.md#authentication-journeys-111) for isolation,
assertions, and documented expected failures.

Auth-page styles enforce `[hidden]{display:none!important}`, matching the
management shell, so layout rules cannot expose inactive controls. Sign-up
success hides the credential form, Google button and divider; both sign-up and
password-reset success focus the labelled confirmation panel. Failed requests
retain the form and allow retry; following the sign-in/create-account links
returns to fresh, enabled controls with the original destination preserved.
Auth templates and their runtime are inline in no-store HTML, outside the
management bundle/version ledger. The hidden-state audit includes management
role-gated actions, docs links, refresh/switcher panels, pinned-deployment fields,
team rosters and onboarding credential replacement; these already inherit the
management shell rule. Chromium coverage checks publication mode and role
transitions as a regression control.

Unchecked **Keep me signed in** creates a one-day, non-refreshing session and
session-only cookies. Checked sign-in retains seven-day sessions with normal
refresh after the update age. A non-client-writable `session.rememberMe` field is
written with each new session by a Better Auth database create hook. The lifetime
plugin replaces the internal `dont_remember` preference with the persisted choice
before Better Auth handles HTTP or server API calls. It rebuilds the request
Cookie header from Better Auth's own parser (`better-call`, pinned to Better
Auth's exact version), drops every client variant of the marker, including
prefixed and mixed-case names, and places the server-derived marker first.
Missing, invalid, forged, replayed, or malformed client markers cannot change
refresh or cookie persistence, including organization middleware, Worker reads,
and viewer-ticket authorization. Only endpoints that never resolve the caller's
session (`/ok`, `/error`, `/sign-out`, and Convex JWKS/OpenID discovery) skip
the plugin; a test enumerates every Better Auth endpoint to keep that list
exact. The plugin runs after the read limiters and reuses their resolved
session; it does not bypass rate limits. Password changes that revoke sessions
carry the authenticated session's choice into the replacement session and cookie.

The one-day limit is also enforced where sessions are stored. Better Auth's
database adapter is wrapped so every session write, including writes inside
transactions, keeps a non-remembered session's `expiresAt` within one day of its
`createdAt`, whatever request, header, or server call produced the write. A
session's `createdAt` and `rememberMe` cannot be updated, and bulk or counter
writes to session lifetime fields are refused. Shortening an expiry is always
allowed.

Better Auth sessions are cookie-only. Convex removes `Authorization` before
Better Auth handles `/api/auth/*` (the Worker already omits it there), so the
`bearer` hook bundled with the Convex plugin never resolves a session.
Server-side session reads (`httpOrganizationAccess` and the initial-password
route) pass only the Cookie header. They pass no credentials when the request
has an `Authorization` header: such a request asked for API-key authority and
does not fall back to the browser session. The CLI uses API keys on
`/api/rendro/*` only. The Convex plugin's 15-minute `convex_jwt` cookie keeps its
Max-Age for non-remembered users. This is accepted: it is a short-lived access
token minted from a live session, not a session. It expires within 15 minutes
and cannot refresh or extend the session.

Existing records without metadata use their stored duration to retain their
current lifetime; already extended legacy records are not shortened because the
original choice cannot be recovered. New records always carry explicit metadata.
Worker cache keys and eviction still use only the token, and cache hits never
extend backend expiry.

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

Requests under `/api/auth/` and `/api/rendro/` skip the lookup; Convex authorizes those calls itself. Retired `/api/sync/` requests also skip it and return 410. Ticketed viewer assets (`…/docs/view/:ticket/files/*`) also skip this redundant Worker lookup, even if cookies accompany the request: their ticket is decrypted and its session/membership/project access is freshly revalidated by Convex on every request. Session-token cookies and legacy `dont_remember` markers are forwarded for Worker session and viewer authorization reads; Convex replaces the marker with the server-side session choice; unused `session_data` cookies (including secure/chunked variants) cannot poison these reads.

HTTP `/get-session` reads use atomic fixed 60-second windows in the Better Auth component's existing rate-limit table. The primary limit is 600 reads per window, keyed by `session-read:` plus SHA-256 of the decoded token, **only after verifying the exact configured session-token cookie's HMAC and finding its active persisted session**. Unknown, expired, unsigned, or non-session values (including renamed signed OAuth-state cookies) share a 120-read verified-IP fallback. Raw tokens and client-supplied identifiers are never stored as rate-limit keys; valid sessions retain their bucket across IP changes and alternate cookie encodings. A separate 6,000-read verified-IP backstop runs before session resolution, providing capacity for ten sessions at the full 600-read allowance (many more at cached browsing rates). Direct unverified callers share `no-trusted-ip`. Each bucket's start time stays fixed during the window; accepted and rejected traffic cannot delay replenishment, and `Retry-After` reports time until reset. Better Auth's inactivity-based limiter is disabled for this endpoint and the selected organization GETs described below; credential/reset/verification limits and exact-path verifier exemptions are unchanged.

Measured with the actual Worker viewer routes and Better Auth handler (`tests/private-viewer-assets.test.ts`), a cold shell → tree → canonical content → renewal chain previously issued `[1, 1, 1, 1]` HTTP session reads; it now issues `[1, 0, 0, 0]`, and a warm chain issues zero. Ordinary navigation without renewal is 3 → 1 cold / 0 warm. The four downstream authorization reads remain fresh: total persisted resolutions for the four-route chain drop from 8 to 5 cold / 4 warm, excluding additional ticket assets (one fresh authorization each). The existing #43 request-local adapter wrapper already removes the duplicate limiter/endpoint resolution; its one-resolution-per-HTTP-read regression remains in place. Coalescing removes simultaneous cold-miss fan-out as well as sequential repeated reads.

The 600/minute allowance leaves 3× headroom even for **uncached** browsing at the round-4 1.2-second cadence: 50 navigations × (3 session reads + a pessimistic renewal on every navigation) = 200 reads/minute per session. This accommodates cache churn/multiple isolates and direct browser auth reads without weakening the 120/minute unverified-IP limit or credential endpoint limits. The local simulated regression (`tests/session-cache-browsing.test.ts`) uses real Convex HTTP actions, the production Better Auth adapter and fixed-window mutations backed by `convex-test`, two distinct owner/member sessions on one IP, and eight document paths. In ten simulated minutes, 182 navigations produce 62 HTTP session reads versus 728 uncached; the stricter 1,000-navigation run (1.2-second cadence for both users, renewal every navigation) produces 78 versus 4,000. All 728 / 4,000 fresh downstream authorizations succeed, with zero 503/429. These are deterministic local simulations with storage substitutes, not deployed Convex contention/load benchmarks.

The limiter resolves the signed token once, normalizes the Convex adapter's numeric `expiresAt` (also accepting Date/ISO values, failing closed on invalid values), and replaces only the current endpoint context's adapter reference with a wrapper that returns that result, including null, to Better Auth's unconditional `findSession` call. The shared adapter remains untouched; later requests and other tokens resolve afresh. Better Auth still owns expiry deletion and refresh writes.

A component cron runs every five minutes, paging 100 rows at a time through the `lastRequest` index at a fixed expired-window cutoff. It deletes only the three `session-read` and three `organization-read` namespaces and schedules continuation pages, preserving all built-in credential/reset/verification buckets, including stale ones. The scan also cleans existing custom rows without a data migration; schema regeneration targets `schema.generated.ts`, keeping the custom index in `schema.ts`.

Session lookup infrastructure failures return retryable 503 responses, with one bounded retry of the lookup GET only. Viewer downstream deployment/session-authorization reads likewise distinguish authoritative denial/absence (404) from 429, 5xx, network errors, a five-second timeout including body reads, and malformed responses (503 with `Retry-After`, styled retry HTML or JSON). Failures never replay protected writes or discard the session cookie.

The shared viewer backend reader reserves its `null` result for HTTP denials. Successful management-access, publication/share resolver and legacy RPC responses must be JSON objects, with required fields validated by the caller. A 200 response containing `null`, a primitive, an array or invalid required fields is retryable unavailability, not a missing resource. A valid legacy RPC envelope may still contain `value: null` for an absent mapping or a completed mutation.

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

### Management form lifetime

A pending management write keeps its form dialog open: Cancel, Close, backdrop,
and Escape cannot dismiss it until the request settles. Enhanced navigation is
also blocked. Success and failure release the submit control before the dialog
is reused; page-scope disposal releases any remaining busy controls and aborts
requests, and inactive controllers cannot apply late results. Organization and
first-project creation, plus invitation acceptance/decline, keep controls disabled
and retain a logical submission guard after success until a fresh form is initialized.
A delayed destination document cannot allow duplicate writes; denial restores retry.
Success clears `aria-busy` immediately and appends a polite completion status and
a real Continue link to the saved destination before attempting navigation.
The completed guard and link stay in the document after Stop, visibility changes,
and bfcache restoration, so recovery navigates without repeating the mutation.
Restoration is browser-dependent and is not required for recovery from a committed
500 response: organization page render failures replace the completed document
with a styled error page whose Try again link retries the destination (including
its query string) with a GET, without replaying the successful mutation.

The People form and Add another person action each bind one handler
for the lifetime of the persistent dialog. Reloading the invitation list must not accumulate
listeners. Successful invitation rows are removed; partial failures retain only
failed rows for retry. An entirely successful batch releases Send invitations
and synchronously initializes one empty row before closing and refreshing the list.
List rendering never resets an initialized form, so reopening and editing while
a refresh is pending preserves the new draft.

The dialog audit for #133 covers project, team, publication and API-key creation,
the separate one-time-key reveal, and the shared destructive confirmation.
Their existing success resets and secret-confirmation gates remain intact.
Settings, organization creation, first-project/credential onboarding and
invitation responses are inline forms; document sharing is a toolbar action,
not a management dialog. Sharing already clears its pending guard in `finally`.
`tests/management-dialog-reuse-browser.test.ts` exercises these real controllers
in isolated Chromium with held success/denial responses, invitation-list refreshes,
and destination documents, repeated submission,
pending Cancel/Escape where a dialog exists, and scope teardown. This uses local
fixtures only; it does not send invitations or create credentials on a deployment.

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

### Organization deletion

Organizations deleted before this lifecycle change have no tombstone; the new checks do not retroactively revoke their surviving capabilities. The operator reported no such organizations in production at the pre-release check. To verify again, use a read-only, fully paginated inventory of distinct `organizationId` values in `projects`, `deployments`, `apiKeyCredentials`, `publications`, and `shareGrants`, compare them with the Better Auth component’s `organization._id` values and `organizationTombstones.organizationId`, and investigate every ID absent from both identity and tombstones. An empty tombstone table alone does not establish that there are no historical deletions. Reconcile any orphaned records before release; this change does not perform an automatic backfill.

Better Auth's owner-only organization deletion endpoint awaits `beforeDeleteOrganization` before deleting identity records. The hook runs one Convex transaction that permanently inserts an `organizationTombstones` row, revokes every API credential and share grant, removes every publication, clears project active pointers, and retires active/staging deployments into superseded/failed states. The transaction records one audit event and is idempotent. Application revocation must commit before identity deletion can start; failures reject deletion. If subsequent identity cleanup fails, the tombstone remains and access stays denied. Retry the auth deletion while owner membership remains. If identity cleanup already removed that membership, an operator must finish identity cleanup; never remove the tombstone to restore access.

The transaction accepts at most 1,000 combined credentials, publications, shares, projects, and deployments. Indexed reads check the complete bound before any write; larger organizations receive an error and retain their identity and access. Convex transaction size/time failures also abort deletion. Larger-scale metadata cleanup needs a separately designed bounded lifecycle; deletion never silently truncates revocation.

API-key identity/validation, session membership, project/deployment reads, publication/share resolution, and application writes all check the tombstone. Mutation-local checks serialize capability creation and deployment commit against deletion, including requests authorized before deletion began. Private viewer tickets already call the active-deployment endpoint on every asset request and renewal, so existing tickets also stop working immediately. Already-delivered bytes cannot be recalled.

R2 deletion remains asynchronous through the existing retention job: retired deployments become eligible under the failed/superseded age rules once capability references are removed/revoked. Metadata, comments, audit events and the permanent tombstone are retained. No R2 calls occur during auth deletion. The current management settings page exposes profile edits only, with no organization-delete control or deletion transition.

### API keys

| Property | Value |
|---|---|
| Format | `rnd_live_<keyId>_<secret>` (8-byte hex key ID, 32-byte hex secret). The `rnd_live_<keyId>` prefix is stored for display; the full key is shown once |
| Storage | SHA-256 hash of the full key |
| Scopes | `docs:read`, `docs:write`, `publications:read`, `publications:write` |
| Binding | One organization, optionally one project |
| Expiry | Optional; the UI offers 30 days, 90 days (default), 1 year, or never |
| Management | Owners and admins create, list, and revoke keys |

Validation is a read-only query that checks the organization tombstone, organization binding, optional project binding, required scope, and revocation on every request. Convex caches query results until the documents they read change, so the query never reads the clock: it returns the stored `expiresAt` and `lastUsedAt` (internal only, never exposed over HTTP) and the HTTP wrapper evaluates expiry against the real time on every request, treating an expired key exactly like an invalid one. Revocation, scope changes, and organization deletion change the read set, so all of them apply to the very next request. `lastUsedAt` is debounced usage telemetry: after a successful check, the credential is written only when the stored value is at least 60 seconds old (re-checked inside the write transaction), so parallel requests with one key do not contend on its row. The value can therefore lag real use by up to that window. A telemetry write failure is logged without request data and never denies an authorized request. The per-credential rate-limit debit in the HTTP wrapper remains a separate, authoritative mutation. `GET /api/rendro/credentials/validate` returns 200 with the principal for an accepted key, 401 for missing, malformed, expired, revoked, or insufficient keys, and 400 when organization or scope is missing. Unexpected backend failures remain sanitized server errors (502 through the Worker). The CLI uses `/api/rendro/deployments/check` for its preflight; that endpoint also permits member sessions and returns 403 when neither identity authorizes the request.

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

Team names are normalized by the `beforeCreateTeam`/`beforeUpdateTeam` organization hooks (`shared/team-names.ts`): the name is trimmed and an empty result is refused with the same fixed `BAD_REQUEST` shape used by organization deletion (`Team name is required.`). Better Auth creates a default team with every organization and refuses to delete the last one, so an organization always has at least one team and the Teams screen has no empty state. Invitation rows keep `status: "pending"` until accepted, revoked or replaced; expiry is judged in the browser against the server's `expiresAt` at render time (no Convex query reads the clock), and an expired invitation is labelled **Expired**, stays revocable and is not counted as pending.

The page scope (`createPageScope`, `src/routes/management-navigation.ts`) shares only in-flight plain GETs. A write discards that sharing when it starts and again when it settles, so a read issued after the write is never answered by one that began before it; team writes (`create-team`, `update-team`, `remove-team`, `add-team-member`, `remove-team-member`) additionally abort in-flight `team-members` roster reads. Cached endpoints go through the TanStack cache, whose `applyImpact` already removes (and so cancels) the affected queries at the same two points.

The application schema (`convex/schema.ts`) owns:

| Table | Purpose |
|---|---|
| `organizationTombstones` | Permanent deletion barrier shared by session and capability authorization |
| `projects` | Organization-scoped documentation products and active deployment pointer |
| `deployments` | Immutable manifest metadata, status, provenance, predecessor and staging lease |
| `deploymentPurges` | Small claim, retry lease and completion records indexed by deployment ID |
| `retentionProgress` | Durable cursor, status phase and fixed cutoff for the retention scan |
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
            ├── index/v1/
            │   ├── root.json
            │   ├── files/{n}.json
            │   └── tree/{n}.json
            └── files/
                ├── index.html
                ├── assets/app.css
                └── reference/api.html
```

`manifest.json` holds `{ version: 1, files: [{ path, sha256, size, contentType }] }`, sorted by path. `tree-index.json` holds `{ version: 1, files: [{ path, size }] }` and is not read by the viewers. Both are written by the Worker when the deployment starts, together with the path/directory index under `index/v1/` (see [Deployment index and metadata cache](#deployment-index-and-metadata-cache)). Each uploaded or copied object stores its SHA-256 as object metadata.

### Deployment index and metadata cache

Requests never download a whole manifest to answer a single-path or single-directory question (#90). Deployment start writes an immutable index next to the manifest (`src/deployment-index.ts`):

| Object | Contents |
|---|---|
| `index/v1/files/{n}.json` | `{ version: 1, files: [[path, sha256, size, contentType], …] }` |
| `index/v1/tree/{n}.json` | `{ version: 1, tree: [[directory, page, [[name, folder], …], more], …] }` |
| `index/v1/root.json` | `{ version: 1, manifestSha256, fileCount, salt, shards, firstDocument }`; written last |

- **Shards.** The shard count is the smallest power of two with at most 256 files per shard on average (`INDEX_SHARD_TARGET_FILES`), so it grows with the file count: 1 shard up to 256 files, 4 at the 1,000-file deployment limit, and 512 for a synthetic 100,000-file manifest. A path belongs to file shard `SHA-256(salt ‖ "f" ‖ path) mod shards`. A directory page belongs to tree shard `SHA-256(salt ‖ "t" ‖ directory ‖ page) mod shards`. The salt is 16 random bytes per deployment and is never served, so publisher-chosen paths cannot concentrate entries in one shard. Empty shards are written too. A deployment with one shard has no shard objects: the root carries its file and tree rows inline, so a small deployment's lookups read one object, as before. Start writes at most `1 + 2 × shards` index objects; at the file limit that is 9 puts, beside the manifest and tree index.
- **Directory pages.** Only HTML documents (manifest MIME essence `text/html`) and folders that contain one appear. A directory is `""` for the root or a canonical path ending in `/`. Children are folders first, then names by `localeCompare` with a code-point tie-break. Pages hold 200 children (`TREE_PAGE_SIZE`). `firstDocument` is the first HTML path in manifest order, the default selection when there is no `index.html`.
- **Write order and integrity.** Start writes the manifest, the tree index and every shard in parallel, then the root. A present root therefore implies a complete index. Index objects live under the deployment's immutable namespace. Only the Worker writes them, upload keys are confined to `files/`, and retention deletes them with the rest of the deployment prefix. Readers validate every row as strictly as the manifest: canonical paths of at most 1,024 characters, hexadecimal hashes, safe sizes, bounded MIME types, single-segment child names, canonical directories, unique keys. Lookups compare exact canonical paths and never build storage keys from index contents.
- **Fallback.** A missing or invalid root (every deployment started before this change, or a manifest key that is not a deployment key) means the deployment is served from its `manifest.json`, parsed once per isolate. A missing or damaged shard falls back to the manifest for that lookup. Staging uploads use the strict new-deployment manifest parser; viewers use the lenient stored-manifest parser, which accepts deployments that predate current limits. No backfill is needed.
- **Per-isolate cache.** `deploymentMetadataCache` (`src/immutable-cache.ts`) is a least-recently-used map of parsed immutable objects. Keys are the deployment's manifest key plus the object name; shard keys also include the root's manifest SHA-256. It is bounded at about 4 MiB of source JSON; parsed values measure about 1.6 times their source size in V8, so a full cache holds roughly 7 MiB of the isolate's 128 MB. An entry above 2 MiB is used once but not retained. Concurrent misses share one storage read. Failed reads, missing manifests and damaged shards are not retained; the absence of an index root is retained because an index is never added after start returns. The cache holds only immutable bytes. Session, membership, publication, share-grant and staging-lease decisions are still made freshly by Convex on every request, before any cached metadata is consulted. Deployment IDs are never reused, so an entry cannot become stale.

Costs for synthetic manifests (`tests/deployment-index.test.ts`), counted as storage reads and bytes on a cold isolate:

| Files | Asset lookup | Tree root page | Deep link (3 directory pages) | Previously, asset / full tree |
|---|---|---|---|---|
| 10 | 1 read, 1.7 KB | 1 read, 1.7 KB | 1 read, 1.7 KB | 1 read, 1.6 KB / 1 request, 1.6 KB |
| 1,000 | 2 reads, 31 KB | 2 reads, 4.9 KB | 4 reads, 14 KB | 1 read, 156 KB / 5 requests, 778 KB |
| 100,000 | 2 reads, 24 KB | 2 reads, 4.9 KB | 4 reads, 16 KB | 1 read, 15.6 MB / 450 requests, 7.0 GB |

A 1,000-file cold push with every upload on a cold isolate reads 30 MB of index metadata, compared with 156 MB of manifests before. Within one warm isolate the whole push reads the root and four shards once (119 KB).

**Rollout.** This is a Worker-only change; Convex, the CLI and the request/response shapes of existing routes are unchanged. The new Worker reads an index when present and otherwise the manifest. Old Workers ignore `index/v1/`. Deployments started by an old Worker during rollout have no index and are served from their manifests. Rolling back leaves harmless extra objects that retention deletes. Directory pages are an additive `dir` query on the existing tree routes; requests without it keep the `{ documents, cursor }` shape for tree clients that predate directory pages (`lazy-tree.js` before v41, for example a tab opened before the deploy), served from the cached manifest. The v41 tree client is served by the same Worker version that answers its `dir` requests. Only a page loaded from the new Worker that then talks to a rolled-back Worker sees the old shape, which it rejects as a retryable "Failed to load documents" until the reader reloads. Deploy order: Worker only; there is no Convex or CLI change to order against.

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
  ├─ 9. Worker-implemented API routes (deployment/publication routes forward Authorization)
  │   ├─ /api/rendro/deployments/check|start|fail, /:id/files/*, /:id/copy, /:id/commit
  │   ├─ /api/rendro/publications (GET, POST), /api/rendro/publications/remove
  │   ├─ POST /api/rendro/shares (session only; discovers and attests assets)
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

Public routes and static assets run before the session middleware so they never trigger a session lookup. Their safety comes from record and capability validation, not route position. Anonymous publication/share resolution also consumes the verified-IP budget: modern resolvers enforce it in Convex, while legacy routes run admission middleware before resolution. Between steps 7 and 8, shared write admission checks the request policy and body admission bounds bytes before any JSON/form parser; authorized binary uploads use the independent exact-size reader.

### Response security headers

Every registered Convex HTTP action passes through `convex/httpErrors.ts`, which
sets `Cache-Control: private, no-store` after both successful handling and failure
mapping. This includes authenticated metadata, one-time API keys/share secrets,
resolver DTOs, admission failures, and malformed input. `shared/http-cache.ts`
owns the sole API exception: an exact GET `/api/auth/convex/jwks` returning 200
without `Set-Cookie` receives `public, max-age=300, must-revalidate`. New actions
inherit the private default. The generic Worker proxy preserves/enforces this
policy, including sanitized upstream failures; the outer Hono middleware applies
it to every `/api` response, including dedicated handlers, local denials and errors.
Other Worker responses without an explicit cache policy also default to private/no-store.

Modern and legacy shares, private viewers, reset/verification pages and invitation
pages receive `private, no-store` and `Referrer-Policy: no-referrer`, including
errors and unmatched paths within those route families. Successful public
publication documents/tree/sitemaps and explicitly cached static assets keep their
existing policies. Resolver metadata remains private even for public publications.
The registration-derived cache matrices exercise direct Convex actions and Worker
routes; proxy tests cover cookie rewriting and sanitized failures. A simulated
intermediary checks that responses cannot be reused across users or after denial.
The share-creation matrix uses the shared storage-proof fixture and real Convex
insertion, checking persisted grants and private responses for invalid attestations.

Request/error logs in Node and the Worker record Hono route templates, never raw
paths, query strings, or URL suffixes (including unmatched wildcard requests).
`src/logger.ts` exposes a small logging facade that applies the shared recursive
sanitizer in `src/log-redaction.ts` before delegating to Pino. Child bindings are
sanitized when captured and merged into each sanitized record. This policy runs
in both Node and the Worker, where bundling selects `pino/browser.js` and ignores
Pino's top-level redaction/hooks/formatters options. Header,
body, URL, query, stack and cause fields are redacted; exceptions retain only fixed
categories. Log message text must be a static application-authored string. Storage
and proxy catch blocks log fixed categories, without exception objects or storage
keys. Better Auth diagnostics emit only a fixed category, without library messages
or exception arguments. Registration-derived tests capture actual Pino output with synthetic
capabilities, alternate encodings, malformed paths, and errors. A separate esbuild
regression uses Wrangler's Worker conditions/browser resolution, verifies that
`pino/browser.js` was bundled, and checks the same credential/error/child fixtures
against Node output. Cloudflare raw
invocation logs remain disabled because they include request URLs.

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

Trusted HTML policies also use `object-src 'none'`, `base-uri 'self'`, and `form-action 'self' https://accounts.google.com`. The sign-in UI calls the same-origin Better Auth proxy and navigates to Google's returned OAuth URL; this policy does not restrict top-level navigation. `connect-src` permits self, the exact configured `CONVEX_URL` and `CONVEX_SITE_URL` HTTP(S) origins, and the corresponding WS(S) origin for `CONVEX_URL`. Local Convex HTTP/WS URLs work without production-wide wildcard allowances. Fonts are self-hosted: `style-src` has no third-party origin and `font-src` is exactly `'self'`; images allow self, data URLs and `lh3.googleusercontent.com`. Tailwind's `cdn.tailwindcss.com` script is permitted only on viewer/publication shells.

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

The Worker never opens a WebSocket to Convex. It calls Convex HTTP actions at `CONVEX_SITE_URL` for auth and `/api/rendro/*`. The legacy `legacy-access.ts` and `soft-delete.ts` modules call the Convex query/mutation HTTP API at `CONVEX_URL` with `CONVEX_INTERNAL_SECRET`, through `src/convex-internal.ts`:

```typescript
POST ${CONVEX_URL}/api/query     Body: { "path": "module:function", "args": [{ ... }] }
POST ${CONVEX_URL}/api/mutation  Body: { "path": "module:function", "args": [{ ... }] }
```

If `CONVEX_SITE_URL` is unset, `src/config.ts` derives it from `CONVEX_URL` (`.cloud` → `.site`, local port 3210 → 3211).

---

## Deployment and Publication API

### Request and deployment resource limits

`src/bounded-body.ts` counts streamed request bytes before JSON/form parsing. Both
Worker proxies/routes and every registered Convex HTTP action enforce **64 KiB**,
including Better Auth and operator actions. Worker deployment start allows
**2 MiB** for the manifest envelope; its compact Convex metadata request retains
the 64 KiB limit. Excessive or malformed Content-Length is rejected before a read;
missing and understated lengths still encounter the actual byte cap. Overflow
cancels the stream and returns HTTP **413 JSON**. Body admission does not replace
same-origin/media-type checks, credential verification, or storage attestations.

New deployments have these shared Worker/CLI limits:

| Resource | Maximum |
|---|---|
| Files | 1,000 |
| Individual file | 8 MiB (8,388,608 bytes) |
| Sum of all file sizes | 128 MiB (134,217,728 bytes) |
| Path string | 1,024 UTF-16 code units before normalization |
| Content-Type string | 128 UTF-16 code units |
| Worker start request, including manifest/provenance | 2 MiB |

Sizes and aggregate counts must be non-negative safe integers. Convex independently
checks the file/byte totals on deployment creation; the Worker validates every
manifest entry before hashing/storage. Existing hashes, provenance caps, staging
leases, exact object-set verification and predecessor checks remain authoritative.
The CLI checks all source metadata before reading/hashing file contents or making
network requests, then checks actual sizes/MIME and serialized manifest size before
starting. Limit errors name the relevant maximum. Split larger documentation sets
into projects or reduce generated assets before pushing.

Commit normally makes **4 external requests** at the maximum: staging authorization,
manifest GET, one S3 LIST (1,000 keys), and the attested Convex commit. Listings are
additionally bounded to **8 pages and 1,000 keys**, failing closed without activation
on overflow; short or repeated continuation pages cannot loop indefinitely. Sorting,
path comparisons and manifest hashing therefore operate on bounded inputs. With
three attempts for each of the nine possible S3 reads plus two Convex calls, the
worst configured commit budget is **29 external requests**, leaving room below
Workers' 50-request Free-plan subrequest ceiling. Cloudflare's Paid default is
10,000; both plans have 128 MB memory. These are subrequest budgets, not a promise
that SDK/crypto work fits the Free plan's 10 ms CPU allowance; production should
use a paid Worker CPU budget. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/)

An upload cannot exceed the independent 8 MiB server cap, even if its manifest
claims more. Its exact-size reader preallocates one bounded buffer and copies each
chunk directly into it; hashing uses that buffer without an explicit full-file
copy. Checksums are verified before storage dispatch. Concurrent requests still
have SDK/runtime overhead; the size cap is not an isolate-wide reservation system.

### Actor write and anonymous read budgets

Convex's existing `@convex-dev/rate-limiter` component owns the new transactional
creation quotas. Each successful creation consumes both an authenticated-user
bucket (across all organizations) and its verified organization's bucket. No
client-supplied actor ID is accepted by public endpoints. Organization capacity and
refill are ten times the per-user values below; unrelated actors/tenants have no
global shared write bucket.

| Resource | User capacity | User refill |
|---|---|---|
| Comment threads and replies, combined (project and legacy) | 30 | 30/minute |
| Share grants | 20 | 20/minute |
| Projects | 20 | 20/hour |
| API keys | 20 | 20/hour |

Limiter debits and inserts share the same Convex mutation transaction. Failed
writes roll back the debits; an organization denial also rolls back the actor
debit. Comment operation deduplication precedes charging, so a confirmed write
retried with the same operation ID remains idempotent. Revocation/deletion remain
available when creation is exhausted. HTTP denials return **429 + Retry-After**
and a clear retry message; direct comment RPCs return the component's structured
`RateLimited` application error. Management dialogs keep their existing draft and
pending-state recovery, and never automatically replay a denied write.

Every `ShareAssetError` 400 from `POST /api/rendro/shares` carries a stable machine
`code` and a `reason`: `share_limit` (work cap, asset count/bytes, 8 MiB parse
limit, tag/attribute limits, unsupported encoding), `share_busy` (the CPU
deadline, which slow storage can trip and a retry may clear) and
`share_unavailable` (missing document or stylesheet). The viewer chooses its
wording from the code (and a known `reason`), never from server text, and
offers Retry only for `share_busy`, HTTP 429 and unrecognized failures. Older
Workers that returned only `document too complex to share` are still treated as
a limit. A persistent, dismissible notice follows the toolbar in DOM order, with
a separate always-present polite live region that is written once per notice and
once when a delay ends; the visible countdown is aria-hidden. Escape dismisses
it; a document change (`rendro:document-change`, fired when the shell's `RENDRO_CURRENT_DOC` changes, which the lazy tree assigns on every navigation) clears
every notice except the account-wide quota countdown, and a failure arriving
after the reader moved to another document is dropped.
`Retry-After` is parsed by `shared/retry-after.ts` (digits-only seconds or an HTTP
date, values above 2^31-1 ms capped rather than dropped); the inline page scripts
embed its browser-safe twin, and `viewer-backend.ts` uses the typed version. The
parsed delay gates both retry controls until its deadline; missing/malformed delays
show quota guidance without inventing a countdown.
Success retains the existing 1.8-second toolbar copy feedback.

Comment error mapping recognizes only Convex `RateLimited` envelopes named
`comments` or `comments:organization` (the per-user and per-organization buckets)
with a finite positive millisecond delay (at most 2,147,483,647). The parent sends
that validated delay alongside the sanitized message and definitive rejection;
the iframe releases the rejected operation identity so the retained draft can be
edited. Unknown outcomes still retain the original identity for safe retry.
The widget shares a cooldown across thread/reply controls, including newly rendered
controls, preserves editable drafts, and shows a persistent dismissible countdown
whose reason is announced through a persistent live region once at the start and
once at the end. Dismissing returns focus to the draft, and Enter during a
dismissed cooldown re-shows the notice. Definitive rejection remains an explicit
list of public error codes plus a validated quota.
Expiry only re-enables controls; it never submits. Identity changes clear the
notice/timer. The optional response field is backward compatible with protocol v2.

Anonymous publication/share resolutions share **600 requests/minute with a 1,200
burst per verified ingress IP**, before resolver queries or storage reads. Modern
Convex resolver actions enforce this even when called directly. Legacy Worker
routes first call `/api/rendro/admission/public`, which grants no content access;
legacy mapping, publication, deletion and signature checks still follow. The
Worker forwards signed IP/method/path/query/time proofs, never arbitrary forwarding
headers. Direct callers without a valid proof share **60/minute, burst 120**;
changing slugs, tokens or forged IP headers cannot split this fallback allowance.
Public Worker routes preserve 429 and Retry-After and use private/no-store on
failures. Independent verified IPs retain their budgets. This IP policy includes
all readers behind the same NAT; it is separate from authenticated write quotas
and the existing API-key/session/organization-read limiters. Both anonymous
budgets use ten component shards, splitting the total capacity/refill rather than
multiplying it. Two-choice selection can reject near exhaustion before all tokens
are spent; independent shards reduce contention for shared NATs and direct callers.

Anonymous buckets (including nonexistent URL attempts) and actor/organization
write buckets have an indexed `admissionBuckets` expiry registry. Expiry rounds up
to the end of the next hour, allowing at least one hour of inactivity: all these
token buckets refill fully within that interval, and none use reservations. The
registry refresh and limiter debit share one mutation transaction, including
anonymous denials; failed writes roll both back. Within an hour, admissions only
read the registry, avoiding a shared write hotspot across anonymous shards. Cleanup
and reuse conflict on the registry read/write, so cleanup cannot erase an active
allowance. An hourly cron deletes nine expired registry entries and their at-most
ten component shards per entry (at most 99 row deletions), scheduling an immediate
continuation when the batch fills. The continuation adds one scheduled row, keeping
each transaction at or below 100 writes. No table scan or per-request job is needed.

Legacy tree deletion lookups already use batches of at most 100 keys per RPC;
this implementation preserves that behavior.

Release in the standard **Worker → Convex** order, then distribute the CLI. The
new Worker always sends the signed verified-IP proof; the old Convex ignores it.
During this interval only the new legacy admission endpoint has a compatibility
exception: HTTP 404 with `Content-Type: text/plain; charset=utf-8` and exactly
`No matching routes found` proceeds to the existing
capability authorization checks. One percent of these responses log a fixed
warning without URLs, tokens or IPs. Ordinary application 404s, malformed success,
transport errors and other failures remain closed (503); quota denials remain 429.
Admission is defense-in-depth rate limiting and this exception grants no authority.
Deploy Convex next to activate the endpoint, sharded limits, expiry registry and
cleanup cron. No data migration is needed; regenerate Convex bindings from main
after merge. Verify both modern and legacy reads after each release.

Rollback boundaries: before Convex is deployed, the Worker can be rolled back
independently. After Convex is deployed, roll back Convex's admission changes first,
then the Worker: an old Worker with new Convex would put modern readers into the
shared unverified bucket and map quota responses to 503. Keeping the new Worker
while reverting Convex is supported by the exact missing-route exception. Preserve
the registry/component state on rollback; do not reset active quotas. Existing
committed content remains readable; oversized historical manifests cannot be used
to resume staging writes under the new limits.

**Follow-up / TODO (#86):** remove the legacy missing-route compatibility branch
and sampled warning after both sides are deployed and the rollback window closes.
After removal, a Convex rollback must retain the admission endpoint, or first
restore the compatibility Worker.

### API-key HTTP rate limits

Convex is authoritative: `convex/apiKeyHttp.ts` wraps credential validation, every deployment action (start, active, staging, commit, fail, list), and publication create/list/remove. Limiting runs before body parsing or business logic, so malformed requests also count. A read-only hash lookup (`verifiedIdInternal`) returns the credential ID and stored `expiresAt` for a non-revoked key in a live organization, and the wrapper treats a key at or past that deadline as unverified (failed-IP budget); a shared token bucket uses the credential's database ID, never a raw key or caller-selected tenant/scope. Scope, project, organization, expiry and revocation authorization still run for each operation. Failed operations consume capacity too; cookie-only session routes retain their session authorization path.

The official `@convex-dev/rate-limiter` component provides persisted, transactional token buckets across Convex instances. There was no application-level limiter to reuse; Better Auth's database limiter covers only `/api/auth/*`. Version 0.3.2 is pinned because it supports the existing Convex 1.42 dependency, avoiding an unrelated backend upgrade. The component is registered in `convex/convex.config.ts`; **Convex deploy required** when releasing this change.

- **Verified credential:** refill 6,000 requests/minute (100/second), capacity 12,000. API-key actions share this credential budget across projects and IPs, except failure cleanup. Following the component's contention guidance, 50 shards split the total rate and capacity (2 requests/second and 240 burst tokens each); two-choice shard selection may reject near exhaustion before every token is spent.
- **Failure cleanup (`/deployments/fail`):** a separate per-credential bucket refills 60 requests/minute with capacity 20, so exhausted upload budgets cannot block retention cleanup. Scope and tenant checks still apply.
- **Invalid, expired, revoked, malformed or missing key on key-required routes:** refill 120 requests/minute (2/second), capacity 240 per verified IP. Invalid Authorization on session-capable routes also counts. IPs come only from #29's method/path/query-bound signed ingress metadata, verified using `CONVEX_INTERNAL_SECRET`. Deployment and publication Worker handlers sign their rewritten backend target/method, including staging reads for PUT uploads. Direct callers, absent secrets and invalid/stale signatures share one `unverified` bucket; raw forwarding headers cannot select a bucket. Valid credentials use their own budgets even when their IP's failed-attempt budget is exhausted. A verified key with insufficient scope/tenant access still consumes its credential budget. Each failed-key attempt atomically updates an expiry registry with its component debit. An hourly cron resets buckets inactive for at least an hour (well beyond the two-minute full refill), deleting registry and component rows together in batches of 100 with scheduled continuations. Concurrent reuse conflicts with cleanup in the same transaction, preserving active budgets.

Request accounting from `cli/src/index.ts` and `src/routes/deployments.ts`: with C changed files and U reused files, a successful push makes **C + ceil(U / 16) + 3 Worker requests**, and **2C + 2 ceil(U / 16) + 4 Convex HTTP actions**. The fixed cost is active check, start, staging check at commit, and commit; each changed file and each 16-file copy batch adds an initial staging authorization plus a fresh authorization immediately before storage dispatch. An upload still receiving its body renews at most once every ten minutes, with a two-hour total transfer deadline; renewal failures cancel the body read. These additional renewal actions count against the same credential budget. Failure cleanup adds one action; publication creation adds two (deployment read + publication write). Default upload concurrency is eight. At the 1,000-file deployment limit, a cold push costs 2,004 tokens within the 12,000-token burst budget; a 50-changed/950-reused push costs 224 tokens. The CLI honors bounded 429 retry delays. Sustained requests replenish at 100/second. These are application request limits, not file-size or storage-work quotas.

Exhaustion returns `429`, `Retry-After` rounded up to whole seconds (minimum one), and `{ "error": "Rate limit exceeded", "code": "rate_limited" }`. Worker proxies preserve the status/body/header. This is an explicit error class in `httpErrors.ts`; unexpected limiter/backend faults remain sanitized 500s (502 through the Worker). Rate-limit responses do not log secrets, keys, request bodies or IPs.

The CLI reports `429 Rate limited. Retry after Ns.` It retries only 429 responses for reads, same-byte file PUTs, copies of immutable manifest files to the same staging keys, and idempotent failure cleanup. Up to three retries use exponential delays (1, 2, 4 seconds), honor the greater `Retry-After` seconds/date value, and add 0–249ms jitter. A wait over 60 seconds stops with the rate-limit message. If failure cleanup remains rejected, the CLI exits non-zero and reports both the original deployment error and the cleanup failure, identifying the deployment that may remain staging. Start, commit and publication mutations are not automatically replayed; transport errors and 5xx responses are not retried. Start creates a new deployment and commit changes the active pointer, so their outcomes must not be guessed after an ambiguous response.

### Time never decides access in a query

Convex caches a query result until a document it read changes; elapsed time does not invalidate it. A query that compares `Date.now()` with a deadline can keep returning a stale "allowed" after the deadline passes (revocation is unaffected because it changes a document). Queries and `internalQuery` handlers therefore never read the clock (`Date.now()`, argument-less `new Date()`, `performance.now()`, `Temporal`), directly or through helpers. They return the stored deadline and the calling action/httpAction compares it with `Date.now()`, once, and denies: `resolveShareGrant` for share expiry, `limitedAction` (rate-limit identity) and `validateApiCredential` (authorization, #91) for API-key expiry. Mutations may read the clock freely.

`tests/query-clock-purity.test.ts` enforces this. A TypeScript-AST analysis (`tests/helpers/convex-query-clock.ts`) starts from every query registration in `convex/**` (including factories that wrap `queryGeneric`), follows each referenced top-level declaration through relative imports, re-exports and namespace imports, and fails on any reachable clock read. The set of queries it finds must equal the set of exports Convex registers at runtime (`isQuery`), so a new registration shape cannot slip past it. Justified non-access uses are listed with a reason in the test's `allowedClockReads` map; an entry that no query reaches fails, so the list can only shrink. Code in `node_modules` (Better Auth, the Convex adapters) is outside the analysis; the Convex platform validates the auth token itself.

### Immutable deployment protocol

The CLI drives these Worker routes (`src/routes/deployments.ts`). Identity (`organizationId`, `projectId`) travels in the JSON body for start/fail and in the query string for the other calls.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/api/rendro/deployments/check` | `docs:read` | Return the active deployment and its manifest |
| POST | `/api/rendro/deployments/start` | `docs:write` | Validate the manifest and checksum, create a new staging deployment, write `manifest.json`, `tree-index.json` and the path/directory index |
| POST | `/api/rendro/deployments/:id/copy` | `docs:write` | Copy unchanged files from the previous active deployment |
| PUT | `/api/rendro/deployments/:id/files/*` | `docs:write` | Upload one changed file |
| POST | `/api/rendro/deployments/:id/commit` | `docs:write` | Verify the object listing and activate the deployment |
| POST | `/api/rendro/deployments/fail` | `docs:write` | Mark a staging deployment failed |

Sequence used by `rendro push` (`cli/src/index.ts`):

1. Filter the source folder before reading file contents, compute SHA-256 and size per included file, build a sorted manifest, and hash its JSON.
2. `check` returns the active manifest. Files with matching `(path, sha256, size)` are unchanged; the rest are changed.
3. `start` re-parses the manifest, rejects unsorted/duplicate/unsafe paths and checksum mismatches, then asks Convex to insert a `staging` deployment whose `previousDeploymentId` is the current active deployment. Every start creates a new deployment; staging deployments are never reused. If writing the manifest or tree index fails, the Worker marks the deployment failed.
4. `copy` accepts at most 16 paths per request (`MAX_REUSED_FILES_PER_REQUEST` in `shared/deployment-limits.ts`, chosen to stay under the Workers subrequest limit). For each path it requires a manifest entry (looked up in the index: at most the root and four shards at the file limit, instead of the whole manifest), then `HEAD`s the previous deployment's object and requires matching size and stored SHA-256 before copying.
5. `PUT files/*` accepts only paths in the manifest, found by reading the index root and one shard (cached per isolate). The body must match the manifest size (oversized bodies are cancelled) and SHA-256. The CLI uploads changed files in batches of `--concurrency` (default 8).
6. `commit` lists the deployment's `files/` prefix and requires it to equal the manifest's paths exactly (409 otherwise). The Worker then sends a short-lived storage attestation (see below). Convex verifies it against the stored deployment inside the commit mutation and requires the deployment to still be `staging` and the project's active deployment to still equal `previousDeploymentId` ("Active deployment changed; rebase and retry"). It marks the previous deployment `superseded`, the new one `active`, and moves the project pointer in one mutation.
7. If copy, upload, or commit throws, the CLI calls `fail` with the error message and exits non-zero.

Deployment statuses: `staging` → `active` → `superseded`, or `staging` → `failed`. Retention creates a separate `deploymentPurges` claim before deleting bytes, then records `purgedAt` on that claim after verified deletion. Both claim states and legacy deployment purge fields block new pins or shares.

A staging deployment starts with a one-hour lease (`stagingExpiresAt`). Each authorized staging read before upload/copy/commit renews it transactionally when ten minutes of the lease have elapsed, avoiding a write on every file. An expired lease cannot be renewed or committed; restart the push. Rows created before this field existed use `createdAt + one hour` without a backfill. Storage writes check their returned lease immediately before dispatch (including after slow body reads) and carry an abort signal bounded by the remaining lease and five minutes. Retention waits another 24 hours after lease expiry before claiming failed/abandoned staging storage, allowing in-flight writes to drain. Explicit failure preserves this drain deadline. Abandoned staging rows keep their original metadata; a separate `deploymentPurges` record makes them unavailable when claimed. Deploy the lease-aware Worker before enabling the new cleanup job; legacy upload workers do not enforce write deadlines.

Convex also serves `GET /api/rendro/deployments/active` and `GET /api/rendro/deployments` (latest 100) for sessions and `docs:read` keys, and `GET /api/rendro/deployments/staging` for the Worker.

### CLI source selection and encoding

`cli/src/source-files.ts` filters before hashing or uploading, with zero runtime
dependencies. The case-insensitive sensitive defaults at every depth are `.env`,
`.env.*`, `.envrc`, `.envrc.*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`,
`*.pem`, `*.key`, and `id_*`. `--include-sensitive` overrides only these filename
defaults. Dot-directories stay excluded by default, including under that flag; an
explicit ignore negation such as `!.environment/` permits ordinary dot-directories.
The case-insensitive directory names `.git`, `.ssh`, `.aws`, and `node_modules`
are always excluded, even under negation or sensitive opt-in. Symlinks/non-regular
files are never followed.
Skipped files/directories produce JSON-quoted relative-path `skipped` lines with
a reason; directory pruning avoids reading excluded contents.

The source-root `.rendroignore` is read once; errors other than absence abort
before network activity. It remains authoritative under `--include-sensitive`.
Ignore files themselves are never uploaded and nested ignore files are not read.
`cli/src/ignore.ts` implements trimmed lines, comments, `*`, `?`, whole-segment
`**`, root-relative slash patterns, directory-only trailing slashes, ordered `!`
negation, and escaped leading `#`/`!`. Other glob syntax is literal. Matching is
case-sensitive. Directory pruning follows gitignore's parent rule: a negated
child cannot resurrect an excluded parent. Negation can override default
dot-directory exclusion but never the protected directory set. Sensitive filename
defaults cannot be negated without the opt-in flag. See the [README subset and examples](../README.md#source-filtering).

`cli/src/content-type.ts` records extension-derived MIME essences without an
assumed charset. For recognized text types (including JSON/maps and SVG), only
UTF-8, UTF-16LE, and UTF-16BE BOMs add a charset. UTF-32 BOMs are not misidentified
as UTF-16. Bytes, hashes, and sizes are unchanged; no transcoding or heuristic
encoding detection occurs. Existing manifests with `charset=utf-8` remain valid
and are served as declared. A subsequent push records new metadata even when
`(path, sha256, size)` matches and the object is copied: project/publication
routes select the new manifest's type rather than copied object metadata. No
server migration is required. Old incorrectly labeled immutable deployments
remain unchanged; repush to correct metadata for a new deployment.

Unit tests cover the matcher and BOM boundaries; real-filesystem and CLI
subprocess tests cover filtering, opt-in, failures, source/bundle parity, exact
bytes and metadata, and copying from old manifests. The Chromium charset suite
feeds a real CLI subprocess's output to the real Worker delivery routes with
fixture identity/storage, verifying `café €` from Windows-1252 CSS for public,
private, and ticketed private files, including reused objects and existing UTF-8
manifests. Modern share routes also use manifest media types and preserve publisher bytes.

### Storage validation authority and rollout

Convex requires `x-rendro-storage-attestation` for deployment commit and publication creation, in addition to the existing credential/session authorization. An ordinary API key cannot replace this proof. The Worker creates it only after checking storage; caller-supplied proof headers are not forwarded by either route. The CLI and management request bodies do not change.

`shared/storage-attestation.ts` signs a canonical JSON tuple with HMAC-SHA256, using a key derived from `CONVEX_INTERNAL_SECRET` with the `rendro-storage-validation-key-v1` label. The tuple binds a version and operation purpose, organization, project, deployment, manifest key and SHA-256, file count, and millisecond timestamp. Publication proofs also bind the normalized path prefix, relative entry file, and tracking mode. Proofs expire after 60 seconds; future timestamps are rejected. Hosts are not signed, so proxy host rewriting is supported. Ingress-IP and resolver proofs cannot authorize these mutations. Keep Worker and Convex clocks synchronized and secrets identical.

Commit signs the hash and count of the manifest the Worker actually checked, after the stored file set matches it. Convex compares the proof to its own deployment metadata and retains tenant, scope, staging-state and predecessor checks. Publication validation uses an attestation rather than a duplicate per-deployment manifest summary: the Worker already reads immutable manifests, and this keeps existing deployments usable without a data migration. Convex resolves the selected deployment in the creation transaction and verifies the proof for that deployment and entry; a concurrent active-deployment change invalidates a tracked proof. Pinned proofs can select an available superseded deployment. Tracked publications continue following later active deployments, with manifest validation on each public read.

Release **Worker first, then Convex**, with matching secrets. The new Worker sends only an additional header, which old Convex ignores; it can continue using the existing request and response shapes. Once all Workers send attestations, release Convex enforcement. Reversing that order causes old Workers' commit/publication requests to fail closed. No CLI upgrade or schema migration is needed. Keep the attesting Worker when rolling back unrelated changes; rolling it back while Convex enforcement remains enabled interrupts these writes. Rolling back Convex enforcement restores the prior weaker validation boundary and should be avoided.

### Provenance privacy

The CLI and Convex deployment mutation sanitize Git remotes before capture/storage: known HTTP(S), SSH and Git URLs lose userinfo, query and fragment; scp-style remotes lose their user prefix. Authorities are percent-decoded before userinfo removal; encoded authority delimiters, nested encodings, control characters, invalid IPv6/ports, local/file paths (including Windows absolute and drive-relative paths) and unsupported/malformed remotes are omitted. Sanitized repository URLs longer than 2,048 characters are omitted. All other provenance strings are bounded (commit/checksum 128, ref and CI labels 256, local path label 512, CLI version 64 characters), with embedded URL credentials removed. Authorized deployment reads apply the same sanitation to historical rows while retaining repository location, commit/ref, dirty state and CI context. Direct Convex deployment start rejects digests other than exactly 64 lowercase hexadecimal characters and rejects provenance strings exceeding these caps before sanitization. Organization/project/actor identities are capped at 256 characters; manifest/tree keys are generated from those bounded identities, never accepted from the request. The staging authorization response contains only manifest/tree keys, the optional predecessor ID and lease expiry; it never includes provenance, including for historical rows.

### Publications

| Method | Path | Required access | Purpose |
|---|---|---|---|
| GET | `/api/rendro/publications` | Member, or `publications:read` | List publications |
| POST | `/api/rendro/publications` | Owner/admin, or `publications:write` + `docs:read` | Create a publication |
| POST | `/api/rendro/publications/remove` | Owner/admin, or `publications:write` | Remove a publication |
| GET | `/p/:slug` | Anonymous | Public read-only shell |
| GET | `/p/:slug/tree` | Anonymous | Directory pages relative to the publication prefix (`?dir=&cursor=`) |
| GET | `/p/:slug/files/*` | Anonymous | Manifest-validated sandboxed object |

Publication slugs are globally indexed. A publication maps one project path (`pathPrefix`, `entryFile`) to either the project's active deployment (`track_active`) or an explicit `pinned` deployment. Convex independently requires both `docs:read` and `publications:write` for publication creation using API keys; owner/admin sessions retain their existing same-origin admission and role checks. Before creating one, the Worker resolves the target deployment, rejects `staging` or `failed` deployments, and requires the entry file to be an HTML file in that deployment's manifest under the normalized prefix. Convex requires the corresponding storage attestation on direct and proxied creation alike. Uploading never makes content public. Public file/tree responses use `Cache-Control: public, max-age=0, must-revalidate`.

The anonymous `/api/rendro/publications/public` resolver returns only `{ publication: { slug, entryFile, title } }`. The share resolver returns only `{ grant: { documentPath, expiresAt }, project: { name } }`. Neither exposes stored records, provenance, actor/tenant/project/deployment IDs, token hashes or storage keys, even when called directly at Convex. The Worker signs its resolver GET with a dedicated HMAC-SHA256 proof using `CONVEX_INTERNAL_SECRET`, bound to a purpose prefix, method, canonical pathname plus search and timestamp (60-second validity). Scheme/host rewriting by proxies does not invalidate the proof; path and query changes do. Only this proof adds `deployment.manifestKey`, the share asset allowlist, and, for publications, `publication.pathPrefix`. Generic API proxy calls cannot obtain or forward that proof. Both resolver variants are `private, no-store` to prevent public/internal cache mixing. Internal Convex queries also return explicit minimal DTOs. Release the Worker update first, then the Convex update, with matching secrets. If upgrading an already signed resolver from full-URL proofs, coordinate the Worker and Convex update because the signature payload changes. The updated Worker can consume the old resolver shape during rollout; older Workers cannot consume the reduced anonymous response after Convex updates.

### Revocable private shares

`POST /api/rendro/shares` (any organization member) creates a 256-bit random token. `expiresInSeconds` must be between 60 seconds and 30 days; the document toolbar requests 7 days. Convex stores the token's SHA-256 hash, expiry, creator, document path, pinned deployment, and an explicit `assetPaths` allowlist. `/s/:token` resolves the hash on every request (the Worker keeps no share cache, and the resolver response is `private, no-store`), so expiry or revocation takes effect immediately. Revocation changes the grant document. Expiry is time, which never invalidates a cached Convex query, so `shareGrants.resolveInternal` returns the stored `expiresAt` without reading the clock and the `resolveShareGrant` httpAction denies at `expiresAt` with the same 404 "Share not found" as a missing token (see [Time never decides access in a query](#time-never-decides-access-in-a-query)). A new grant exposes its exact HTML document and only its allowlisted manifest assets, never the project tree or another HTML/XHTML document. Responses use `Cache-Control: private, no-store`. Owners and admins revoke grants with `POST /api/rendro/shares/revoke`.

The Worker authenticates a session-backed active-deployment read before reading storage. It requires a manifest `text/html` document and discovers literal resource references with parse5: images/srcset, stylesheet/icon/preload/modulepreload links, scripts, media/posters, object/embed, SVG image/use, and inline styles/style blocks. It honors the first HTML base URL, resolves paths relative to the document, removes query/fragment components, normalizes dot segments and decodes percent-encoded segments once. Only same-deployment manifest paths enter the list; `text/html` and `application/xhtml+xml` resources are excluded regardless of filename. The existing CSS tokenizer discovers URLs and imports from directly referenced stylesheets, resolving them relative to each stylesheet. Imported stylesheets are included but not crawled recursively. Navigation links and JavaScript-generated requests are not dependencies; a dynamic fetch must have an explicit preload reference to be shared. Absolute/protocol-relative URLs and bases are not inferred to belong to the deployment; publisher asset URLs should be document-relative to preserve the share route prefix.

Any same-deployment non-HTML file explicitly referenced by the shared document through these resource attributes becomes accessible to share recipients, including JSON, PDF, and dotfiles referenced through `link`/preload or other supported resource attributes. Treat those references as intentional disclosure; MIME types do not make referenced data private.

The security boundary of share scope (#82) is that share **recipients cannot reach files the shared document does not reference**. Asset discovery is a best-effort emulation of browser URL extraction. A discovery discrepancy can only allowlist files in the same deployment, which the document's author already controls and could reference directly. Discovery mismatches are therefore correctness/fidelity issues; any path a recipient can reach that was not derived from the document is a security bug. Extraction stays conservative: when unsure, omit rather than guess.

Discovery uses the HTML srcset parsing algorithm (ASCII whitespace, comma and descriptor rules) and CSS tokenization without Unicode whitespace trimming. It decodes source bytes with BOM precedence, then the manifest charset, then the HTML byte prescan (meta declarations or leading XML encoding declarations within the first 1024 bytes) or CSS `@charset`, then the referencing document's encoding for CSS, and finally UTF-8. The HTML byte prescan distinguishes absent and invalid charset labels, observes pragma requirements and first-attribute precedence, continues after invalid declarations, and maps UTF-16 meta labels to UTF-8 and x-user-defined to Windows-1252. Unsupported runtime decoders fail creation explicitly. DOM traversal is iterative, including wide documents below the byte limit.

Creation fails with an explicit error above **500 unique asset paths**, **57,330 bytes of serialized UTF-8 paths**, or **8 MiB of cumulative HTML/CSS source bytes**. The shared asset-byte cap is derived from the 65,536-byte HTTP body limit minus an 8,192-byte maximum serialized metadata object and 14 bytes for the added JSON member. The Worker enforces the metadata byte bound (including UTF-8 and JSON escaping), forwards only organization/project/document/expiry fields plus the discovered list, and returns `document references too many assets to share` on asset count/byte overflow before forwarding to Convex. The creation-through-Convex regression covers the exact cap and one byte over, and asserts the complete request fits even at maximum metadata size. HTML also has a linear preflight limit of **50,000 literal `<` tag markers** (including those in comments/text). The tokenizer rejects more than **128 attributes on one start/end tag** or **100,000 total attributes**, counting duplicate names, before parse5 performs attribute deduplication. Discovery uses one cumulative `WorkBudget` across stream buffering, encoding prescan/decoding, HTML tokenization/tree construction, iterative traversal, attributes, srcset, CSS, URL normalization and manifest lookups. Each loop charges work; linear native/library operations reserve input-sized work before entry. The allowance is **16 million work units** and **750 ms of synchronous elapsed time**, checked every 1,024 work units and at stage boundaries; asynchronous storage waits are excluded. These are ceilings, not promises that every document below the byte/path limits is accepted. Exhaustion throws `ShareAssetError("document too complex to share")`, returning a creation failure without a partial grant. The actual parser open-element and active-formatting stacks are limited to **512**; implicit nodes and templates count. Pinned parse5 stack scans and attribute deduplication therefore have fixed upper bounds. A linked-sibling tree adapter makes foster parenting/adoption insertion and removal constant-time, then materializes child arrays once. Attribute lookup, manifest membership, and reference deduplication use Maps/Sets; each unique allowed path is validated and UTF-8 encoded once with incremental serialized-size accounting. CSS is tokenized incrementally with input-sized work reserved up front (64 units per code unit), bounding even a single long token. Checking only the finished DOM would be too late. The guard uses parse5's own tokenizer states so quotes, raw text and malformed markup cannot bypass it. Exceeding any limit returns a controlled creation error without persisting a partial grant. Missing document/stylesheet objects also fail creation. The Worker replaces caller-supplied lists and signs a `share-assets` storage attestation binding the document, ordered asset list and exact deployment metadata. Convex authorizes the session independently and verifies the attestation against the current active deployment inside the insertion transaction; direct requests without proof and concurrent active-deployment changes fail closed. The public resolver omits the list; only the signed Worker DTO includes it.

Every file read requires a manifest entry before opening its object, and authorization uses the manifest MIME essence rather than the extension. **Legacy grants without `assetPaths`** retain only the exact document plus immediate-directory assets whose manifest type is `text/css`, `image/*`, or `font/*`; nested assets, scripts and other types are denied. An explicitly empty list is document-only. Existing links may therefore need recreation to restore referenced nested assets or scripts. Streamed text keeps the manifest's validated charset (or its absence), using the shared `assetHeaders` rule; publisher bytes are preserved (#138).

The optional schema field needs no backfill. Release the Worker before Convex enforcement with matching `CONVEX_INTERNAL_SECRET`; the interim Worker safely applies the legacy policy until Convex stores and returns lists. Keep the fixed delivery route during rollback. This change was checked with the offline Convex guard; the release orchestrator regenerates Convex artifacts from main after merge before deployment.

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
| POST | `/api/rendro/deployments/commit` | `docs:write` + Worker storage attestation (through *Worker* `/:id/commit`) |
| POST | `/api/rendro/deployments/fail` | `docs:write` (*Worker* front) |
| GET | `/api/rendro/deployments` | Member or `docs:read` |
| GET, POST | `/api/rendro/publications` | See Publications (*Worker* front) |
| POST | `/api/rendro/publications/remove` | See Publications (*Worker* front) |
| GET | `/api/rendro/publications/public` | Anonymous presentation DTO; signed Worker storage DTO for `/p/*` |
| GET, POST | `/api/rendro/shares` | Member; creation requires Worker storage attestation (*Worker* front) |
| POST | `/api/rendro/shares/revoke` | Owner/admin |
| GET | `/api/rendro/shares/public` | Anonymous presentation DTO; signed Worker storage DTO for `/s/*` |
| GET | `/api/rendro/retention/candidates` | `RETENTION_SECRET` bearer |
| POST | `/api/rendro/retention/purged` | `RETENTION_SECRET` bearer |
| POST | `/api/rendro/migration/project` | `MIGRATION_SECRET` bearer (*Worker* front) |

Organization, member, team, and invitation operations use Better Auth's organization plugin endpoints under `/api/auth/organization/*`.

Rendro narrows two of those endpoints in Convex (`convex/organizationPolicy.ts`), so the rules hold for direct Convex HTTP, the Worker proxy and server API calls alike:

- **Invitation lists are owner/admin only.** Invitations disclose invited addresses, roles and status. Better Auth's `list-invitations` and `get-full-organization` only require membership. A plugin after-hook checks the caller's member role again on every request, with a fresh lookup, against the organization whose data the endpoint actually returned (and, for the list, the organization requested or active). A member's `list-invitations` call returns 403 `YOU_ARE_NOT_ALLOWED_TO_LIST_INVITATIONS`. Their `get-full-organization` call still returns the organization, members and teams, but with `invitations: []`. Anything the hook cannot attribute to an owner or admin fails closed in the same way. Members need no invitation data. Their People and Overview pages already omit the pending-invitations section and never request the list. Recipients still read their own invitation through `get-invitation`. Outsiders and anonymous callers keep Better Auth's own 403/401.
- **Organization slugs are validated on write.** Create and update requests must match the forms' rule: 1–48 lowercase letters or digits, in groups joined by single hyphens (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). Otherwise Better Auth's organization hooks reject them with 400 `INVALID_ORGANIZATION_SLUG` and the message "Organization slug must contain lowercase letters, numbers, and hyphens". The forms display that message as they display other server errors. Role and membership checks run first. Existing organizations with nonconforming legacy slugs keep working: reads are unaffected, updates without a slug succeed, and resubmitting the stored slug unchanged is allowed. Only a new slug is validated. Slugs remain display fields and never grant access.

Both rules are Convex-only. The Worker proxies these endpoints unchanged, so Worker and Convex can deploy in either order and old and new versions interoperate.

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
| Legacy (operator-mapped org) | `/docs/:org/:path` (old `/files/:org/:path` redirects here) | `/legacy-view/:org/files/:path` | `/api/tree/:org` |

Legacy `/docs/:org` and nested document URLs require live membership in an explicitly mapped Better Auth organization. Signed-out requests redirect to sign-in with a return path. Missing or inaccessible organizations return the shared styled 404, regardless of the email domain; they never start v1 organization creation. New organizations use the v2 management flow at `/organizations` (the 404 links to `/organizations?choose=1` so existing members can also choose **New organization**).

The project and publication viewers share `renderScopedDocumentShell()` in `src/routes/app.ts`. The project shell resolves the active deployment through Convex with the session cookie, looks up `?doc=` or `index.html` in the deployment index (falling back to the first HTML file), and validates that the selection is an HTML manifest entry. Unknown paths return the shared 404 page.

`…/docs/tree?dir=<directory>&cursor=<page>` returns one directory page from the index: `{ children: [{ name, type: "file" | "folder" }], cursor }`, with at most 200 children. `dir` is `""` for the root or a canonical relative path ending in `/`; `cursor` is the next page number or `null`. A malformed directory or cursor returns 400 before storage is read, and an unknown directory returns an empty page. `/p/:slug/tree` serves the same pages, relative to the publication's path prefix, so it can never name a path outside the prefix. Without `dir`, both routes keep the previous `{ documents, cursor }` list of all HTML paths in pages of 200 for clients that predate directory pages. `…/docs/files/*` serves only manifest entries with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and either `sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'` (HTML) or `default-src 'none'` (other types) as the Content-Security-Policy. HTML responses get a small injected script for navigation messages, the shell shortcut, and the comment configuration; stored publisher bytes are never modified.

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

`src/routes/asset-headers.ts` supplies the response CSP, MIME, `nosniff`, and capability-scoped opaque-origin CORS headers. Every successful publisher-byte response uses it, including direct navigation and every media type:

- Modern publication `/p/:slug/files/*` and share `/s/:token/files/*`.
- Private project `…/docs/files/*` and `…/docs/view/:ticket/files/*`.
- Legacy private `/legacy-view/:org/files/*` and `/legacy-view/:org/view/:ticket/files/*`.
- Legacy publication `/public/:org/:slug/files/*` and signed `/share/:token`, which continue to accept HTML documents only and force an HTML response type.

The old `/files/*` endpoint only redirects to the trusted viewer. Legacy `routes/publications.ts` returns structured metadata, not stored document bodies; the public sitemap builds escaped XML. The route inventory regression enumerates the mounted delivery paths and storage-streaming route modules, so adding another delivery endpoint requires updating the security matrix.

HTML keeps `sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'`. Every other media type receives `sandbox; frame-ancestors 'self'`, including SVG, XHTML, XML, unknown types and inert assets. Private project and modern share assets additionally retain their existing `default-src 'none'` restriction. Public and legacy assets retain their resource-loading behavior, including styled SVG images. A subresource response's sandbox does not sandbox its embedding document: CSS, fonts, images, modules and data still load under the existing resource policies and CORS checks. Direct non-HTML documents cannot execute scripts. No publisher response or share iframe grants `allow-same-origin`. This covers direct URLs as well as embedded viewing; the generic app HTML middleware is not the publisher isolation boundary.

Stored media types are classified by a validated, lower-case MIME essence; invalid types become `application/octet-stream`. Streamed text types (`text/*`, JavaScript/ECMAScript, JSON/XML and `+json`/`+xml` types) preserve one validated `charset`, canonicalized through an explicit [WHATWG Encoding label allowlist](https://encoding.spec.whatwg.org/encodings.json). Other parameters are discarded; malformed parameter syntax, unknown labels and duplicate charsets discard the charset as well. A stored type without a valid charset stays charset-free, including HTML/CSS, so in-band HTML `<meta charset>` and CSS `@charset` declarations remain authoritative. Only when the stored type is absent do extension defaults apply: HTML/CSS/JavaScript/JSON include `charset=utf-8`, exactly as on main. Binary/font responses never inherit charset parameters.

HTML encoding follows the actual byte path. Public publication HTML and legacy public/share HTML are fully decoded as UTF-8 before injection and emitted as UTF-8; this decoding already happened on main, so non-UTF-8 source bytes on those paths still become replacement characters. All three buffered paths explicitly declare `text/html; charset=utf-8`. This matches main’s legacy publication/share `c.html` responses; modern publications intentionally stop forwarding an absent or non-UTF-8 source charset after re-encoding, because it no longer describes the emitted bytes. Private project, modern share, and legacy private viewers use a byte-preserving prefix injector: it parses a bounded UTF-8 prefix, inserts markup only at a safe boundary, and passes an invalid UTF-8 prefix through unchanged. Those responses retain a validated stored charset or its absence, preserving non-UTF-8 rendering and in-band encoding declarations rather than relabeling original bytes. HTML classification uses exact normalized types, including tree/shell selection, rather than a case-sensitive prefix. Font extensions are case-insensitive and override older manifest MIME values: `.woff2` → `font/woff2`, `.woff` → `font/woff`, `.ttf` → `font/ttf`, `.otf` → `font/otf`, and `.eot` → `application/vnd.ms-fontobject`. Modern shares authorize assets by manifest media type and use the same stored charset rule. Existing deployments do not need republishing.

Sandbox asset failures identified by image/font/CSS/JavaScript Accept types or extensions use an empty, untyped response without CORS, preserving their status and access checks while avoiding Chromium opaque-response blocking. HTML failures retain styled, nonce-protected app error pages; no capability URLs are echoed in asset errors.

Moving all publisher content to a separate **cookieless origin** remains the longer-term architectural follow-up. This change enforces the current response/iframe sandbox boundary without changing hosting or deployment topology.

After their existing access checks, public and share files send the fixed `Access-Control-Allow-Origin: null`, matching ticket-authorized private files. All three publisher documents have an opaque sandbox origin. The fixed allowance serves this origin without extending CORS reads to every website origin (`*`) or reflecting caller input. Shares remain token-scoped and `private, no-store`; public files retain public revalidation caching. CORS is not authorization: any opaque origin that possesses a share/ticket URL can use that capability, subject to the existing revocation, scope, session, and membership checks. Cookie-authenticated canonical private file URLs still send **no** CORS allowance; private relative resources must use the injected ticket base. No viewer file response enables `Access-Control-Allow-Credentials`.

The allowance applies uniformly to font requests, `<img crossorigin="anonymous">`, `<script type="module">`, and ordinary publisher `fetch()` GETs, including HTML reads within the route's existing scope. Opaque-origin requests must be non-credentialed (default same-origin credentials or explicit `credentials: "omit"`). Credentialed cross-origin reads and preflight-requiring methods/custom headers remain unsupported; these read-only routes do not add OPTIONS handlers or expose application APIs. Root-relative/external resources remain subject to their destination's CORS policy; private publisher fetches should resolve relative paths against the current `document.baseURI` to inherit the ticket. The CORS allowance does not relax the response sandbox, referrer policy, or access validation.

`tests/publisher-isolation.test.ts` exercises the full Worker media-type matrix across all eight delivery endpoints, including denied/missing controls. `tests/publisher-isolation-browser.test.ts` verifies direct SVG origin/API/cookie isolation, share-frame navigation isolation, and HTML/CSS/image/font rendering in Chromium. `tests/publisher-charset.test.ts` covers encoding labels, malformed/duplicate parameters, stored-with/without-charset cases, main’s extension defaults and buffered/streamed HTML byte-path parity; `tests/publisher-charset-browser.test.ts` verifies a Windows-1252 non-ASCII CSS selector through all six metadata-aware delivery paths and non-UTF-8 HTML rendering through the share and four private streaming paths, each with either an explicit stored charset or an in-band declaration and no stored charset. The tests check raw bytes, exact Content-Type, rendered styles/text and opaque origins. `tests/viewer-asset-headers.test.ts` covers every font MIME across public/share/private-ticket/private-cookie routes, other CORS resources, fixed origins, and denied responses. `tests/viewer-fonts-browser.test.ts` uses the shared isolated Chromium harness, real viewer routes/shells and a local original font fixture to verify loaded font faces, anonymous images, modules and fetches in all three opaque viewers without CORS errors or subresource cookies.

### Private viewer asset authorization

The project iframe remains an **opaque-origin sandbox**, both in the shell attribute and the HTML response CSP. It never gets `allow-same-origin`; Better Auth's SameSite cookie policy is unchanged. The trusted parent can initiate a cookie-authenticated document navigation, but requests made by the sandbox itself cannot depend on that cookie.

The server uses a dedicated parser-based streaming injector to establish the ticket `<base>` before publisher resources, including documents with an implicit head, omitted head/body tags, or a doctype/comment prelude. The cosmetic head injector keeps its existing behavior. It points at `…/docs/view/<ticket>/files/<document-path>`. Relative stylesheets, images, scripts, CSS `@import`, nested CSS `url()`, and fonts therefore inherit the ticket prefix. The iframe's canonical `src` remains `…/docs/files/<document-path>` so the tree, deep links, and parent-mediated comments retain their existing document identity. Same-document fragment links stay in the current frame. Public publications and private-share routes use their existing access models.

- **Ticket:** a randomized, authenticated-encrypted JWE (`dir` / `A256GCM`), valid for 15 minutes. A domain-separated SHA-256 key is derived from the Worker's existing `AUTH_SECRET`; rotating that secret invalidates outstanding viewer tickets. The encrypted payload binds the organization, project, active manifest, the signed session-token cookie, and any legacy `dont_remember` marker, which Convex replaces with the session's persisted lifetime choice. No readable session material, API key, or cached session-data cookie is exposed to publisher code.
- **Every request:** decrypt and validate the ticket, then ask Convex for the active deployment using the recovered session-token cookie. Convex freshly checks the persisted session, organization membership, and project ownership. The active manifest must still match the ticket, and the requested path must appear in that manifest before R2 is read. There is no authorization cache. Session revocation, membership removal, or changing the active deployment denies subsequent requests; already-rendered bytes cannot be recalled.
- **Responses:** private assets and renewal responses are `private, no-store` with `Referrer-Policy: no-referrer`. Ticket-authorized responses permit `Access-Control-Allow-Origin: null` for opaque-origin fonts/modules, without credentialed CORS. The ticket is a scoped read capability, not a session replacement or permission to call application/comment APIs.
- **Renewal:** `private-viewer.js` asks the trusted parent for a replacement after five minutes, checking once a minute and on focus, visibility, pageshow, or resource errors. The parent accepts messages only from its current opaque content frame and calls cookie-authenticated `…/docs/viewer-ticket?manifestKey=…`. A ticket cannot renew itself. New URLs replace the base and current image/media/stylesheet URLs in place. CSS Syntax tokenization resolves scoped `url()` values (quoted, unquoted, and escaped), string candidates in `image-set()` / `-webkit-image-set()`, `src()` strings, and `@import` strings in inline styles and `<style>` blocks to explicit renewed URLs; Chromium otherwise retains the old base in parsed CSS. URL tokens are handled across properties, including font sources (preserving `format()`), cursor, masks, list/border images, and generated content. Fragment-only references such as `filter: url(#id)` and data/blob/absolute/protocol-relative publisher URLs remain unchanged; only absolute CSS URLs previously emitted by the renewal client are renewed again. For each scoped stylesheet link, an adjacent clone retains the same attributes/media and cascade position while loading the renewed `href`. The active sheet is removed only after the replacement loads; a failed replacement is discarded and retried on a later renewal with exponential backoff (one minute, capped at fifteen). Per-link serialization coalesces overlapping renewals to the latest ticket, keeping at most one pending clone per active sheet. Reloading the parent reloads its `@import` graph, including nested imports; the link load event waits for these sheets, and nested CSS/image/font URLs inherit the new ticket. This keeps deferred resources working without reloading the document or losing comment drafts. Resuming a suspended tab can briefly fail a resource before renewal retries it. Offline, revoked, and expired-session viewers fail closed; reload the shell after signing in again. Superseded deployments also fail closed: after fresh session, membership and project authorization, renewal for a different project-scoped manifest returns `409 { code: "deployment_superseded" }` without issuing a ticket. The trusted shell announces "A newer version of this document was published." with a non-blocking Reload button. Renewal heartbeats and resource-error-triggered renewals both detect this state. Reload is user-initiated and preserves the entire current shell URL (document path, publisher query and fragment), along with the existing user/document-scoped sessionStorage comment drafts and pending operation identities. Stale responses after frame navigation are ignored; there is no automatic reload loop. The comment bridge’s `commentor-viewer-reload` message is also only a request for this parent-owned notice: publisher code and the widget share an opaque frame, so neither the sender nor claimed user activation authorizes navigation. Repeated requests leave the visible notice and its polite announcement unchanged. Private and legacy private shells provide the Reload control; share and public shells ignore this message. Widget-version recovery first offers the notice, then waits for the reader’s parent-side Reload.

**Publisher URL contract:** use document-relative URLs (including relative paths inside CSS). URLs hard-coded to the canonical private `…/docs/files/` prefix and absolute/root-relative asset URLs cannot inherit the ticket and are not rewritten. An existing publisher `<base href>` is resolved against the canonical document URL: if it points within this project's private file tree, the injected base preserves its path/query/fragment through the ticket route. External or out-of-tree bases are left in control and receive no ticket base or renewal client activation. Publisher base markup is preserved, and (as required by HTML) must precede URL-bearing resources. Publisher scripts must not replace the managed ticket base. Configure the documentation generator's relative asset/base setting before publishing. Publisher JavaScript should resolve new resources against `document.baseURI` at request time rather than retaining ticket URLs beyond their lifetime. The renewal client updates common DOM resource attributes and styles, not arbitrary URL strings held in application state. Open the project shell for long-lived viewing; standalone file tabs have no trusted parent to renew tickets.

**Logging:** Node and Worker request logs redact the ticket path segment; errors log only their type and redacted path. Wrangler disables raw invocation logs and URL-bearing traces in both environments. Any additional reverse proxy, access-log sink, analytics, or tracing integration must similarly redact these paths before recording them. Never persist full private viewer URLs. Short-lived tickets are visible to the publisher document by design and must be treated as private capabilities.

The Chromium regression runs as part of `pnpm verify` using an isolated local server and an opaque sandbox, with a fake clock that enforces ticket expiry. Install its browser with `pnpm exec playwright install --with-deps chromium`; Linux hosts can use `/usr/bin/chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. CI installs Chromium before verification. No deployed backend or private data is used.

### Legacy private documents and comments

Legacy storage and modern project storage have disjoint authorization boundaries. Legacy tickets bind an explicit namespace prefix; issuance and every object read reject reserved or ambiguous namespaces and noncanonical paths. Modern tickets and active manifests must belong to the requested project namespace. Existing data is not moved: ambiguous historical keys fail closed across legacy viewer, sharing, publication, tree, and sync access. Previously issued legacy viewer tickets without a storage scope must be renewed by the authenticated parent or replaced by reopening the document.


Legacy `/files/:org/:path` bookmarks redirect (302) to the existing `/docs/:org/:path` shell after mapped-organization membership and file/deletion checks. Query strings are retained and browsers carry the fragment across the redirect; the shell forwards it to the document. The legacy tree and signed-share action stay unchanged. The shell loads `/legacy-view/:org/files/:path` with the same sandbox attribute and response CSP as project docs. Publisher HTML never receives `allow-same-origin`, including when a frame URL is opened directly. CSS/images/scripts keep their normalized media types; relative assets and nested CSS resolve through the ticket base. Relative links and old `/files/:org/…` document links navigate through the parent. Same-document anchors stay inside the document. Stored objects and v1 comment keys are not migrated or rewritten.

The legacy viewer reuses the streaming head injector and renewal client. Its encrypted tickets have a separate audience/key domain, bind the legacy slug and session-token cookie, expire after 15 minutes, and expose only that legacy tree. Every ticket request freshly validates the session against Better Auth, checks live membership of the explicitly mapped organization, and checks soft deletion before reading storage. The trusted parent alone renews tickets at `/legacy-view/:org/viewer-ticket?manifestKey=:org`; the shared renewal protocol's `manifestKey` field carries the legacy slug because v1 has no immutable deployment manifest. Legacy key-authorized writes are retired; owner/admin deletion and session/membership changes deny future reads. The modern relative-resource/publisher-base contract above also applies here. Ticket paths are redacted in application logs.

Legacy comments use the existing versioned parent/iframe protocol with a backend adapter to `threads`/`replies`. Authentication, durable drafts, operation IDs, and session-change checks live in the trusted parent. The iframe never receives a session or Convex auth token. The parent derives scope from its canonical frame URL, and the backend independently validates identity and the supplied document scope. Existing threads, replies, anchors, resolve/unresolve, archive/unarchive, deletion, and live updates remain available; v1 still returns the full reply list inline. New writes have stable IDs, deduplicated create/reply operations, explicit status targets with 30-day retry receipts, and identity-only deletion tombstones. Older widgets may omit IDs/status targets and retain their old toggle contract. New records bind authors by authenticated user ID; preexisting records use their stored author email.

**Legacy moderation:** archive/delete, including reply deletion, require the author or a live owner/admin of the mapped organization, matching project comments. Members may comment, reply, and resolve/unresolve. Every v1 RPC independently checks the operator mapping, persisted session, membership, organization existence and tombstone. A slug or email domain never proves membership. V1's non-paginated response is bounded to 100 total thread/reply records (including tombstones scanned); larger histories fail explicitly instead of truncating. Thread deletion refuses more than 100 replies before any write. Migrate large histories before using these legacy operations.

### Legacy operator runbook

Legacy self-service namespace creation (`POST /api/orgs`) and all legacy sync endpoints return 410 JSON pointing to `rendro@2`. Legacy key creation, rotation and validation RPCs are removed. Old key rows are inert historical data. The same retirement response applies to legacy publication requests carrying an Authorization header; legacy keys authorize neither reads nor writes.

1. Default to no mappings. Only operators configure `LEGACY_ORGANIZATION_MAP` in **Convex**, a JSON object such as `{"old-docs":"<Better Auth organization ID>"}`. Verify ownership of the stored namespace and the exact organization ID before adding it; neither the organization's slug nor any user's email is authority. Do not expose this setting as a client mutation. Missing configuration is an empty mapping. Invalid configuration fails closed.
2. Confirm the target organization exists, is not tombstoned, and has the intended members. The Worker resolves the mapping through an internal-secret-guarded required Convex read, then independently reads fresh session/membership through the organization access endpoint on every private request, including ticket assets. Neither result is cached. Configure matching `CONVEX_INTERNAL_SECRET` and the authoritative Convex URLs. Missing configuration, timeouts, throttling, malformed responses and storage errors return 503; no persistence failure returns success.
3. Existing `/public/:org/:slug` and `/share/:token` links remain anonymous only for active mapped organizations and visible targets. To disable all legacy access to a namespace, remove its mapping. Do not reassign a namespace casually: its historical content, comments and public links follow that mapping. An organization tombstone permanently denies its binding even if identity cleanup fails.
4. Members create/list publications with a session cookie at `/api/publications?org=<legacy slug>` and create signed links through the existing viewer. Owner/admin sessions revoke a publication with `DELETE /api/publications/:slug?org=<legacy slug>`. Owner/admin `DELETE /api/legacy/content?key=<full legacy key>` soft-deletes content and revokes **all** legacy signed links to that target. This is the revocation mechanism for v1 HMAC links; use modern project shares for per-link revocation. These destructive requests require a same-origin cookie request. All deletion-state reads are typed and required; batch filtering is capped at 100 keys per RPC.
5. Migrate to organization/project deployments using the #33 migration workflow below. Publication inventory now requires `legacySessionCookie`, a live member's session-token cookie, instead of a legacy API key. Keep this credential in the private operator map, never commit or log it. Expiry/revocation stops migration. Retain rollback checkpoints and coordinate legacy visibility changes during migration. Large comment histories require separate archival; this tool does not migrate comments.
6. Verify a mapped member succeeds, a same-domain nonmember is denied, and removal of the mapping denies both private and anonymous links. Simulate unavailable deletion metadata before enabling a mapping. Deploy Convex and Worker changes in a coordinated cutover; reverting to domain-derived authorization is not a safe rollback. For an outage, clear mappings and restore the fixed version. No object migration is needed to disable legacy access.

Deploy Convex functions and the Worker in a coordinated cutover; no object or comment backfill is required. Existing legacy URLs work only under the configured mapping. The legacy browser regression uses the shared offline Chromium harness against real Worker routes, the actual bridge/adapter/widget, and a fixture Convex transport executing the v1 queries/mutations.

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
  ├─ Scoped viewers: GET …/tree?dir=…&cursor=… per folder (root first), with "Load more" pagination
  │   └─ A deep link expands its ancestors and loads later pages of only those folders to reveal its row
  │       (overlapping reveals share a folder that is still loading; only the newest marks its row)
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

The Chromium fragment regressions wait for the shell to read native inactive
activation before a subsequent click, rather than assuming a 5.3-second delay
includes an observer tick. Their test-only getter delegates to Chromium's native
getter and acknowledges the read after the gate's synchronous reset. CDP installs
this observation without granting the automation activation that Playwright
evaluations can introduce. Destination checks match the publisher's path and
initialized query so the outgoing document cannot satisfy readiness. Tests wait for the
iframe's load acknowledgement, without waiting for the sidebar's cosmetic
520ms feedback window; native share navigation needs no activation-expiry wait.
Confirmation and replacement-frame tests count committed documents separately
from requests: replacing
the pending iframe `src` navigation can abort a request after it reaches the
fixture server. Further unsolicited messages must cause neither additional
commits nor requests once the approved document has loaded. The replacement-frame
fixture reports completion after repeated requests and native activation expiry,
then stops sending. The sign-out confirmation regression also observes its
unsolicited notice inside the same passive CDP evaluation that sends the request,
before a Playwright locator wait can grant activation. History assertions and Back run after that signal so automation
activation cannot authorize another fixture request and a still-running fixture
cannot reopen a notice during restoration. History checks use passive reads and
wait for the expected joint-session count; the sequential-click regression also
checks both Back destinations so a missing entry cannot be hidden by readiness.

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

Convex delivers the reactive snapshot that contains a new comment or reply before the mutation's acknowledgement, so the widget treats either order as normal. Closing the composer returns focus to the control that opened it even when the snapshot closes the composer first, and a sent reply keeps keyboard focus in its (possibly re-rendered) reply box. A rendered action whose write is still outstanding stays disabled across re-renders.

### Comment permissions

Project comment queries and mutations require current organization membership and the exact organization/project/document scope. Authors can delete their own threads and replies; organization owners and admins can delete anyone's comments. Other members cannot. Archive/unarchive uses the same author-or-admin rule because it hides a thread. The server returns a per-comment `canDelete` flag in thread pages, reply previews, and reply pages; the widget hides Delete (and thread Archive/Unarchive) unless permitted. These flags are presentation hints: mutations recheck the current identity and role.

Resolve/reopen intentionally remains available to any organization member with write access for collaborative triage, as do creating threads and adding replies. Author IDs always come from the authenticated identity. Reply removal verifies that the reply belongs to the scoped thread and deletes only that reply; deleting a thread retains the existing tombstone and batched reply cleanup. Shared/public read-only viewers have no comment mutation access. These organization-role rules apply to project comments; the legacy slug-based API described below retains its separate authorization model.

Thread and reply history uses bounded reactive Convex pages. Explicit load-older controls preserve access to the full history; loaded pages remain subscribed rather than becoming a stale snapshot. Read limits account for reply previews and bounded author projections as well as raw thread rows. Deletion hides the thread immediately using a tombstone, then removes replies in scheduled batches of 100 before deleting the thread record. Organization membership is checked by indexed organization/user lookup, not by searching the first page of an organization roster.

The legacy opaque viewer (`/docs/:org`) loads `commentor.js` inside its sandbox and routes comments through the same parent bridge, using an adapter for the legacy `threads`/`replies` tables. These tables require operator-mapped live membership and author/admin moderation (see Legacy operator runbook). Worker-only mapping and soft-delete functions require `CONVEX_INTERNAL_SECRET`, which must match in the Worker and Convex environments.

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

### Self-hosted fonts

Inter and a Material Symbols Outlined subset are committed under `public/fonts/` as content-hashed woff2 files (`<name>.<sha256[:10]>.woff2`), with their licenses beside them: `LICENSE-Inter-OFL-1.1.txt` (SIL OFL 1.1) and `LICENSE-Material-Symbols-Apache-2.0.txt` (Apache-2.0). They are static assets of the Worker (`[assets]` directory), never bundled into the Worker script, and they are not in the asset-version ledger because the hash is in the file name.

| File | Bytes | Contents |
|---|---|---|
| `inter-latin.<hash>.woff2` | 34,380 | Inter variable, `wght` clamped to 400–700, Latin |
| `inter-latin-ext.<hash>.woff2` | 55,820 | same, Latin Extended (loaded only when such characters appear) |
| `material-symbols-outlined.<hash>.woff2` | 7,280 | 35 icons; FILL 0, GRAD 0, wght 400, opsz 20–24 |

`scripts/build-fonts.ts` (`pnpm build:fonts`) regenerates them reproducibly offline from the pinned devDependencies `@fontsource-variable/inter` and `material-symbols` using `subset-font` (HarfBuzz subsetter with axis instancing), and writes `src/routes/font-manifest.ts`. `pnpm verify:fonts` (part of `pnpm verify`) regenerates in memory and fails on any byte difference. The icon list is extracted from source by `scripts/fonts/icon-names.ts`: in every file that renders Material Symbols it collects each quoted string and `>text<` node that is a valid ligature name, minus `NON_ICON_LITERALS` (ordinary words that are also ligatures, such as `block` or `pending`). An unlisted word is harmless: it only adds a glyph to the subset. `tests/font-subset.test.ts` fails when the committed subset and the source disagree and checks every listed name shapes to one ligature glyph in the committed font. Layout subsetting keeps the ligature rules of only the listed glyphs (`noLayoutClosure`); closure would retain all ~3,900 icons.

`GET /fonts/*` is public and runs before the session middleware in both runtimes (`src/worker.ts`, `src/index.ts`). `fontResponseHeaders` (`src/routes/fonts.ts`) decides the response: hashed `*.woff2` → `Content-Type: font/woff2`, `Cache-Control: public, max-age=31536000, immutable`; license texts → `text/plain; charset=utf-8`, one day; everything else under `/fonts/` is an empty 404 (never an ASSETS fallthrough). A missing font is not cached as immutable. Pages call `renderFontHead({ icons?, weights? })`, which emits `rel="preload" as="font" type="font/woff2" crossorigin` for the Latin Inter file (and the icon font on icon pages) plus the `@font-face` rules in a nonce-bearing `<style data-rendro-fonts>`. Pages with a theme button (landing, auth, management, shell) declare the icon font; the styled 404 page does not.

### Environment Variables (Workers)

`src/config.ts` validates the Worker environment at startup. The table lists every named string setting read by Worker code; `ASSETS` is the separate static-asset fetch binding in `src/worker.ts`. Google OAuth credentials are read only by Convex, and `BASE_URL` is unused. The local Node entry reads `PORT` separately.

Both production (top-level) and `development` declare the same required secrets: `CONVEX_INTERNAL_SECRET`, `AUTH_SECRET`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, and `MINIO_SECRET_KEY`. Wrangler checks these at deploy time, and `src/config.ts` validates them at startup. Production commands use the top-level configuration without an `--env` flag; development commands use `--env development`.

| Variable | Storage | Purpose |
|---|---|---|
| `NODE_ENV` | Wrangler var | Runtime mode; `production` selects JSON logs at `info` level |
| `CONVEX_URL` | Var/secret (optional at startup) | Convex deployment URL for legacy calls and browser comments; defaults to empty; required legacy reads return 503 without it. Set for the full app |
| `CONVEX_SITE_URL` | Var/secret (optional) | Convex HTTP action origin for auth and project routes; derived from `CONVEX_URL` when unset. Startup and `/health` work without either URL; backend routes do not |
| `CONVEX_INTERNAL_SECRET` | Secret (required by `wrangler.toml`, ≥32 chars) | Worker-only legacy functions, ingress proofs and storage resolver proofs; same value in Convex |
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
| `LEGACY_ORGANIZATION_MAP` | Operator-only JSON object mapping legacy namespace slugs to exact Better Auth organization IDs; absent means no legacy access |
| `CONVEX_INTERNAL_SECRET` | Authorizes Worker-only legacy functions, ingress proofs and storage resolver proofs; same value as the Worker |
| `RETENTION_SECRET` | Bearer secret accepted only by retention HTTP actions |
| `MIGRATION_SECRET` | Bearer secret accepted only by the staged migration control action |

### CI workflows

| Workflow | Trigger | Runs |
|---|---|---|
| `.github/workflows/quality.yml` | Pull requests, pushes to `main`/`development`, manual | Independent `verify` (`pnpm verify`, dependency audit), `coverage` (`pnpm coverage`, summary artifacts), and `e2e-engine` (one Playwright Test/workerd job per browser engine) with an aggregate required `e2e` job; read-only permissions, no deployment credentials |
| `.github/workflows/release.yml` | `v*` tags | Builds `bin/rendro.mjs` and attaches it to a GitHub release |
| `.github/workflows/retention.yml` | Daily cron, manual | `pnpm cleanup:retention` |
| `.github/workflows/stability.yml` | Nightly cron, manual | `coverage-twice` (two consecutive `taskset -c 0,1 pnpm coverage` runs, then per-test outcome and coverage-counter diffs; the second run and diffs always execute) and `e2e-no-retries` (per engine, `E2E_RETRIES=0`); read-only permissions, no secrets; any failure fails the workflow |

No workflow deploys the Worker or Convex to a shared environment, or publishes to npm.
The E2E job pushes application code only to a harness-owned disposable loopback backend.

`pnpm e2e` starts the real Worker through Wrangler's `createTestHarness`, with
the production compatibility flags and static-asset configuration, isolated
loopback ports, generated test secrets, and guarded outbound requests. The
suite uses pinned local Convex with real Better Auth, HTTP actions and WebSockets,
disposable S3Proxy, an in-memory mail sink, and a deterministic OAuth provider fixture.
A generated local instance/admin key, loopback target assertion, sanitized CLI
environment and temporary source copy isolate every Convex push from shared deployments.
Every cached Convex archive is SHA-256 checked against its pinned release digest
on every use. Downloads publish by atomic rename from unique staging directories;
each run extracts the verified bytes into its private directory and never executes
a shared cached binary. Setup journals child PID/start-time identities, container
names and its private directory before returning any teardown callback. A separate
Playwright global teardown and synchronous exit/SIGINT/SIGTERM cleanup cover setup
timeouts; the next run sweeps abandoned journals (including after SIGKILL) while
preserving active runs. Failed cleanup retains its journal for another attempt.
Owner/admin/member/outsider seeds span two organizations; all three engines cover
a complete signup-to-CLI-push-to-reactive-comment journey. The 12 public-RPC backend
tests run unconditionally in verify and an explicit E2E CI step. It complements the
existing Vitest Chromium project, and runs one browser engine at a time.
See [the two browser test layers](BROWSER_TESTS.md) for setup, limitations,
failure traces and the #110–#115 journey expansion. The complete three-engine run is bounded
at 45 minutes (60 for the CI job); `e2e/shell-*.spec.ts` (#110) assert the shell, navigation,
menu, dialog, select and theme transitions, and the registry credits an edge as `e2e` only
for a named test that asserts its final state.

The UI transition registry in `tests/ui-transitions.json` records behavior and
assertion evidence for epic #99. Its validator runs in `pnpm verify` and checks
the actual Hono registrations against page families and explicit non-page
exclusions. See [UI transition registry](BROWSER_TESTS.md#ui-transition-registry-99--102)
for status semantics, the audit baseline, and `scripts/ui-transition-report.ts`.

Source coverage includes authored Worker/Node, Convex, CLI, shared, and script code,
with root-anchored filters and generated-code exclusions. The coverage gate
merges Istanbul shards, checks the complete source manifest, and prevents
per-file uncovered counters from exceeding `coverage-debt.json`. New files must
be fully covered; stale ledger entries must be removed, and CI rejects ledger
increases relative to the base revision. All authored Convex modules, including the
Better Auth adapter and the DEV-only QA fixtures, are fully covered and absent
from the ledger, as are `src/viewer`, `src/lazy-tree`, `src/ui` and
`src/management-query` (#118 batch A); only `src/commentor` remains. The lazy
tree and the shared select are covered by Chromium suites against the real
bundles (`tests/lazy-tree-browser.test.ts`, `tests/shared-select-browser.test.ts`). The QA permission fixture is exercised end to end by routing its
`dev.rendro.app` requests into the production Convex HTTP router under
`convex-test`, with fault-injection suites for failed checks and partial cleanup.
Coverage runs separately from verify
to preserve its 15-minute budget. The Vitest Chromium harness builds mapped
in-memory test bundles and collects page, popup, and opaque OOPIF V8 coverage,
including pre-navigation and failure teardown samples. Collection barriers flush
all attached targets before detach; tests explicitly flush before direct frame
removal. Scheduling-sensitive loader, layout and comment states have deterministic
Chromium fixtures, and a per-counter location diff checks repeated full reports
before debt is shrunk. Comment highlight coverage explicitly verifies reuse of
existing DOM segments. CI artifacts retain raw and merged counters on failure so
the same diff can diagnose discrepancies with two-CPU constrained local runs.
A reload delta for a transient script without a debugger source is attributed
only to its URL's single agreeing retained source; ambiguity still fails.
Tests flush explicitly before page code reloads a later main document, such as
the viewer's Reload control.
`pnpm coverage` requires
per-suite browser receipts and feeds the mapped `coverage/browser/*.json` shards
to the same strict merger as the Node report. Production assets are unchanged;
inline controller strings remain tracked by #105/#106. See [source coverage and debt](BROWSER_TESTS.md#source-coverage-and-debt-gate)
for commands, reports, transform normalization, and the subprocess collector
(`NODE_V8_COVERAGE` receipts per spawned CLI, server or script process, converted
and merged like the browser shards; a suite that spawns through the collector and
produces no coverage fails the run). The CLI, shared and script modules are fully
covered and absent from the ledger.

---

## Operational Runbooks

### Interrupted push

1. On a copy, upload, or commit error, the CLI calls `/api/rendro/deployments/fail` itself, so the new deployment is marked `failed` and the active deployment is unchanged.
2. Re-run the same `rendro push` command. It starts a new staging deployment; unchanged files are copied from the active deployment again.
3. If commit returns "Active deployment changed; rebase and retry", another push activated first. Re-run the push.
4. A process killed before it can call `/fail` leaves a deployment in `staging`. It never becomes active; its one-hour lease expires and retention cleans it after the additional 24-hour drain period.
5. Confirm the project page shows the new deployment as `active`; the predecessor becomes `superseded`.
6. Never change the project pointer or copy files manually. Commit is the atomic boundary.

### Revoke leaked access

- API credential: the organization's API keys page → Revoke. Validation checks revocation on every request.
- Private share: revoke it from the project's Private shares page, or call `POST /api/rendro/shares/revoke` with its grant ID. The token hash stops resolving immediately.
- Public publication: remove it from the project Publications page or with `rendro publication remove`. `/p/:slug` returns 404 afterward.

### Historical provenance review

Operators should privately review historical deployment provenance for embedded Git credentials, including URL userinfo, query strings and fragments. Rotate/revoke any discovered credentials and sanitize affected stored records and retained exports under the normal operator change process. Do not copy raw provenance into logs, issues or support messages. Read-time sanitation prevents responses from repeating known credential forms; it does not rewrite historical database rows or undo earlier exposure.

### Retention

`pnpm cleanup:retention` scans failed deployments older than 24 hours, superseded deployments older than 30 days (both measured from creation), and expired staging leases after their 24-hour drain period. Failed rows also honor the staging drain deadline. Active deployments and project active pointers are protected. Publication pins and unexpired, unrevoked shares protect their deployment with indexed existence checks (`by_pinned_deployment`, `by_deployment_live`), without collecting a project's publications or an organization's shares.

Upload and copy requests freshly re-authorize the current staging lease after body/source validation and immediately before storage dispatch. A lease renewed by another request remains usable. An expired lease returns HTTP 409 with “Staging lease expired. Run rendro push again to start a new deployment.”; the CLI preserves that diagnostic and attempts failure cleanup. Storage operations retain their five-minute/lease deadline and the retention drain interval.

The operator-only `GET /retention/candidates` is a non-cacheable claim operation. One Convex transaction pages at most three candidates with a 256 KiB read budget, rechecks references, claims them, and persists the scan cursor. Pagination can cross the byte budget by one document (Convex caps each document at 1 MiB), so large legacy rows still advance. The candidate count also bounds project/publication/share lookups to nine documents, reserving headroom below the 16 MiB read limit and for claim writes. Claims and completion timestamps live only in `deploymentPurges`, keyed by deployment ID. Retention never patches a deployment document, so historical rows at the 1 MiB limit (including oversized digests, storage keys or provenance) can progress without growth, truncation or a backfill. Regression tests explicitly assert Convex serialized document sizes because convex-test does not enforce the per-document limit. `by_retention` selects status + absent `purgedAt` + creation time; `by_staging_expiry` selects staging + absent `purgedAt` + lease expiry, including legacy missing values. Legacy deployment tombstones are excluded by those indexes. New completion records are checked through the small side table; their deployment rows are visited but skipped on subsequent traversals. This trades repeat bounded reads for leaving full legacy documents untouched. Empty/protected pages still advance. A fixed cutoff and rotating failed/superseded/staging phases finish one traversal before restarting; a later run resumes from `retentionProgress` even if the previous process died. Rows added behind a cursor are visited on the next traversal.

Claims insert a `deploymentPurges` record and token before any storage deletion. Publication/share mutations read that record and legacy purge fields in their transaction; Convex conflict handling ensures that either the reference protects the bytes or the claim blocks the reference. Public resolvers also reject purging and purged rows. Claim worker ownership expires after 30 minutes, but **purging never reverts to readable/pinnable**: another scan can issue a replacement token and retry the immutable prefix. A lost claim response, interrupted deletion, per-object error, or failed finalization is therefore recoverable. Finalization requires the current token and is idempotent, emitting one `deployment.purged` audit event. Its object count describes the successful attempt, not previously deleted objects from interrupted attempts.

The script drains up to 100 metadata pages, 1,000 storage-list pages or ten minutes per run, stopping at the first bound or completed scan. Each HTTP/storage call has a 30-second deadline; an in-flight call may extend the wall-time bound. It re-lists a prefix from the beginning after each successful delete and checks `DeleteObjects.Errors`, then verifies the prefix is empty before finalization. Errors keep claims retryable, allow other candidates to proceed, and fail the job. `.github/workflows/retention.yml` runs daily with a 15-minute job timeout and serializes runs. Required secrets: `CONVEX_SITE_URL`, `RETENTION_SECRET`, and `R2_ENDPOINT`/`R2_ACCESS_KEY`/`R2_SECRET_KEY`/`R2_BUCKET` (mapped to `MINIO_*`).

Rollout: release the separate claim table, optional compatibility fields/indexes and claim-aware Convex endpoints, then the lease-aware Worker, then the cleanup script/workflow. Keep cleanup disabled during mixed-version rollout; the old script cannot finalize tokenized claims, but still must not run alongside the new protocol. All old deployment rows remain readable without backfill. To roll back, stop the cleanup workflow and preserve purging claims/tombstones until outstanding deletions have been reconciled; never clear a purging flag to restore a potentially partially deleted deployment.

### Legacy migration

Legacy migration remains supported: slug-based publications, comments, `/share`, `/public`, and `/docs/:org` remain available, and production migration verification has not been recorded. Keep the migration tool until that verification is complete. It copies slug-prefixed object bytes into immutable deployments using the same Worker start/upload/commit protocol as `rendro push`.

1. Set the same random `MIGRATION_SECRET` in Convex and the operator environment. Set `RENDRO_ENDPOINT` to the target Worker origin (default `http://localhost:3000`) and the `MINIO_*` variables to the source bucket. Set `CONVEX_URL` and `CONVEX_INTERNAL_SECRET` to the authoritative legacy Convex database used by that Worker and bucket; apply refuses to continue if deletion state cannot be read.
2. Create a JSON array containing `legacyOrgSlug`, Better Auth `organizationId`, an organization-scoped migration `apiKey`, and optionally `projectId`, `projectName`, and `legacySessionCookie`. The current key needs `docs:write`; publication migration additionally needs `docs:read`, `publications:read`, and `publications:write`. The session cookie reads `/api/publications?org=<legacy slug>` with live mapped membership. The target project must be empty or contain an identical completed migration from this legacy slug.
3. Run `pnpm migrate:legacy -- --map targets.json` for a read-only inventory.
4. Run again with `--apply`. For a non-local Worker, also supply `--confirm-endpoint <Worker origin>` (for example, `--confirm-endpoint https://rendro.example`). Apply and rollback print the sanitized Worker origin, source storage origin/bucket, source Convex origin, and organization/project mappings before any remote writes; the confirmation must match the displayed Worker origin. The tool queries `deletedFiles:filterFn` (the `deleted_files` table, indexed by full object key), excludes soft-deleted objects, then hashes the remaining objects and creates/reuses a dedicated project. It sends the sorted manifest to `/api/rendro/deployments/start`, reads `deployment.deploymentId`, uploads bytes through `PUT /api/rendro/deployments/:id/files/*`, then commits through `POST /api/rendro/deployments/:id/commit`. The Worker writes the manifest/tree index and validates uploaded hashes and sizes. When `legacySessionCookie` is supplied, the tool reads the current legacy publication records and recreates them as pinned mappings. Removed publication records are not recreated. Files inside published folders that legacy public routes cannot serve (non-HTML or ambiguous paths) are excluded from the deployment, since v2 can serve any manifest entry. A deleted/missing entry document stops migration before destination writes. Before any destination write, the complete inventory (including private and deleted objects), publication prefixes, and entry paths must survive the shared v2 publication/deployment path functions unchanged; invalid paths and normalization collisions abort the target with the offending paths listed. The single terminal slash in a legacy folder prefix is its delimiter; extra slashes, whitespace trimming, decoding, and dot segments cannot silently change scope. Case and Unicode code points remain distinct, exactly as in v2. Deletion and publication filtering use the validated paths; the migration never repairs or remaps an unsafe source path. Deletion and publication state are checked again before publishing; changes stop publication.
5. Preserve the emitted `migration-rollback-*.json`, which is checkpointed throughout apply, including partial failures. Run `pnpm migrate:legacy -- --map targets.json --apply --rollback migration-rollback-….json` (also supplying `--confirm-endpoint <Worker origin>` for non-local targets) to revoke publications recorded by that run (including identical mappings reused on a retry). Migrated projects and bytes remain available privately for audit. Rollback does not restore or delete deployments.
6. Compare object/file counts and sample private/public routes before retiring legacy paths. Do not derive new organization IDs from old slugs.

Example `targets.json` (keep credential-bearing files out of version control):

```json
[
  {
    "legacyOrgSlug": "acme",
    "organizationId": "<Better Auth organization ID>",
    "apiKey": "<current scoped API key>",
    "legacySessionCookie": "better-auth.session_token=<private session cookie value>"
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
4. Retention cleanup needs R2 credentials in the scheduled GitHub environment; bounded runs may take multiple daily invocations to finish a large backlog.
5. Legacy slug-based routes remain only for the staged migration window and must be removed after production verification.
6. The first Convex HTTP action after a cold start can add latency.
