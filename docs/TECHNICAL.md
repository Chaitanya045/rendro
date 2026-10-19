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
      └── immutable file delivery ─► R2 through the Worker's native bucket binding
```

### Component Roles

| Component | Technology | Purpose |
|---|---|---|
| **Edge application** | Hono on Cloudflare Workers | Request routing, SSR, auth proxy, authorization handoff, sandboxed file streaming |
| **Identity and tenancy** | Better Auth Convex component | Google and email/password identity, email verification, sessions, organizations, teams, invitations, roles |
| **Application metadata** | Convex | Projects, immutable deployments, publications, scoped credentials, revocable shares, comments, audit events |
| **Blob storage** | Cloudflare R2, reached only through the Worker's native `STORAGE` binding (`src/storage.ts`); no S3 endpoint or access key exists | Deployment manifests and immutable objects under organization-ID prefixes |
| **CLI** | Node.js, bundled to one executable | Manifest hashing, delta upload, provenance, deployment commit, publication management |
| **Browser UI** | Server HTML + vanilla JavaScript | Organization/project management, document navigation, comments |

Storage is the `STORAGE` R2 binding declared in `wrangler.toml` (production `rendro-docs`, `development` `dev-rendro`). There are no storage credentials: a leaked secret cannot read the bucket from outside the Worker, and the bucket must stay private (see [R2 bucket privacy](#r2-bucket-privacy)). Local development (`pnpm dev` through `src/local-storage.ts`, and `wrangler dev`) and E2E use Miniflare's R2 simulation; nothing needs Docker or an S3 server for storage.

### Storage API (`src/storage.ts`)

All storage goes through a handful of functions; routes never see the binding. `src/storage-binding.ts` holds the isolate's bucket: the Worker calls `bindStorage(env.STORAGE)` in its first middleware and in the `scheduled` handler, the Node dev server binds the Miniflare bucket once, and a missing or malformed binding makes every call throw (fail closed).

| Function | R2 operation | Notes |
|---|---|---|
| `getObjectStream(key, range?)` | `get(key, { range: { offset, length } })` | `null` for a missing key. A ranged read must come back with exactly the requested `offset`/`length` and the manifest's total size, otherwise it throws and the unread stream is cancelled, so mislabelled bytes are never sent. A start past the end is rejected by R2 itself (10039) |
| `getObjectText(key)` | `get(key)` then `.text()` | `null` for a missing key |
| `headObject(key)` | `head(key)` | `etag` is R2's unquoted `etag` (S3 returned it quoted and the old code stripped the quotes); `metadata` is `customMetadata` (case preserved; S3 lowercased keys); `contentType` is `httpMetadata.contentType` |
| `putObject(key, body, type, metadata, signal)` | `put(key, body, { httpMetadata, customMetadata })` | Bodies are strings or bytes, so a replay is safe. Single-shot puts only: uploads are capped at 8 MiB per file, far below R2's 5 GiB limit, so multipart is not used |
| `copyObject(from, to, signal)` | `get(from)` then `put(to, body, { httpMetadata, customMetadata })` | R2 has no server-side copy, so the bytes stream through the Worker (one R2 read and one write, no buffering). Content type and metadata are carried over; a missing source throws |
| `listImmediate(prefix, { maxKeys, startAfter })` | `list({ prefix, delimiter: "/", limit, startAfter })` | `.html` objects plus `delimitedPrefixes` as folders; `nextStartAfter` is the last returned key, as before |
| `listAllKeys(prefix, limits?)` | `list({ prefix, cursor })` | Same 8-page / 1,000-key commit budget; the cursor is followed only while `truncated` |
| `listKeyPage(prefix, limit)`, `deleteObjects(keys)` | `list({ prefix, limit })`, `delete(keys[])` | Retention: up to 1,000 keys per call |
| `deleteObject(key)` | `delete(key)` | A missing key is not an error |

Behaviours that are deliberately unchanged: HEAD requests and `304` answers still never touch storage (validators derive from the manifest hash, so R2's `onlyIf` conditional reads are not needed); `If-Range` and range parsing are decided before any storage read; and the legacy-private route keeps its `"s3-<etag>"` validator text so clients' cached validators stay valid. Differences to know: R2 reports `etag` unquoted (`httpEtag` is quoted); an unsatisfiable `range` throws instead of answering 416, which only happens if a manifest disagrees with storage; `put` cannot be cancelled once started, so an abort signal ends the caller's wait but a started write may still land inside the staging prefix (retention drains it); and every operation is replayed up to three attempts in all after a transient fault (the same budget the S3 SDK had).

Errors from the binding are plain `Error`s whose message ends in an R2 code, `<operation>: <text> (<code>)`. `transientStorageFault` (`src/storage-fault.ts`) treats `10001` (internal), `10043` (temporarily unavailable) and `10058` (rate limited) as retryable service faults and `10054` (client disconnected mid-transfer) as a dropped connection. Rejections that describe the request (`10003` permission, `10007`, `10012`, `10020`, `10031`, `10039`, ...) and anything unrecognised stay final. Only the enumerated kind and status are ever logged, never the message. `tests/storage-r2.test.ts` runs every behaviour above against both an in-memory bucket and Miniflare's real R2 simulation, so the fake used elsewhere cannot drift.

### R2 bucket privacy

Worker routes are the only authorization boundary, so no bucket may be reachable any other way: no managed `r2.dev` URL and no custom domain. `pnpm check:r2-public` (`scripts/check-r2-public-access.ts`) asks the Cloudflare API for both lists for every bucket in `wrangler.toml` and exits non-zero if either is enabled, if a custom domain is attached at all, or if a bucket cannot be verified. It needs `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` limited to R2 read access; without them it exits `2` ("was NOT verified"), never `0`. `--dry-run` prints the requests without credentials. `.github/workflows/r2-public-access.yml` runs it daily and on demand with those two repository secrets, and as a dry run on pull requests that touch the script, the workflow or `wrangler.toml`.

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

Account linking trusts Google only when the local email is verified and the emails match. Sign-up responses do not reveal whether an address is already registered. Better Auth rate limits are stored in the database; sign-in and sign-up endpoints have tighter per-route limits. Verification, reset, invitation, and existing-account notices are sent through Resend (`RESEND_API_KEY`, `AUTH_EMAIL_FROM`). Delivery retries transient transport failures and provider 5xx/429 with bounded immediate attempts, and logs the outcome when it still fails; the sign-up response stays neutral either way, and users retry through the resend form.

The local authentication regression suite (`e2e/auth.spec.ts`) exercises these
flows against workerd and the disposable Convex backend, with captured mail and
a local Google protocol fixture. Original signup verification and resend are
separate journeys; reset mismatch asserts no request, and the shared sign-out
helper waits for method loading to settle before clicking the moving footer control.
Sign-out asserts hidden, inert protected containers in both tabs. Expiry tests age disposable backend records;
rate-limit tests use the unchanged production limiter. See
[Browser tests](BROWSER_TESTS.md#authentication-journeys-111) for isolation,
assertions, and documented expected failures.

`/verify-email` treats any `error` query parameter as an invalid or expired
link: Better Auth redirects there with `error=INVALID_TOKEN` or `token_expired`
(sometimes alongside `verified=1`). The page then renders a "Verification link
unavailable" heading, a `role="alert"` explanation, and the resend form, and the
runtime focuses the heading. Success ("Email verified") shows only when
`verified=1` arrives with no `error`; unknown error values get the same page. The
message and resend response are identical for every address, so nothing reveals
whether an account exists. The onboarding deployment poll reads the commit from
`provenance.source.commit` (shortened to 12 characters) and omits it when absent.

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

### Session cookies

Every cookie Better Auth and its Convex plugin set shares one prefix (`shared/auth-cookies.ts`): `session_token`, `session_data` (and chunks), `dont_remember`, `account_data`, OAuth `state`/`oauth_state`, and `convex_jwt`.

| Site origin (`SITE_URL`) | Cookie names | Attributes |
|---|---|---|
| HTTPS (production, dev.rendro.app) | `__Host-better-auth.*` | `Secure; Path=/; HttpOnly; SameSite=Lax`, never `Domain` |
| Local HTTP (`http://localhost`, E2E on `127.0.0.1`) | `better-auth.*` | `Path=/; HttpOnly; SameSite=Lax`, not `Secure` |

Better Auth only knows the `__Secure-` prefix, so `convex/auth.ts` turns its automatic prefix off (`advanced.useSecureCookies: false`), sets `advanced.cookiePrefix` to `__Host-better-auth` on HTTPS and `better-auth` otherwise, and sets `defaultCookieAttributes.secure` from the origin. No plugin sets a non-root path or a Domain, and better-call enforces the `__Host-` invariants when it serializes. The Worker strips any upstream `Domain`, so a sibling subdomain can neither set nor shadow the session.

**Migration from `__Secure-better-auth.*` (pre-#89 HTTPS names).** The `rendro-legacy-cookie-migration` plugin (first in the plugin list, `convex/sessionLifetime.ts`) handles browsers that still hold the old names:

- **Reads:** `onRequest` rewrites every HTTP request's Cookie header before routing, so all hooks and endpoints see only current names. A legacy cookie whose current twin is absent is *promoted* to the current name; one whose current twin is present is *shadowed* and dropped, because the current cookie always wins. `sessionCookieHeaders` applies the same rewrite to server-side session reads, including cookies inside viewer tickets minted before the switch. The Worker's own matchers (`src/viewer-ticket.ts`, session middleware, session cache) accept `__Host-`, `__Secure-` and unprefixed token names and leave precedence to Convex.
- **Re-issue:** after a successful GET that resolves a live session from a promoted legacy token (for example `/get-session`, `/convex/token`, or the organization reads every management page makes), the response sets the current session cookie with the same signed value. Its lifetime comes from the persisted session, never a client cookie (#145): remembered sessions get `Max-Age` = the 7-day session lifetime; non-remembered sessions stay browser-session cookies plus the signed `dont_remember` marker. The stored expiry is not extended.
- **Expiry:** promoted legacy cookies are expired (`Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`) only by such a read, or when the response itself sets or clears the current session cookie (sign-in, refresh, sign-out, an invalid or expired token). A failed or writing request never removes them, so a transient error cannot sign anyone out. Shadowed legacy cookies are expired on any response. A caller cannot supply the internal migration record: `onRequest` replaces it, and server-side calls never carry it.
- **Sign-out** expires every name under all three prefixes (host-only, plus the parent domain except for `__Host-`, which browsers reject with a Domain) and sends `Clear-Site-Data: "cache"`, so the browser also drops the HTTP cache holding any private frame the viewer cached immutably in that profile (#242). The `"cookies"` directive is deliberately absent: it would clear cookies for the whole registrable domain, so a sign-out on one subdomain would wipe sessions on every other one, while the per-name expiry below is exact.

**Rollout order: Worker first, then Convex.** The new Worker accepts all three names, so it works with the old Convex deployment (which still sets and reads `__Secure-` names). The old Worker only recognizes `__Secure-`/unprefixed session tokens: behind it, users holding `__Host-` cookies would look signed out on pages and viewer tickets. To roll back, revert Convex first (users already migrated to `__Host-` sign in again once), then the Worker. Reverting only the Worker while the new Convex is live is not supported.

A session that is used at all is migrated on its first authenticated read; an idle legacy cookie stays readable until it expires (at most the 7-day session lifetime after its last refresh). Legacy reads can be removed once that window has passed after the release that switches names. `tests/auth-cookie-migration.test.ts` runs the real Better Auth handler, Convex adapter, Worker proxy, session middleware and cache over HTTPS and HTTP. `e2e/cookie-migration.spec.ts` checks login persistence across the rename in Chromium and Firefox (WebKit does not send Secure cookies on a loopback HTTP origin, so it skips there). Migration is observed on the wire (a same-origin session read must stop sending any `__Secure-` name) and in the jar with expired entries ignored, because Firefox can keep listing a cookie that a `Max-Age=0` response has already expired (#210).

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
4. **Sign-out**: `GET /api/auth/sign-out` shows confirmation; a same-origin `POST` calls Convex sign-out, then expires every known auth cookie under the current, legacy and local names (host-only and parent domain; `__Host-` names host-only) and sends `Clear-Site-Data: "cache"` (#242). `"cookies"` is deliberately absent: it clears cookies for the whole registrable domain, not just this origin, and the expirations are already exact per name.

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
| Scopes | `docs:read`, `docs:write`, `publications:read`, `publications:write`. A repeated scope in a create request is de-duplicated (first occurrence kept); an unknown scope is a 400. Keys stored before this rule may hold repeats and authorize exactly as before |
| Binding | One organization, optionally one project |
| Expiry | Optional; the UI offers 30 days, 90 days (default), 1 year, or never. The API accepts only an absolute millisecond timestamp that is a safe integer, in the future, and at most 366 days ahead (a year plus one day for client clock skew); anything else is `400 Invalid credential fields`. Keys stored with an earlier value keep working: validation reads the stored timestamp unchanged |
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

The Teams page reads the session's `activeTeamId` (`GET /api/auth/get-session?disableCookieCache=true`, managers only) before painting, because Better Auth refuses to remove the session's active team (403 `YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_TEAM`) regardless of the team count. That team's **Remove team** is disabled with an `aria-describedby` hint; the server rule is unchanged and remains the authority (a failed session read leaves the button enabled and the refusal is toasted).

Client-routed Back/Forward scroll (`src/routes/management-navigation.ts`): the router sets `history.scrollRestoration = "manual"` and stores the departing offset in history state (`__rendroScrollY`, also refreshed on `pagehide` so a reload or hard Back to a management document is restored too). A popped destination applies its saved offset once its loading states have been replaced by content (the same transition that clears `aria-busy`), because earlier the document is too short and the browser would clamp it. Wheel, touch, key or pointer input before that moment cancels the pending restore, and a newer navigation or sign-out drops it. Fragment navigation and heading focus (never claimed on Back/Forward) are unchanged, and the management stylesheet already forces `scroll-behavior:auto` under `prefers-reduced-motion`.

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
  ├─ 1. Storage binding (env.STORAGE → src/storage-binding.ts) and env bridging (string c.env values → process.env, without overwriting)
  ├─ 3. CORS for legacy /api/sync/*
  ├─ 4. Debug request logging
  ├─ 5. Public routes, before session middleware
  │   ├─ /p/:slug, /p/:slug/tree, /p/:slug/files/*      publications
  │   ├─ /s/:token, /s/:token/files/*                   private shares
  │   ├─ /r/{owner}/{repo}/…                            repository docs (own capability cookie; session only on a miss)
  │   ├─ /share/:token                                  legacy HMAC share links
  │   └─ /public/:org/:slug/*                           legacy public folders
  ├─ 6. Public static assets, before session middleware (explicit allowlist, `src/routes/public-assets.ts`)
  │   ├─ versioned bundles: /management-pages.js, /management-query.js, /select.js, /lazy-tree.js,
  │   │   /private-viewer.js, /commentor-parent.js, /commentor.js
  │   ├─ /favicon.svg, /favicon.ico, /landing-product.webp, /fonts/* (hashed fonts and licenses only)
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
  ├─ 15. GET * → shared 404 HTML (no ASSETS fallthrough)
  └─ 16. Error handler → generic JSON 500
```

`src/index.ts` is the Node.js entry for local development (`pnpm dev`, `pnpm start`). It mounts the same route groups from `src/app-routes.ts` and serves the same asset allowlist with `serveStatic` and the same headers.

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
| Landing, auth, account, other app HTML and ordinary 404s | `frame-ancestors 'none'`; `X-Frame-Options: DENY` | `default-src 'self'`; `script-src 'self' 'nonce-…' 'strict-dynamic'`; nonced style elements; no inline event handlers or eval; explicit font/image/connect sources below |
| Organization/project management HTML (`/organizations…`, except the docs shell) | Same deny policy | Same script policy; `style-src 'unsafe-inline'` because management navigation inserts each page's CSS at runtime |
| Docs shells (`…/docs`, `/docs/:org…`), publication shells (`/p/:slug`, `/public/:org/:slug`) | Same deny policy; `frame-src 'self'` permits their document iframe | Same script policy; nonced style elements plus the same-origin hashed base stylesheet (no CSS runtime, no CDN) |
| Private project HTML (`…/docs/files/*`, `…/docs/view/:ticket/files/*`) | `frame-ancestors 'self'`; `X-Frame-Options: SAMEORIGIN` | Preserve `sandbox allow-scripts allow-forms allow-popups allow-downloads` (no `allow-same-origin`); keep `no-referrer`, `private, no-store`, ticket base, renewal, and comments bridge |
| Publication/share HTML (`/p/:slug/files/*`, `/s/:token/files/*`, `/public/:org/:slug/files/*`, legacy `/share/:token`) | Same self-only framing | Opaque sandbox as above, without app resource restrictions or nonce rewriting; publisher scripts, styles, resource origins and base URLs remain publisher-controlled |
| Share shell (`/s/:token`) | Deny framing; `frame-src 'self'` | App policy with nonced scripts/styles; preserve `no-referrer` and private caching |
| Repository docs shell (`/r/{owner}/{repo}[/{ref}]`) | Deny framing; `frame-src 'self'` | App policy with nonced scripts/styles and `no-referrer`. The one trusted shell whose `Cache-Control` stays `private, no-cache` (revalidated on every navigation, so each gets a fresh nonce, but bfcache-eligible) |
| Repository document frames (`/r/…/files/*`, `/r/…/view/:ticket/files/*`) | `frame-ancestors 'self'`; `X-Frame-Options: SAMEORIGIN` | `sandbox allow-scripts allow-popups`, `default-src 'none'`, scripts only from `/private-viewer.js`, styles only from `/styles/`, images from self only (external images arrive through the signed image proxy, as under `RENDERED_DOCUMENT_POLICY`); content was sanitized at ingest, so this is defence in depth |
| Legacy authenticated documents (`/files/*` → `/docs/:org/:path`; frame `/legacy-view/:org/files/*`, assets `/legacy-view/:org/view/:ticket/files/*`) | Shell denies framing; document frames are self-only | Same opaque sandbox as project docs: `sandbox allow-scripts allow-forms allow-popups allow-downloads`, never `allow-same-origin`; private/no-store, no-referrer, ticket assets and parent comment bridge |
| JSON/API, redirects, and static/document assets | No added framing restriction | Baseline headers only; existing asset `default-src 'none'`, cache, CORS and cookie headers remain intact; no HTML policy is applied |

**Cross-origin isolation headers (#89).**

| Route class | `Cross-Origin-Opener-Policy` | `Cross-Origin-Resource-Policy` | Why |
|---|---|---|---|
| Top-level trusted HTML (every row above with `frame-ancestors 'none'`, including viewer, publication and share shells and the sign-out page) | `same-origin` | `same-origin` | The page gets its own browsing context group, so no cross-origin window it opened or was opened by keeps a handle to it. Nothing needs an opener: Google sign-in and account linking are full-page redirects, copying uses the clipboard, and comments use the document iframe's `postMessage` channel, which COOP does not affect. |
| Styled HTML errors on document routes | none | `same-origin` | They render inside the opaque viewer iframe, where COOP does not apply. |
| `/api/*` (JSON, redirects, preflights, errors) | none | `same-origin` | Refuses no-cors embedding of API data by other sites (`<script>`, `<img>`, `<link>`). CORS fetches, including the CLI and same-origin fetches, are unaffected. |
| Publisher documents (sandbox CSP) | none | none | Their origin is opaque: CORP would block their own no-cors subresources, and COOP on a document opened in a sandboxed popup would make the navigation fail. The sandbox policy is unchanged. |
| Static assets (`/*.js`, `/fonts/*`, `/styles/*`, favicons) and document assets | none | none | Opaque-origin viewer frames load `/private-viewer.js` and `/commentor.js` with no-cors `<script src>`. |
| Image proxy (`/img/<sig>/<url>`) | none | `cross-origin` | Opaque-origin viewer frames load proxied images with no-cors `<img>`; `same-origin` or `same-site` would block them. The bytes are public third-party images, behind a signature (see [Image proxy](#image-proxy)). |

A Rendro page opened from a publisher document's link (a sandboxed popup without `allow-popups-to-escape-sandbox`) now shows the browser's COOP error instead of running in an opaque origin, where its storage access already failed.

All trusted HTML uses `Cache-Control: no-store`: landing and anonymous pages, auth/account/invitation pages (including sign-in errors), organization/project management, legacy and modern docs shells, legacy and modern publication shells, share shells, and styled 404/410 pages. Existing private policies retain `private, no-store`. No shell uses a hash-based cache exception; publication shells deliberately give up public revalidation caching so each navigation receives a fresh nonce. Successful publisher documents, publication tree/sitemap responses, and static/document assets retain their existing cache policies and receive no app nonces. The legacy starter document stored during org creation also has no request nonce.

Styled HTML errors on document URLs use the trusted nonce policy, with self-only framing so they remain visible in the owning viewer; successful publisher documents retain their sandbox policies.

Trusted HTML policies also use `object-src 'none'`, `base-uri 'self'`, and `form-action 'self' https://accounts.google.com`. The sign-in UI calls the same-origin Better Auth proxy and navigates to Google's returned OAuth URL; this policy does not restrict top-level navigation. `connect-src` permits self, the exact configured `CONVEX_URL` and `CONVEX_SITE_URL` HTTP(S) origins, and the corresponding WS(S) origin for `CONVEX_URL`. Local Convex HTTP/WS URLs work without production-wide wildcard allowances. Fonts and the viewer base stylesheet are self-hosted: `script-src` and `style-src` have no third-party origin and `font-src` is exactly `'self'`; images allow self, data URLs and `lh3.googleusercontent.com`.

**Inline allowances:** scripts never use `'unsafe-inline'`, `'unsafe-eval'`, or `'unsafe-hashes'`. Trusted templates explicitly emit a cryptographically random 144-bit nonce from request-local async context; responses are not scanned to authorize arbitrary script tags, and publisher HTML is not rewritten. `'strict-dynamic'` lets nonced scripts load further scripts and makes CSP3 browsers ignore `'self'`, which stays only as the fallback for browsers without `'strict-dynamic'`. So every parser-inserted `<script>` and every `<link rel="preload" as="script">` in trusted HTML carries the nonce, including the management shell's `select.js`, `management-query.js` and `management-pages.js`. Management's fetched-page fallback applies the **active document's** nonce when executing its validated controller, rather than the next response's nonce. Landing, auth, viewer, publication and share-shell style blocks are nonced. `style-src 'unsafe-inline'` is limited to management shells because their navigation inserts page style elements. `style-src-attr 'unsafe-inline'` supports existing authored attributes and interactive sizing/loading behavior on app pages. Publisher sandbox policies deliberately do not impose script/style source lists, so user-authored HTML continues to work in its isolated origin.

`tests/security-headers.test.ts` covers route policies, nonce isolation, HTTPS detection, existing private protections and non-HTML responses. `tests/security-headers-browser.test.ts` runs Chromium against actual Worker routes on an isolated local server, with fixture auth/storage/comment backends, a `securitypolicyviolation` listener in every frame and CSP console checks. It exercises landing, sign-in errors and auth error redirects, email verification, ordinary and share 404/410s, `/docs/:org` 404s, management navigation, ticket-backed CSS and the real comments postMessage host/widget. The suite uses the shared offline Chromium harness and runs in the serialized browser project included by `pnpm verify` (see [Chromium tests](BROWSER_TESTS.md)). Font responses are deterministic fixtures; any external request, including a CSS CDN, fails the suite. The former `CSP_SMOKE_EXTERNAL` switch is no longer supported by this offline suite. It does not perform a live Google login or contact production Convex.

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

**Well-formed text.** JSON can carry an unpaired UTF-16 surrogate only as an escape such as `\ud800` (raw invalid UTF-8 bytes decode to U+FFFD). The backend cannot store such a string, so it used to fail as an opaque 500/502. `shared/text-input.ts` (`requireWellFormedBody`) now rejects it at the body-admission step, after the size cap: the Worker's `bodyAdmission` middleware covers every Worker mutation (including Better Auth, deployment and publication routes) and the shared Convex `httpAction` wrapper covers every registered HTTP action, including Better Auth, so a direct Convex call is protected too. A cheap escape-sequence check gates a full parse, and the walk over keys and values is iterative. Refusal is `400 {"error":"Request text must be well-formed Unicode"}`, before authentication, rate limiting and any other handler work, like the size cap. Every user-supplied JSON text field is covered at once: project name/slug, API key name and scope names, publication slug/path/entry file/title/description/pinned deployment, share document path, deployment manifest paths, provenance labels, organization and team names, and every Better Auth field (user name, email, metadata). Query strings and path parameters are normalized by the URL parser and never ill-formed. Convex RPC arguments (comments) are not HTTP actions and are outside this check; their bodies are length-limited where stored.

**Text length limits** (UTF-16 code units of the trimmed value, matching the forms' `maxlength`), enforced where the value is stored so every caller is covered: organization name 80 and slug 48; team name 80; project name 80 and slug 48; API key name 80; publication slug 80, title 100 and description 500; comment body 10,000. A name that is blank after trimming is refused for organizations, teams and projects. Organization names are checked by the Better Auth organization hooks (`INVALID_ORGANIZATION_NAME`, "Organization name must be 1–80 characters"); like slugs, an organization whose stored name predates the rule keeps working and may resubmit it unchanged. Publication limits fail with 400 `Publication title must be at most 100 characters` / `Publication description must be at most 500 characters`.

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
manifest GET, one R2 list (1,000 keys), and the attested Convex commit. Listings are
additionally bounded to **8 pages and 1,000 keys**, failing closed without activation
on overflow; short or repeated continuation pages cannot loop indefinitely. Sorting,
path comparisons and manifest hashing therefore operate on bounded inputs. With
three attempts for each of the nine possible R2 reads plus two Convex calls, the
worst configured commit budget is **29 external requests**, leaving room below
Workers' 50-request Free-plan subrequest ceiling. Cloudflare's Paid default is
10,000; both plans have 128 MB memory. These are subrequest budgets, not a promise
that crypto work fits the Free plan's 10 ms CPU allowance; production should
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

Convex is authoritative: `convex/apiKeyHttp.ts` wraps credential validation, every deployment action (start, active, staging, commit, fail, list), and publication create/list/remove. Limiting runs before body parsing or business logic, so malformed requests also count. The body-size cap and the well-formed-text check (see [Request and deployment resource limits](#request-and-deployment-resource-limits)) are the exception: they run first, in the shared wrapper, and a request they refuse is not charged. A read-only hash lookup (`verifiedIdInternal`) returns the credential ID and stored `expiresAt` for a non-revoked key in a live organization, and the wrapper treats a key at or past that deadline as unverified (failed-IP budget); a shared token bucket uses the credential's database ID, never a raw key or caller-selected tenant/scope. Scope, project, organization, expiry and revocation authorization still run for each operation. Failed operations consume capacity too; cookie-only session routes retain their session authorization path.

The official `@convex-dev/rate-limiter` component provides persisted, transactional token buckets across Convex instances. There was no application-level limiter to reuse; Better Auth's database limiter covers only `/api/auth/*`. Version 0.3.2 is pinned because it supports the existing Convex 1.42 dependency, avoiding an unrelated backend upgrade. The component is registered in `convex/convex.config.ts`; **Convex deploy required** when releasing this change.

- **Verified credential:** refill 6,000 requests/minute (100/second), capacity 12,000. API-key actions share this credential budget across projects and IPs, except failure cleanup. Following the component's contention guidance, 50 shards split the total rate and capacity (2 requests/second and 240 burst tokens each); two-choice shard selection may reject near exhaustion before every token is spent.
- **Failure cleanup (`/deployments/fail`):** a separate per-credential bucket refills 60 requests/minute with capacity 20, so exhausted upload budgets cannot block retention cleanup. Scope and tenant checks still apply.
- **Invalid, expired, revoked, malformed or missing key on key-required routes:** refill 120 requests/minute (2/second), capacity 240 per verified IP. Invalid Authorization on session-capable routes also counts. IPs come only from #29's method/path/query-bound signed ingress metadata, verified using `CONVEX_INTERNAL_SECRET`. Deployment and publication Worker handlers sign their rewritten backend target/method, including staging reads for PUT uploads. Direct callers, absent secrets and invalid/stale signatures share one `unverified` bucket; raw forwarding headers cannot select a bucket. Valid credentials use their own budgets even when their IP's failed-attempt budget is exhausted. A verified key with insufficient scope/tenant access still consumes its credential budget. Each failed-key attempt atomically updates an expiry registry with its component debit. An hourly cron resets buckets inactive for at least an hour (well beyond the two-minute full refill), deleting registry and component rows together in batches of 100 with scheduled continuations. Concurrent reuse conflicts with cleanup in the same transaction, preserving active budgets.

Request accounting from `cli/src/index.ts` and `src/routes/deployments.ts`: with C changed files and U reused files, a successful push makes **C + ceil(U / 16) + 3 Worker requests**, and **2C + 2 ceil(U / 16) + 4 Convex HTTP actions**. The fixed cost is active check, start, staging check at commit, and commit; each changed file and each 16-file copy batch adds an initial staging authorization plus a fresh authorization immediately before storage dispatch. An upload still receiving its body renews at most once every ten minutes, with a two-hour total transfer deadline; renewal failures cancel the body read. These additional renewal actions count against the same credential budget. Failure cleanup adds one action; publication creation adds two (deployment read + publication write). Default upload concurrency is eight. At the 1,000-file deployment limit, a cold push costs 2,004 tokens within the 12,000-token burst budget; a 50-changed/950-reused push costs 224 tokens. The CLI honors bounded 429 retry delays. Sustained requests replenish at 100/second. These are application request limits, not file-size or storage-work quotas.

Exhaustion returns `429`, `Retry-After` rounded up to whole seconds (minimum one), and `{ "error": "Rate limit exceeded", "code": "rate_limited" }`. Worker proxies preserve the status/body/header. This is an explicit error class in `httpErrors.ts`; unexpected limiter/backend faults remain sanitized 500s (502 through the Worker). Rate-limit responses do not log secrets, keys, request bodies or IPs.

The CLI reports `429 Rate limited. Retry after Ns.` It retries 429, 500, 502, 503 and 504 responses and dropped connections for reads, same-byte file PUTs, copies of immutable manifest files to the same staging keys, and idempotent failure cleanup; the rate-limit message names the cause (`Rate limited (429)`, `Server error (503)`, `Network error`). The deployment routes answer a transient storage fault (a throttled or 5xx object-store reply, a timeout, a dropped connection; see `src/storage-fault.ts`) with `503 { "error": "Storage temporarily unavailable", "retryable": true }` and `Retry-After: 1`, logging only the fixed category, fault kind and storage status; every storage write on those routes targets a fixed key with manifest-checked bytes, so replaying it is safe. A storage denial or an unrecognised exception stays `500`. The local E2E runtime (Miniflare in front of workerd) can additionally lose a connection before the Worker runs and answer `500 text/plain "Error: Network connection lost."`; production has no such hop, but the same replay covers it. Up to three retries use exponential delays (1, 2, 4 seconds), honor the greater `Retry-After` seconds/date value, and add 0–249ms jitter. A wait over 60 seconds stops with the rate-limit message. If failure cleanup remains rejected, the CLI exits non-zero and reports both the original deployment error and the cleanup failure, identifying the deployment that may remain staging. Start, commit and publication mutations are not automatically replayed; none of their 5xx responses or transport errors is retried. Start creates a new deployment and commit changes the active pointer, so their outcomes must not be guessed after an ambiguous response.

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

### CLI endpoint safety and dry run

`cli/src/endpoint.ts` validates `--endpoint` for `push` and every `publication` action before any file is read or
request is sent. The bearer API key must not cross a plaintext link, so only `https:` URLs and `http:` URLs whose
host is exactly `localhost`, `127.0.0.1` or `[::1]` pass; other schemes, other `http:` hosts and unparseable
values fail with exit code 1. Errors name the scheme and host but never echo the raw value (it can embed credentials).
`push --dry-run` runs the same source selection, path and size validation and prints `path  size B` per file
plus a total, then returns before provenance collection or any request; it requires neither identity nor key.

### CLI source selection and encoding

`cli/src/source-files.ts` filters before hashing or uploading, with zero runtime
dependencies. The case-insensitive sensitive defaults at every depth are `.env`,
`.env.*`, `.envrc`, `.envrc.*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`,
`.htpasswd`, `.pgpass`, `.dockercfg`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`,
`*.keystore`, `*.ppk`, `*.tfstate`, `*.tfvars`, `id_*`, `credentials[.json|yml|yaml|toml|ini|csv|xml]`
and `secret(s).json|yml|yaml|toml|ini`. `--include-sensitive` overrides only these filename
defaults; `sourceFiles` reports each included sensitive file through a callback and `push`
prints a stderr warning listing them. Dot-directories stay excluded by default, including under that flag; an
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

Static secrets and stored random tokens are compared with `constantTimeEqual` / `bearerMatches` from `shared/constant-time.ts` (no early exit on the first differing byte, length folded into the result, runs in Convex, Workers and Node): the `RETENTION_SECRET` and `MIGRATION_SECRET` bearers, `requireInternalSecret` (`CONVEX_INTERNAL_SECRET`), the deployment purge claim token, and the share-link HMAC check. HMAC proofs verified with WebCrypto `verify` (resolver, ingress-IP and storage attestations) are already constant-time. Do not compare secrets with `===`.

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

The project and publication viewers share `renderScopedDocumentShell()` in `src/routes/app.ts`. The project shell resolves the active deployment through Convex with the session cookie, looks up `?doc=` or `index.html` in the deployment index (falling back to the first HTML file), and validates that the selection is an HTML manifest entry. Unknown paths return the shared 404 page. A signed-out request redirects to `/sign-in?returnTo=<…/docs>` and keeps the reader's selection: `doc` when it is a canonical document path and `docQuery` when it is a valid publisher query (`?` first, no fragment, at most 4,096 characters); every other parameter is dropped. The sign-in page then accepts only a rooted single-slash path without backslashes or control characters as `returnTo`, so an absolute URL, `//host`, a backslash variant or an encoded form of either falls back to `/`. A `#fragment` never reaches the server and is not carried.

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

HTML encoding follows the actual byte path. Legacy public/share HTML (`/public/…`, `/share/:token`) is fully decoded as UTF-8 before injection and emitted as UTF-8, so non-UTF-8 source bytes on those two paths still become replacement characters; both buffered paths explicitly declare `text/html; charset=utf-8`. Public publication (`/p/…`), private project, modern share, and legacy private viewers use a byte-preserving prefix injector (public publications moved to it in #94, so their non-UTF-8 documents now keep their bytes and stored charset instead of being re-encoded): it parses a bounded UTF-8 prefix, inserts markup only at a safe boundary, and passes an invalid UTF-8 prefix through unchanged. Those responses retain a validated stored charset or its absence, preserving non-UTF-8 rendering and in-band encoding declarations rather than relabeling original bytes. HTML classification uses exact normalized types, including tree/shell selection, rather than a case-sensitive prefix. Font extensions are case-insensitive and override older manifest MIME values: `.woff2` → `font/woff2`, `.woff` → `font/woff`, `.ttf` → `font/ttf`, `.otf` → `font/otf`, and `.eot` → `application/vnd.ms-fontobject`. Modern shares authorize assets by manifest media type and use the same stored charset rule. Existing deployments do not need republishing.

Sandbox asset failures identified by image/font/CSS/JavaScript Accept types or extensions use an empty, untyped response without CORS, preserving their status and access checks while avoiding Chromium opaque-response blocking. HTML failures retain styled, nonce-protected app error pages; no capability URLs are echoed in asset errors.

Moving all publisher content to a separate **cookieless origin** remains the longer-term architectural follow-up. This change enforces the current response/iframe sandbox boundary without changing hosting or deployment topology.

After their existing access checks, public and share files send the fixed `Access-Control-Allow-Origin: null`, matching ticket-authorized private files. All three publisher documents have an opaque sandbox origin. The fixed allowance serves this origin without extending CORS reads to every website origin (`*`) or reflecting caller input. Shares remain token-scoped and `private, no-store`; public files retain public revalidation caching. CORS is not authorization: any opaque origin that possesses a share/ticket URL can use that capability, subject to the existing revocation, scope, session, and membership checks. Cookie-authenticated canonical private file URLs still send **no** CORS allowance; private relative resources must use the injected ticket base. No viewer file response enables `Access-Control-Allow-Credentials`.

The allowance applies uniformly to font requests, `<img crossorigin="anonymous">`, `<script type="module">`, and ordinary publisher `fetch()` GETs, including HTML reads within the route's existing scope. Opaque-origin requests must be non-credentialed (default same-origin credentials or explicit `credentials: "omit"`). Credentialed cross-origin reads and preflight-requiring methods/custom headers remain unsupported; these read-only routes do not add OPTIONS handlers or expose application APIs. Root-relative/external resources remain subject to their destination's CORS policy; private publisher fetches should resolve relative paths against the current `document.baseURI` to inherit the ticket. The CORS allowance does not relax the response sandbox, referrer policy, or access validation.

`tests/publisher-isolation.test.ts` exercises the full Worker media-type matrix across all eight delivery endpoints, including denied/missing controls. `tests/publisher-isolation-browser.test.ts` verifies direct SVG origin/API/cookie isolation, share-frame navigation isolation, and HTML/CSS/image/font rendering in Chromium. `tests/publisher-charset.test.ts` covers encoding labels, malformed/duplicate parameters, stored-with/without-charset cases, main’s extension defaults and buffered/streamed HTML byte-path parity; `tests/publisher-charset-browser.test.ts` verifies a Windows-1252 non-ASCII CSS selector through all six metadata-aware delivery paths and non-UTF-8 HTML rendering through the share and four private streaming paths (public publications use the same byte-preserving injector), each with either an explicit stored charset or an in-band declaration and no stored charset. The tests check raw bytes, exact Content-Type, rendered styles/text and opaque origins. `tests/viewer-asset-headers.test.ts` covers every font MIME across public/share/private-ticket/private-cookie routes, other CORS resources, fixed origins, and denied responses. `tests/viewer-fonts-browser.test.ts` uses the shared isolated Chromium harness, real viewer routes/shells and a local original font fixture to verify loaded font faces, anonymous images, modules and fetches in all three opaque viewers without CORS errors or subresource cookies.


### Unavailable is not missing (#216, UI-006-E04)

Every delivery surface separates "definitely not there" from "could not check". A **404** is only for what an authoritative source reported absent or denied: a Convex denial (401/403/404 or no deployment), a forged or expired ticket, a path the manifest does not list, or an object storage answers 404 for. Anything else on the way to the bytes is a **503 with `Retry-After`** and `Cache-Control: private, no-store`: a Convex 5xx, timeout (five seconds including body reads), transport error or malformed answer; a storage error that `transientStorageFault` (`src/storage-fault.ts`, shared with the deployment routes) classifies as transient (throttling, 5xx, timeout, dropped connection); and a manifest that storage lacks or that cannot be parsed for a deployment Convex just authorized (`openDeploymentIndex`/`deploymentDocuments` in read mode throw `ViewerBackendError`; staging still answers `null`).

One helper builds the response, `unavailableResponse` in `src/routes/viewer-unavailable.ts`: HTML navigations get the retry page (`renderSessionUnavailablePage`, subject "document" or "session"; a "Try again" link back to the same URL), tree pages and ticket renewals get `{ "error": "Document temporarily unavailable", "retryable": true }`, and plain assets (images, fonts, stylesheets, scripts) get an empty untyped body so no loader or ORB misreads an error as content. `viewerErrorResponse` is the `onError` handler of `/p/*`, `/s/*`, the project `…/docs/*` routes and `/legacy-view/*`, so a transient failure that nothing handled earlier ends in the same response instead of a generic 500. Anything else (a code defect, a 403 from storage) stays an internal 500 with no retry hint, as on the deployment routes. It logs only the route template and the fault enumerations. Inside the private viewer frame the retry link cannot carry the session cookie (a click from the sandboxed frame is cross-site), so on cookie-authenticated document URLs the page posts `doc-retry` to the shell, which reloads the frame from its own `src`. Legacy `/public/…` and `/share/:token` keep their JSON envelope for scripts and give browsers the retry page. The session middleware answers an outage during a cookie-authenticated document or asset read with the same plain asset 503.

Storage reads (`getObjectStream`, `getObjectText`) give up after `STORAGE_READ_TIMEOUT_MS` (ten seconds in all, replays included, thrown as a `TimeoutError`; for streams, the deadline covers the response headers) so a stalled store becomes this 503 rather than a hung request. The R2 binding cannot cancel an operation already started, so the read is abandoned rather than aborted. Writes and listings keep their own lease and budget handling.

No new existence signal: the 503 can only follow authorization (private routes, share and publication resolution all run first), or a failure of that very lookup, before anything is known about the resource. A denied request is still a plain 404 with no validators or `Retry-After`, even while storage is failing, and an unlisted path is a 404 because the manifest decides absence. The retry page is frame-aware: inside a viewer frame its wordmark is hidden and the parent supplies the theme (as for the not-found page); top-level it shows the wordmark. `tests/backend-unavailable.test.ts` covers each surface; `e2e/backend-unavailable.spec.ts` injects storage and Convex outages into the real Worker (`e2e/faults.ts`) and drives the recovery click in all three engines.

### Conditional and ranged delivery (#94)

`src/routes/object-delivery.ts` (`serveObject`) answers every modern and legacy-private byte route after that route's authorization, manifest lookup and canonical-path checks, and before storage is read: `/p/:slug/files/*`, `/s/:token/files/*`, `…/docs/files/*`, `…/docs/view/:ticket/files/*` and the two `/legacy-view/…` forms. Legacy `/public/…` and `/share/:token` buffer and rewrite HTML only and have no validators or ranges. Nothing here changes *whether* a caller may read a file: a denial is the route's ordinary 404/503, so a validator or `Range` can never confirm that a resource exists to someone who may not read it.

Order, as in RFC 9110 §13.2.2: `If-None-Match` → 304; `Range` (GET only, and only when `If-Range` allows it) → 416 or 206; otherwise 200. HEAD reuses GET's headers and reads no bytes from storage; it ignores `Range`.

| Representation | `ETag` | `Accept-Ranges` | `Content-Length` (HEAD, 416; GET where the runtime keeps it) | Range |
| --- | --- | --- | --- | --- |
| Stored asset (non-HTML, or any entry the route does not rewrite) | `"sha256-<manifest sha256>"`, strong, derived without reading bytes; legacy-private objects use `"s3-<store ETag>"` from the HEAD already made | `bytes` | stored size | 206/416 |
| Public publication HTML | `"sha256-<source>-i<injector version>-<hash of the injected markup>"`, strong for the exact rewritten bytes | `none` | omitted | ignored, 200 |
| Private project, share, legacy-private HTML | none (the injected ticket/token makes bytes differ per reader) | `none` | omitted | ignored, 200 |
| Entry of an old manifest without a valid hash/size | none | omitted | omitted | ignored, 200 |

The HTML injectors rewrite the stream, so those bodies are never byte-ranged (`Accept-Ranges: none`; `Range`/`If-Range` are ignored and the whole document is returned with 200). Bump `HEAD_INJECTION_VERSION` in `src/routes/document-html.ts` when an injector changes its output for the same input, since it is part of the public HTML validator.

`If-None-Match` follows the weak comparison of RFC 9110: lists, `W/"…"` members and `*` are accepted, malformed members are skipped, and a header longer than 2 KiB never matches (the request gets a full 200). `*` is satisfied by any authorized current representation. `If-Range` needs a strong entity-tag equal to the current `ETag`; a weak tag, a date (no `Last-Modified` is sent) or a stale tag restores the full 200. `If-Match`, `If-Modified-Since` and `If-Unmodified-Since` are not evaluated.

`Range` accepts exactly one `bytes` range (`a-b`, `a-`, `-n`; the unit is case-insensitive). A valid but unsatisfiable range (`start ≥ size`, `-0`, any range of an empty object) is `416` with `Content-Range: bytes */size`. Syntactically invalid headers, other units, headers over 128 bytes, and multi-range requests are ignored and answered with the full `200` (RFC 9110 permits ignoring `Range`; multi-range is deliberately not a 416 or `multipart/byteranges`, so a hostile list costs one length check). Positions are clamped, so overflowing digit strings behave as "past EOF" (416) or "to the end" (206) and never lose precision. The size comes from the manifest; `getObjectStream(key, range)` issues a ranged R2 `get` and fails closed if the store ignores the range or reports a different slice or total length.

Every response shape (200, 206, 304, 416, HEAD) carries the same `Content-Type` (including the validated charset), `X-Content-Type-Options: nosniff`, sandbox CSP, `Cache-Control`, `Referrer-Policy`, opaque-origin CORS header and `ETag`; `Content-Length` is omitted on 304. workerd sends streamed 200/206 bodies with chunked framing and drops a handler-set `Content-Length` (HEAD and 416 keep it), so clients size a download from `Content-Range` and HEAD. Cache policy per route class is unchanged: public publication files `public, max-age=0, must-revalidate`; share, project, ticket and legacy-private files `private, no-store` (the validator saves bandwidth for clients that revalidate; it does not make those responses cacheable). Client-error statuses on `/p/*` and `/s/*` (including 416) are rewritten to `private, no-store` by the viewer error policy, so a 416 is never cached. No `Vary` is sent today because the representation does not depend on request headers (Cloudflare adds `Vary: Accept-Encoding` and may weaken strong tags when it compresses text; ranged 206 responses are not compressed).

A 304 or HEAD does not read storage, so for an object the manifest lists but storage has lost they report the manifest's view; a full or ranged `GET` still returns the ordinary 404 for it.

`tests/object-delivery.test.ts` tables the Range/If-None-Match grammar (overflowing positions, past-EOF, many ranges, lists, `*`, weak and malformed validators, non-terminating-input guards). `tests/document-conditional-delivery.test.ts` runs the real Worker over all six route classes: header tables for 200/206/304/416/HEAD, ranged storage reads, If-Range, revoked membership/publication/share answered 404 before any validator, injected-HTML validators, and a delayed-tail multi-megabyte public HTML stream that must emit its injected head before the tail is available with bounded read-ahead. `e2e/document-delivery.spec.ts` repeats the matrix on workerd with Miniflare R2 storage, including 2 MiB range reassembly and manual conditional requests (the E2E harness's request interception disables the browser HTTP cache, so revalidation is asserted on headers and bytes).

### Private viewer asset authorization

The project iframe remains an **opaque-origin sandbox**, both in the shell attribute and the HTML response CSP. It never gets `allow-same-origin`; Better Auth's SameSite cookie policy is unchanged. The trusted parent can initiate a cookie-authenticated document navigation, but requests made by the sandbox itself cannot depend on that cookie.

The server uses a dedicated parser-based streaming injector to establish the ticket `<base>` before publisher resources, including documents with an implicit head, omitted head/body tags, or a doctype/comment prelude. The cosmetic head injector keeps its existing behavior. It points at `…/docs/view/<ticket>/files/<document-path>`. Relative stylesheets, images, scripts, CSS `@import`, nested CSS `url()`, and fonts therefore inherit the ticket prefix. The iframe's canonical `src` remains `…/docs/files/<document-path>` so the tree, deep links, and parent-mediated comments retain their existing document identity. Same-document fragment links stay in the current frame. Public publications and private-share routes use their existing access models.

- **Ticket:** a randomized, authenticated-encrypted JWE (`dir` / `A256GCM`), valid for 15 minutes. A domain-separated SHA-256 key is derived from the Worker's existing `AUTH_SECRET`; rotating that secret invalidates outstanding viewer tickets. The encrypted payload binds the organization, project, active manifest, the signed session-token cookie, and any legacy `dont_remember` marker, which Convex replaces with the session's persisted lifetime choice. No readable session material, API key, or cached session-data cookie is exposed to publisher code.
- **Every request:** decrypt and validate the ticket, then ask Convex for the active deployment using the recovered session-token cookie. Convex freshly checks the persisted session, organization membership, and project ownership. The active manifest must still match the ticket, and the requested path must appear in that manifest before R2 is read. There is no authorization cache. Session revocation, membership removal, or changing the active deployment denies subsequent requests; already-rendered bytes cannot be recalled.
- **Responses:** private assets and renewal responses are `private, no-store` with `Referrer-Policy: no-referrer`. Ticket-authorized responses permit `Access-Control-Allow-Origin: null` for opaque-origin fonts/modules, without credentialed CORS. The ticket is a scoped read capability, not a session replacement or permission to call application/comment APIs.
- **Renewal:** `private-viewer.js` asks the trusted parent for a replacement after five minutes, checking once a minute and on focus, visibility, pageshow, or resource errors. A hidden document (`document.visibilityState === "hidden"`) holds no heartbeat timer and sends no renewal: the interval is cleared when the tab is hidden and restarted when it is shown, and a pageshow, focus or resource error that arrives while hidden is deferred, a resource error as a forced renewal. On return the client renews at once when the ticket is five or more minutes old (the 15-minute ticket may then be near expiry or already expired, which is why wall-clock age decides, not timer ticks) or a resource failed meanwhile, and otherwise leaves the next heartbeat to the restarted interval. The 30-second spacing between requests and the parent's 30-second budget still apply. An hour hidden costs no renewal requests, against twelve for a visible tab, plus the one on return. The parent accepts messages only from its current opaque content frame and calls cookie-authenticated `…/docs/viewer-ticket?manifestKey=…`. A ticket cannot renew itself. New URLs replace the base and current image/media/stylesheet URLs in place. CSS Syntax tokenization resolves scoped `url()` values (quoted, unquoted, and escaped), string candidates in `image-set()` / `-webkit-image-set()`, `src()` strings, and `@import` strings in inline styles and `<style>` blocks to explicit renewed URLs; Chromium otherwise retains the old base in parsed CSS. URL tokens are handled across properties, including font sources (preserving `format()`), cursor, masks, list/border images, and generated content. Fragment-only references such as `filter: url(#id)` and data/blob/absolute/protocol-relative publisher URLs remain unchanged; only absolute CSS URLs previously emitted by the renewal client are renewed again. For each scoped stylesheet link, an adjacent clone retains the same attributes/media and cascade position while loading the renewed `href`. The active sheet is removed only after the replacement loads; a failed replacement is discarded and retried on a later renewal with exponential backoff (one minute, capped at fifteen). Per-link serialization coalesces overlapping renewals to the latest ticket, keeping at most one pending clone per active sheet. Reloading the parent reloads its `@import` graph, including nested imports; the link load event waits for these sheets, and nested CSS/image/font URLs inherit the new ticket. This keeps deferred resources working without reloading the document or losing comment drafts. Resuming a suspended tab can briefly fail a resource before renewal retries it. Offline, revoked, and expired-session viewers fail closed; reload the shell after signing in again. Superseded deployments also fail closed: after fresh session, membership and project authorization, renewal for a different project-scoped manifest returns `409 { code: "deployment_superseded" }` without issuing a ticket. The trusted shell announces "A newer version of this document was published." with a non-blocking Reload button. Renewal heartbeats and resource-error-triggered renewals both detect this state. Reload is user-initiated and preserves the entire current shell URL (document path, publisher query and fragment), along with the existing user/document-scoped sessionStorage comment drafts and pending operation identities. Stale responses after frame navigation are ignored; there is no automatic reload loop. The comment bridge’s `commentor-viewer-reload` message is also only a request for this parent-owned notice: publisher code and the widget share an opaque frame, so neither the sender nor claimed user activation authorizes navigation. Repeated requests leave the visible notice and its polite announcement unchanged. Private and legacy private shells provide the Reload control; share and public shells ignore this message. Widget-version recovery first offers the notice, then waits for the reader’s parent-side Reload.

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
  │   ├─ doc-external → parent confirmation → window.open(href, "_blank", "noopener,noreferrer")
  │   ├─ doc-loaded → acknowledge expected path (no navigation or tree fetch)
  │   ├─ doc-pointer → (inline shell script) close the account and More menus; carries no data
  │   └─ shell-toggle → Ctrl/Cmd+Shift+H inside the iframe toggles the shell
  └─ popstate / initial URL → loadDoc(path)
```

The script URLs carry `?v=` versions from the asset-version ledger (see "Public static assets"); read the current values in `src/routes/versioned-bundles.ts` rather than copying them.

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

A link to another site (an absolute `http(s)` address on a different origin, in a scoped, legacy or share viewer
frame) never loads in the sandboxed frame, which the shell's frame policy would refuse. The frame cancels the click
and sends `doc-external` with the resolved address; standalone documents, `mailto:` and script URLs keep
native behavior. The parent (the project and publication shells in `lazy-tree.ts`, the share shell in
`installShareFragments`) re-validates the address (a string of at most 2,048 characters, `http(s)`, not its own
origin) and offers it through the same bounded confirmation as a document: one visible prompt that is never
retargeted, one silently replaced pending address while dismissed, and a parent-owned "Review external link"
button. The label is assigned with `textContent`. Only the reader's "Open external link" press opens it, with
`window.open(href, "_blank", "noopener,noreferrer")`, so the other site gets a new tab with no handle back to the
viewer and the document, its history and its selection stay where they were. The sandbox is unchanged, and so is a
share's grant: the share shell accepts `doc-external` only from its own frame (`event.source`, opaque `"null"`
origin, the granted document path) and never navigates to anything else. The prompt itself is one component,
`createNavigationNotice()` in `src/viewer/navigation-notice.ts` (state machine in `navigation-confirmation.ts`), used by
`lazy-tree.ts` and the share shell; each shell supplies its own `.document-navigation-notice` and `.load-more-btn` styles.

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

### In-Shell Navigation and Prefetch

The repository shell (`/r/…`) keeps navigation inside the shell and makes a likely next document ready before the reader clicks (#245):

- The shell advertises same-origin Speculation Rules through a `Speculation-Rules` response header pointing at `/speculation-rules/repo.json` (never an inline `<script type="speculationrules">`, which the nonce CSP would not allow). Chromium prefetches the frame documents the sidebar links to (`/r/*/@*/files/*`, excluding `/r/*/@*/view/*`) with `eagerness: "moderate"`; other engines ignore the header.
- Independently, `lazy-tree.js` warms a hidden frame on `pointerover`/`focusin` of a `target="content-frame"` tree link, gated on a repository read path (`data-document-base`), a same-origin frame document, and a connection that is neither Save-Data nor slow (`navigator.connection`).
- A shell `fetch()` cannot warm the opaque sandboxed frame: the HTTP cache is partitioned by the frame's opaque origin, so the prefetch must load a real frame carrying the content frame's `sandbox` attribute.
- Preloads are **hidden sibling frames in the content area, never moved**. Moving an iframe to a new parent — even a `replaceWith` in the same task — discards its browsing context in Chromium and re-requests the document. The pool keeps at most three buffers as absolute, invisible siblings; adopting one toggles visibility and identity in place, so the browsing context and the painted document survive with no second request.
- Readiness is the frame's own `doc-loaded` announcement, not its `load` event: an aborted subframe navigation still fires `load` on Chromium's error page, so silence is the only failure signal. A preload that has not spoken is cancelled rather than adopted, and the click loads normally.
- The reveal runs inside `document.startViewTransition` so the old and new documents cross-fade instead of flashing, unless the reader prefers reduced motion or the API is absent. Either way a `rendro:frame-switch` `performance.measure` records the switch (the target is under 200 ms for a warmed frame).
- After a reveal the private viewer is asked to redeploy in its new cell (`viewer-identify`); the shell re-sends the fragment and settles the loader exactly as a fresh load does.

### Sticky Headers (CSS)

```css
.tree-folder.open > .tree-item {
  position: sticky;
  top: calc(var(--depth) * 30px);  /* 0px, 30px, 60px... */
  z-index: calc(10 - var(--depth)); /* 10, 9, 8... */
  background: var(--sidebar-bg);
}
.tree-folder.open > .tree-folder-collapse > .tree-folder-content {
  overflow: visible; /* unblock sticky positioning */
}
```

Zero JavaScript. Multiple open folders stack with increasing top offset.

A folder's rows sit in `.tree-folder-content` inside `.tree-folder-collapse`. The wrapper is a grid whose single row animates `0fr → 1fr` (with opacity), so an open folder is exactly as tall as its loaded rows, however many Load-more pages it holds, and nothing is drawn over the rows after it. A closed folder's wrapper carries `inert` (set when the folder is rendered, removed when it opens, set again when it closes), so its rows are skipped by Tab and left out of the accessibility tree; `aria-expanded` on the folder row still announces the state. Reduced motion removes the transition.

---

## Inline Comments

Project documentation uses an opaque, publisher-controlled sandboxed iframe. (Repository docs reuse the same widget and protocol with their own anchors and authorization: [Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6).) The trusted parent shell (`public/commentor-parent.js`, built from `src/commentor/parent-entry.ts`) fetches a short-lived Convex JWT from `/api/auth/convex/token`, owns the authenticated Convex client, and holds the real-time subscription.

```text
publisher iframe -> scoped messages -> trusted parent shell -> authenticated Convex
publisher iframe <- scoped results  <- trusted parent shell <- reactive pages
```

The parent's Convex client refreshes its JWT shortly before it expires (`forceRefreshToken`); each refresh confirms the identity first (`/api/auth/get-session`) and then asks `/api/auth/convex/token`. While the tab is hidden (`document.visibilityState`) that refresh is held, not dropped: the host (and the widget's direct client for legacy documents) waits for the next `visibilitychange` to visible before running it, so an hour hidden issues no identity or token requests and the client resumes with one pair on return. The identity check, sign-out and BFCache restore checks are unchanged, and a refresh held across sign-out or disposal hands the client nothing.

The iframe receives only document-scoped comment data and operation results, never a JWT or session credential. The parent derives organization, project, and document from its trusted configuration and frame URL, allowlists comment operations, and confines thread mutations to that document. Server-side membership and thread ownership checks in `convex/documentThreads.ts` and `convex/documentReplies.ts` remain authoritative. Author fields come from the authenticated identity.

Convex delivers the reactive snapshot that contains a new comment or reply before the mutation's acknowledgement, so the widget treats either order as normal. Closing the composer returns focus to the control that opened it even when the snapshot closes the composer first, and a sent reply keeps keyboard focus in its (possibly re-rendered) reply box. A rendered action whose write is still outstanding stays disabled across re-renders. Threads and replies both show their age (`timeAgo`) in a `.when` span. The drawer list is rebuilt on every update, so the widget records the reader's place first and restores it: a reader already at the end follows a newly arrived last comment (as in a chat, so no "N new comments" prompt is needed); otherwise the first card in view keeps its offset, whether older pages are added above it or new comments below. A different filter tab starts at its own top.

### Comment permissions

Project comment queries and mutations require current organization membership and the exact organization/project/document scope. Authors can delete their own threads and replies; organization owners and admins can delete anyone's comments. Other members cannot. Archive/unarchive uses the same author-or-admin rule because it hides a thread. The server returns a per-comment `canDelete` flag in thread pages, reply previews, and reply pages; the widget hides Delete (and thread Archive/Unarchive) unless permitted. These flags are presentation hints: mutations recheck the current identity and role.

Resolve/reopen intentionally remains available to any organization member with write access for collaborative triage, as do creating threads and adding replies. Author IDs always come from the authenticated identity. Reply removal verifies that the reply belongs to the scoped thread and deletes only that reply; deleting a thread retains the existing tombstone and batched reply cleanup. Shared/public read-only viewers have no comment mutation access. These organization-role rules apply to project comments; the legacy slug-based API described below retains its separate authorization model.

Thread and reply history uses bounded reactive Convex pages. Explicit load-older controls preserve access to the full history; loaded pages remain subscribed rather than becoming a stale snapshot. Read limits account for reply previews and bounded author projections as well as raw thread rows. Deletion hides the thread immediately using a tombstone, then removes replies in scheduled batches of 100 before deleting the thread record. Organization membership is checked by indexed organization/user lookup, not by searching the first page of an organization roster.

The legacy opaque viewer (`/docs/:org`) loads `commentor.js` inside its sandbox and routes comments through the same parent bridge, using an adapter for the legacy `threads`/`replies` tables. These tables require operator-mapped live membership and author/admin moderation (see Legacy operator runbook). Worker-only mapping and soft-delete functions require `CONVEX_INTERNAL_SECRET`, which must match in the Worker and Convex environments.

### Pin layout

Pins, the open thread bubble and the highlighted anchor are positioned in one batched pass per animation frame (`Commentor.repositionPins`). Scroll, window resize and a `ResizeObserver` on `<html>` and `<body>` (content that reflows without either, such as late images or fonts) only schedule that frame. The pass reads everything first (viewport size, one anchor rectangle per pin through a thread-id map built once, the open bubble's pin rectangle and size, the highlighted anchor's rectangles) and writes afterwards, so the browser runs a single layout however many pins exist; previously every pin's write was followed by the next pin's read, one forced layout per pin. A pin's new box is derived from its previous box and its new `left`/`top`, so keeping the open bubble attached costs no further read; only a pin that was hidden before needs one. Pins keep `position: fixed` with `left`/`top` (their CSS `transform` is the rotation and hover scale, and the positions are part of the tested contract). Orphaned anchors, anchors outside the viewport, the drawer and every dock edge keep their previous behaviour.

Measured in Chromium with 40 scroll frames and every pin on screen (`tests/commentor-pin-layout-browser.test.ts` asserts one layout per frame): layouts per frame 9 / 90 / 450 before at 10 / 100 / 500 pins, 1 / 1 / 1 after; layout time per frame at 100 and 500 pins fell from 25 ms and 598 ms to 0.4 ms and 1.8 ms. Remaining script time is the anchor lookup itself (`querySelector` per pin, roughly 30 µs each); caching it is possible future work.

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
| Blob storage | Cloudflare R2 bucket bound as `STORAGE` (private; no public URL) |

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

`public/management-query.js`, `public/select.js`, and `public/management-pages.js` are tracked; `pnpm verify` rebuilds them and fails if they drift from source. `public/commentor.js`, `public/commentor-parent.js`, `public/lazy-tree.js`, `public/private-viewer.js`, and `bin/rendro.mjs` are ignored and built in the release path. When management controllers or templates change, rebuild assets and bump `MANAGEMENT_SHELL_VERSION` in `src/routes/management-navigation.ts`; a shell whose version does not match the loaded bundle refetches current HTML, falling back to full navigation if that HTML is incompatible. Bump `MANAGEMENT_QUERY_VERSION` or `SELECT_VERSION` in `src/routes/management-asset-versions.ts` when those bundles change. After `pnpm build:assets`, run `pnpm record:assets` to append the new version’s SHA-256 to `scripts/asset-versions.json`. The recorder and `pnpm verify:assets` reject changed bytes at an existing version. CI also compares the ledger against the PR base (or previous push), rejecting rewritten or deleted historical hashes. The viewer versions (`LAZY_TREE_VERSION`, `PRIVATE_VIEWER_VERSION`, `COMMENTOR_PARENT_VERSION` and `COMMENTOR_VERSION` in `src/viewer/asset-versions.ts`) also use this ledger and recording workflow, even though their built bundles are ignored. Bump the corresponding version before recording changed bytes. Builds never update the ledger automatically.

### Public static assets

Every file the Worker serves from `public/` is public and is served **before the session middleware** in both runtimes, so an asset request never costs a session lookup, never evicts a warm identity-cache entry and never gets the session's `private, no-store` policy. The allowlist is exact (`publicAssetPaths` in `src/routes/public-assets.ts`: no prefix other than `/fonts/*`, which has its own contract); a path outside it is a 404 and never an ASSETS fallthrough (the former `GET *` ASSETS route is gone, and `run_worker_first = true` still routes every request through the Worker). `tests/public-assets.test.ts` fails if a file appears in `public/` that is neither allowlisted nor a hashed font/license.

| Class | Paths | `Cache-Control` | Notes |
|---|---|---|---|
| Versioned bundles | `/management-pages.js`, `/management-query.js`, `/select.js`, `/lazy-tree.js`, `/private-viewer.js`, `/commentor-parent.js`, `/commentor.js` | `public, max-age=31536000, immutable` only for the exact current `?v=<version>`; otherwise `no-store` | `text/javascript; charset=utf-8` |
| Fonts | `/fonts/<name>.<hash>.woff2` | `public, max-age=31536000, immutable` | content-hashed name; license texts: one day |
| Icons and images | `/favicon.svg`, `/favicon.ico`, `/landing-product.webp` | `public, max-age=86400` | stable URLs (the image is also an external preview), so a daily refresh rather than immutable |

**Why `?v=` and not hashed file names.** The version of every bundle is already recorded with its SHA-256 in `scripts/asset-versions.json`; `pnpm verify` rebuilds the bundle and fails when the bytes do not match the recorded hash of the current version, and the CI guard forbids rewriting a recorded hash. So "this URL names exactly these bytes" is enforced by the existing ledger, with no second manifest to keep in sync. `src/routes/versioned-bundles.ts` is the single registry of path → current version: the Worker, the Node server and `scripts/verify-asset-versions.ts` all read it, and a new bundle is added there once. The `?v=` match is strict: the query string must be exactly `?v=<current version>`, so an extra, repeated, empty, differently cased or prefixed parameter is not immutable.

**Old and unknown versions.** The Worker only holds the current build (the ledger keeps hashes, not bytes), so an open tab or a request that straddles a rollout can ask for a version that no longer exists, or a not-yet-live one on an older isolate. Such a request is answered `200` with the current bytes and `Cache-Control: no-store`: it works, but it is never cached under a URL that does not name those bytes. A `404` would break a page that is still loading; the management shell already detects a bundle/shell version mismatch and refetches or falls back to full navigation. A missing `?v=` is treated the same way. The ASSETS binding's 404 (an unbuilt bundle) is passed through unchanged and never labelled immutable, and a `304` revalidation keeps the same headers so it cannot downgrade a cached entry.

**Adding or changing a bundle.** Bump its constant, `pnpm build:assets`, then `pnpm record:assets` (rebase onto `main` first; a version collision is a ledger conflict). `public/commentor.js` is now versioned and recorded like the others (`COMMENTOR_VERSION`, referenced by the project document frame). CSP nonces and SRI are unaffected: scripts are same-origin and nonce-bearing in HTML that stays `no-store`, and no integrity attribute is emitted, so there is nothing that could disagree with the served bytes.

**Measured (mocked Convex, `/get-session` calls).** A signed-in request for `/lazy-tree.js`, `/commentor.js` or `/landing-product.webp` used to cost 1 session read each and evicted the cached identity; now 0. Three signed-in loads of an organization-scoped document page, each followed by `lazy-tree.js`, previously cost 6 reads (3 pages + 3 asset requests that also evicted the cached identity) and now cost 1; three loads of the landing page with its hero image went 6 → 3, and three loads of the legacy document shell (`commentor-parent.js`, `lazy-tree.js`, `private-viewer.js`) 6 → 3.

### Self-hosted fonts

Inter and a Material Symbols Outlined subset are committed under `public/fonts/` as content-hashed woff2 files (`<name>.<sha256[:10]>.woff2`), with their licenses beside them: `LICENSE-Inter-OFL-1.1.txt` (SIL OFL 1.1) and `LICENSE-Material-Symbols-Apache-2.0.txt` (Apache-2.0). They are static assets of the Worker (`[assets]` directory), never bundled into the Worker script, and they are not in the asset-version ledger because the hash is in the file name.

| File | Bytes | Contents |
|---|---|---|
| `inter-latin.<hash>.woff2` | 34,380 | Inter variable, `wght` clamped to 400–700, Latin |
| `inter-latin-ext.<hash>.woff2` | 55,820 | same, Latin Extended (loaded only when such characters appear) |
| `material-symbols-outlined.<hash>.woff2` | 7,280 | 35 icons; FILL 0, GRAD 0, wght 400, opsz 20–24 |

`scripts/build-fonts.ts` (`pnpm build:fonts`) regenerates them reproducibly offline from the pinned devDependencies `@fontsource-variable/inter` and `material-symbols` using `subset-font` (HarfBuzz subsetter with axis instancing), and writes `src/routes/font-manifest.ts`. `pnpm verify:fonts` (part of `pnpm verify`) regenerates in memory and fails on any byte difference. The icon list is extracted from source by `scripts/fonts/icon-names.ts`: in every file that renders Material Symbols it collects each quoted string and `>text<` node that is a valid ligature name, minus `NON_ICON_LITERALS` (ordinary words that are also ligatures, such as `block` or `pending`). An unlisted word is harmless: it only adds a glyph to the subset. `tests/font-subset.test.ts` fails when the committed subset and the source disagree and checks every listed name shapes to one ligature glyph in the committed font. Layout subsetting keeps the ligature rules of only the listed glyphs (`noLayoutClosure`); closure would retain all ~3,900 icons.

`GET /fonts/*` is public and runs before the session middleware in both runtimes (`src/worker.ts`, `src/index.ts`). `fontResponseHeaders` (`src/routes/fonts.ts`) decides the response: hashed `*.woff2` → `Content-Type: font/woff2`, `Cache-Control: public, max-age=31536000, immutable`; license texts → `text/plain; charset=utf-8`, one day; everything else under `/fonts/` is an empty 404 (never an ASSETS fallthrough). A missing font is not cached as immutable. Pages call `renderFontHead({ icons?, weights? })`, which emits `rel="preload" as="font" type="font/woff2" crossorigin` for the Latin Inter file (and the icon font on icon pages) plus the `@font-face` rules in a nonce-bearing `<style data-rendro-fonts>`. Pages with a theme button (landing, auth, management, shell) declare the icon font; the styled 404 page does not.

### Self-hosted viewer styles

The document viewer shells (private docs, legacy docs, publication shells) no longer load the Tailwind runtime from `cdn.tailwindcss.com` (#89). The handful of utility classes the shell and document tree used are plain CSS in the shell's own stylesheet (`.tree-icon`, `.tree-folder-name`, `.tree-stack`, and the tree row, label and folder rules). The Tailwind v3.4.17 Preflight rules that match elements the shell renders live in `src/styles/viewer-base.css` (MIT notice kept), byte-for-byte as the CDN generated them. No forms-plugin rule matched any shell element, so none ship.

`scripts/build-styles.ts` (`pnpm build:styles`) copies each source to `public/styles/<name>.<sha256[:10]>.css` and writes `src/routes/style-manifest.ts`. `pnpm verify:styles` (part of `pnpm verify`) fails when a committed file, the manifest or a stale file disagrees with the source. `GET /styles/*` follows the font contract in both runtimes: hashed `*.css` → `text/css; charset=utf-8`, `public, max-age=31536000, immutable`; anything else is an empty 404. Like the fonts, the files are not in the asset-version ledger because the hash is in the name. The shell links the stylesheet as the last `<head>` element, where the CDN inserted its generated `<style>`, so equal-specificity rules resolve exactly as before. `tests/viewer-styles.test.ts` covers the build, drift, headers, Node/Worker parity and that every class the shell and tree render has a rule.

The base stylesheet is 1,435 bytes (778 gzip), against a 419 KB CDN script (126 KB gzip) that also compiled CSS on every page load. A Chromium comparison against the real CDN script covered computed styles (every property, `::before`/`::after`) and geometry of every shell element: three shells, 1440×900 and 390×844, light and dark, with tree hover, avatar menu, mobile tree drawer and More menu states, with motion reduced and not. The two builds are identical, apart from Tailwind's unused `--tw-*` custom properties.

### Environment Variables (Workers)

`src/config.ts` validates the Worker environment at startup. The table lists every named string setting read by Worker code; `ASSETS` (static assets) and `STORAGE` (the R2 bucket) are separate bindings in `wrangler.toml`; there is no storage endpoint, region or access key setting. Google OAuth credentials are read only by Convex, and `BASE_URL` is unused. The local Node entry reads `PORT` separately.

Both production (top-level) and `development` declare the same required secrets: `CONVEX_INTERNAL_SECRET`, `AUTH_SECRET`, `IMAGE_PROXY_SECRET` and `REPO_CAPABILITY_SECRET`. Wrangler checks these at deploy time, and `src/config.ts` validates them at startup. Production commands use the top-level configuration without an `--env` flag; development commands use `--env development`.

| Variable | Storage | Purpose |
|---|---|---|
| `NODE_ENV` | Wrangler var | Runtime mode; `production` selects JSON logs at `info` level |
| `CONVEX_URL` | Var/secret (optional at startup) | Convex deployment URL for legacy calls and browser comments; defaults to empty; required legacy reads return 503 without it. Set for the full app |
| `CONVEX_SITE_URL` | Var/secret (optional) | Convex HTTP action origin for auth and project routes; derived from `CONVEX_URL` when unset. Startup and `/health` work without either URL; backend routes do not |
| `CONVEX_INTERNAL_SECRET` | Secret (required by `wrangler.toml`, ≥32 chars) | Worker-only legacy functions, ingress proofs and storage resolver proofs; same value in Convex |
| `AUTH_SECRET` | Secret (required, ≥16 chars) | Encrypts scoped private viewer tickets and signs legacy `/share/:token` HMAC links. Better Auth signing happens in Convex |
| `RETENTION_SECRET` | Secret (optional, ≥32 chars) | Bearer for Convex's retention endpoints, used by the scheduled purge; same value as in Convex. Without it the purge reports itself disabled and fails |
| `IMAGE_PROXY_SECRET` | Secret (required, ≥32 chars) | HMAC key for same-origin image proxy URLs (see [Image proxy](#image-proxy)). Set the same value on the ingest Worker. Rotating it requires a `RENDERER_VERSION` bump, so stored renders are rebuilt with new signatures |
| `REPO_CAPABILITY_SECRET` | Secret (required, ≥32 chars, Worker only) | Signs repository capability cookies, asset tickets and the public shared-cache subrequest URLs (see "Repository read path"). Must not equal `AUTH_SECRET`, `CONVEX_INTERNAL_SECRET`, `RETENTION_SECRET` or `IMAGE_PROXY_SECRET`; rotating it only sends readers back through the permission source |
| `REPO_CONTENT`, `REPO_EPOCHS`, `REPO_ACCESS` | Bindings (R2, KV, service), not configured yet | The repository read path's snapshot bucket, revocation and visibility epochs and permission source. Until P5 binds all three, every `/r/` URL is a 404 |
| `REPO_SHARED_CACHE_DEBUG` | Var (optional, development only) | Set to `1` to surface the shared-cache subrequest's `CF-Cache-Status`/`Age` as `X-Repo-Shared-Cache` on public frame responses (see "Repository read path"). Never set in production: it reports cache internals on a public response |
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
| `.github/workflows/quality.yml` | Pull requests, pushes to `main`/`development`, manual | Independent `verify` (`pnpm verify`, dependency audit), `coverage` (`pnpm coverage`, summary artifacts), and `e2e-engine` (Playwright Test/workerd, two weighted shards per browser engine, `e2e (<engine> <i>/2)`, each with a duration guard that warns above 60% of its timeout) with an aggregate required `e2e` job and an optional `e2e-report` job that merges failed shards' blob reports; read-only permissions, no deployment credentials |
| `.github/workflows/release.yml` | `v*` tags (and edits to the file itself, which stop before publishing) | `gate` calls `quality.yml` (`verify`, `coverage`, `e2e`) as a reusable workflow; `build` (read-only) builds `bin/rendro.mjs` and `SHA256SUMS`; `publish` (the only job with `contents`, `id-token` and `attestations` write) re-checks the sums, attaches a build provenance attestation (`actions/attest-build-provenance`) and creates the GitHub release with both files. Verify a download with `sha256sum -c SHA256SUMS` and `gh attestation verify rendro.mjs --repo Chaitanya045/rendro` |
| `.github/workflows/r2-public-access.yml` | Daily cron, manual; dry run on pull requests touching it | `pnpm check:r2-public` ([R2 bucket privacy](#r2-bucket-privacy)); needs `CLOUDFLARE_ACCOUNT_ID` and a read-only R2 `CLOUDFLARE_API_TOKEN` |
| `.github/workflows/stability.yml` | Nightly cron, manual | `coverage-twice` (two consecutive `taskset -c 0,1 pnpm coverage` runs, then per-test outcome and coverage-counter diffs; the second run and diffs always execute) and `e2e-no-retries` (per engine and shard, `E2E_RETRIES=0`); read-only permissions, no secrets; any failure fails the workflow |

Supply-chain policy (enforced by `tests/workflow-supply-chain.test.ts`): every external `uses:` is pinned to a full
40-character commit SHA followed by a `# vX.Y.Z` comment; every checkout sets `persist-credentials: false` (a
`true` value needs a justification comment); each workflow declares workflow-level permissions without writes and
each job declares its own block, with write access allowed only for the release `publish` job. Dependabot
(`.github/dependabot.yml`) proposes weekly SHA and comment bumps. To pin by hand, resolve the tag with
`gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and dereference annotated tags to their commit.

No workflow deploys the Worker or Convex to a shared environment, or publishes to npm.
The E2E job pushes application code only to a harness-owned disposable loopback backend.

`pnpm e2e` starts the real Worker through Wrangler's `createTestHarness`, with
the production compatibility flags and static-asset configuration, isolated
loopback ports, generated test secrets, and guarded outbound requests. The
suite uses pinned local Convex with real Better Auth, HTTP actions and WebSockets,
Miniflare's local R2 simulation, an in-memory mail sink, and a deterministic OAuth provider fixture.
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

The Worker's nightly cron trigger (`03:23 UTC`, `[triggers]` in `wrangler.toml`, `scheduled` in `src/worker.ts`, `src/retention.ts`) scans failed deployments older than 24 hours, superseded deployments older than 30 days (both measured from creation), and expired staging leases after their 24-hour drain period. Failed rows also honor the staging drain deadline. Active deployments and project active pointers are protected. Publication pins and unexpired, unrevoked shares protect their deployment with indexed existence checks (`by_pinned_deployment`, `by_deployment_live`), without collecting a project's publications or an organization's shares.

Upload and copy requests freshly re-authorize the current staging lease after body/source validation and immediately before storage dispatch. A lease renewed by another request remains usable. An expired lease returns HTTP 409 with “Staging lease expired. Run rendro push again to start a new deployment.”; the CLI preserves that diagnostic and attempts failure cleanup. Storage operations retain their five-minute/lease deadline and the retention drain interval.

The operator-only `GET /retention/candidates` is a non-cacheable claim operation. One Convex transaction pages at most three candidates with a 256 KiB read budget, rechecks references, claims them, and persists the scan cursor. Pagination can cross the byte budget by one document (Convex caps each document at 1 MiB), so large legacy rows still advance. The candidate count also bounds project/publication/share lookups to nine documents, reserving headroom below the 16 MiB read limit and for claim writes. Claims and completion timestamps live only in `deploymentPurges`, keyed by deployment ID. Retention never patches a deployment document, so historical rows at the 1 MiB limit (including oversized digests, storage keys or provenance) can progress without growth, truncation or a backfill. Regression tests explicitly assert Convex serialized document sizes because convex-test does not enforce the per-document limit. `by_retention` selects status + absent `purgedAt` + creation time; `by_staging_expiry` selects staging + absent `purgedAt` + lease expiry, including legacy missing values. Legacy deployment tombstones are excluded by those indexes. New completion records are checked through the small side table; their deployment rows are visited but skipped on subsequent traversals. This trades repeat bounded reads for leaving full legacy documents untouched. Empty/protected pages still advance. A fixed cutoff and rotating failed/superseded/staging phases finish one traversal before restarting; a later run resumes from `retentionProgress` even if the previous process died. Rows added behind a cursor are visited on the next traversal.

Claims insert a `deploymentPurges` record and token before any storage deletion. Publication/share mutations read that record and legacy purge fields in their transaction; Convex conflict handling ensures that either the reference protects the bytes or the claim blocks the reference. Public resolvers also reject purging and purged rows. Claim worker ownership expires after 30 minutes, but **purging never reverts to readable/pinnable**: another scan can issue a replacement token and retry the immutable prefix. A lost claim response, interrupted deletion, per-object error, or failed finalization is therefore recoverable. Finalization requires the current token and is idempotent, emitting one `deployment.purged` audit event. Its object count describes the successful attempt, not previously deleted objects from interrupted attempts.

The purge drains up to 100 metadata pages, stopping early at ten minutes or after 900 subrequests (candidate, list, delete and finalize calls; the next run resumes whatever is left). Each Convex call has a 30-second deadline. It re-lists a prefix from the beginning after each successful delete (`list` then `delete` of up to 1,000 keys through the binding; a failing delete throws, and deleting a missing key is not an error), then verifies the prefix is empty before finalization. Errors keep claims retryable, allow other candidates to proceed, and fail the scheduled run so it shows in Cloudflare's cron history; only the error's type and the deployment ID are logged. It needs the Worker secret `RETENTION_SECRET` (the value Convex checks) and a Convex origin; without them it logs `RetentionDisabled` and fails. The purge runs inside the Worker, so no storage credential exists in GitHub Actions. To run it by hand, trigger the cron from the Cloudflare dashboard or `wrangler dev --test-scheduled`.

Comments on repository docs have their own retention: an uninstalled or deleted repository's comments are hidden at once and purged 30 days later by Convex itself ([Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6)).

Rollout: release the separate claim table, optional compatibility fields/indexes and claim-aware Convex endpoints, then the lease-aware Worker, then the scheduled purge. Keep cleanup disabled during mixed-version rollout. The retired GitHub Actions script (S3 keys, `pnpm cleanup:retention`) must be deleted from the repository secrets (`R2_*`) and never run alongside the new purge. All old deployment rows remain readable without backfill. To roll back, remove the cron trigger and preserve purging claims/tombstones until outstanding deletions have been reconciled; never clear a purging flag to restore a potentially partially deleted deployment.

### Legacy migration

Legacy migration remains supported: slug-based publications, comments, `/share`, `/public`, and `/docs/:org` remain available, and production migration verification has not been recorded. Keep the migration tool until that verification is complete. It copies slug-prefixed object bytes into immutable deployments using the same Worker start/upload/commit protocol as `rendro push`.

1. Set the same random `MIGRATION_SECRET` in Convex and the operator environment. Set `RENDRO_ENDPOINT` to the target Worker origin (default `http://localhost:3000`) and the `LEGACY_SOURCE_S3_ENDPOINT`, `LEGACY_SOURCE_S3_ACCESS_KEY`, `LEGACY_SOURCE_S3_SECRET_KEY`, `LEGACY_SOURCE_S3_BUCKET` (default `docs`), `LEGACY_SOURCE_S3_REGION` and `LEGACY_SOURCE_S3_FORCE_PATH_STYLE` variables to the legacy source bucket (an operator-supplied, short-lived read-only S3 key: the Worker never holds one, and this is the only remaining use of the S3 SDK, a dev dependency of this one tool). Set `CONVEX_URL` and `CONVEX_INTERNAL_SECRET` to the authoritative legacy Convex database used by that Worker and bucket; apply refuses to continue if deletion state cannot be read.
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

## Repository Content Ingest (GitHub pivot, P3a)

`src/ingest/` holds the pure content pipeline that the future ingest Worker
(a Queue consumer, epic #214) will call. Nothing on the request path imports
it yet. The Worker bundle is byte-identical with and without these modules, at
2,504.56 KiB / 473.16 KiB gzip. The modules need no network and no GitHub credentials.

```text
tree listing ──► configFilesToRead ──► (caller fetches ≤ 24 small blobs) ──► detectDocs ──► doc sets
blob + path ──► renderDocument:
   Markdown: front matter ─► comrak (WASM, GFM) ─► HTML string ┐
   HTML:                                                       ├► bounded parse5 ─► rewrite URLs ─► allowlist sanitize
                                                               ┘   ─► alerts, heading ids, link/img attributes, highlight
                                                                   ─► serialize ─► re-parse + re-sanitize until byte-stable
rendered titles ──► buildSidebar ──► per-commit sidebar tree
```

| Module | Role |
|---|---|
| `detect.ts` | Docs detection from the recursive tree listing |
| `render.ts` | `renderDocument(source, path, { rewriteImageUrl })` (async: the image hook may be, and the proxy's signing is), `renderKey(blobSha, path)` |
| `markdown-engine.ts` | comrak WASM wrapper; `initMarkdownEngine(module)` must run once per isolate |
| `parse-html.ts` | parse5 with depth, formatting-list, attribute and work bounds |
| `sanitize.ts` | Allowlist schemas and fixed-point serialization (the security boundary) |
| `transforms.ts`, `paths.ts` | URL rewriting, GitHub heading slugs, alerts, link/image attributes, image proxy rewrite |
| `highlight.ts`, `highlight-theme.ts` | Class-only highlighting and its stylesheet |
| `sidebar.ts` | Sidebar tree with titles |

### Library choices

The comparison was measured on 2026-10-18 on an i5-8300H (8 threads, shared and
loaded, with load averages of 1.5 to 4 during the final runs). It used Node 24.18 and
`workerd` 2026-10-06, run directly with a capnp config. The corpus was 379 real
READMEs (2.87 MB: npm and crates.io packages, 235 with code fences, mostly
JS/TS, shell, Rust and TOML). Throughput is the median of passes 2–6 over the
whole corpus. Cold start is the median of 7 runs from `workerd` spawn to first response.

| Pipeline (parse + sanitize + serialize) | Node ms/doc | workerd ms/doc | workerd MB/s | Cold start | Bundle (min / gzip) |
|---|---|---|---|---|---|
| Empty Worker | – | – | – | 54 ms | – |
| micromark/mdast (remark stack) + hast-util-raw | 11.9 | 10.6 | 0.71 | 59 ms | 392 / 116 KiB |
| comrak WASM + parse5 | 2.8 | 2.2 | 3.48 | 64 ms | 245 / 70 KiB JS + 2.32 / 1.01 MiB WASM |
| comrak + parse5 + lowlight | 4.8 | 4.5 | 1.68 | – | +176 / 54 KiB |
| comrak + parse5 + Shiki (JS regex engine, 31 grammars, `transformerStyleToClass`) | 15.8 | – | – | 126 ms (Shiki alone) | +2.52 MiB / 317 KiB |
| **Shipped pipeline** (comrak + bounded parse5 + lowlight + fixed-point check) | **6.1** | **6.3** | **1.20** | **83 ms** | **406 / 124 KiB JS + 2.32 / 1.01 MiB WASM** |

The comrak WASM and JS figures are the `comrak-wasm` npm build current at the
time; #223 replaced it with the smaller self-built engine described below.

Highlighting the corpus's 689 KB of fenced code took lowlight 0.59 s (12 ms
init). Shiki took 4.6 s warm, with 320 ms of init for 31 grammars.

- **Markdown parser: comrak** (the upstream `comrak` crate, a Rust port of
  cmark-gfm 0.56). It has full GFM: tables, task lists, footnotes, strikethrough
  and autolink literals. It is GitHub's own renderer lineage, so quirks match
  GitHub. It decided on hostile input. Among 26 pathological inputs capped at
  1 MiB, comrak's slowest (a 150k-row table) rendered in about 1 s. micromark is
  quadratic or worse on several:
  - 8,000 nested brackets: 1.1 s, growing to roughly 700 s at 1 MiB;
  - a 1,000-level indented list: 55 s;
  - 100k autolink literals: 45 s;
  - 50k link references: 12 s.

  A hostile repo could pin ingest CPU that way. Through the whole shipped
  pipeline, each of 31 pathological inputs either renders or is rejected by a
  limit within about 1 s. The slowest that render are bounded by output size: a
  150k-row table and 100k autolinks, near the 8 MiB HTML cap, take 8.7 s at load
  about 7. That is inside a Queue consumer's 30 s CPU limit when each blob is its
  own unit of work. Heading ids and alerts are added
  after sanitizing, not by comrak.

  Rather than depend on the one-maintainer `comrak-wasm` npm package, Rendro
  builds the crate itself (#223). `wasm/comrak-engine` pins `comrak 0.56.0` and
  `wasm-bindgen 0.2.129` (toolchain `1.96.1`) and exposes one renderer with the
  fixed options Rendro uses; the compiled module, its glue and a SHA-256 file are
  committed under `src/ingest/comrak-engine`, so `pnpm verify` needs no Rust
  toolchain. `pnpm rebuild:wasm` recompiles and requires byte-identical output,
  and the `comrak-engine` CI job does the same. The build is reproducible off a
  different machine: it disables incremental compilation, sets `SOURCE_DATE_EPOCH`
  and passes `--remap-path-prefix` for the checkout, `CARGO_HOME` and `RUSTUP_HOME`,
  so no host path can leak into the module (rustc records crate source paths in
  panic-location strings). The artifact is 360 KiB raw / 122 KiB gzip WASM and
  7 / 2 KiB gzip glue, against 2.32 MiB / 1.01 MiB for the npm build. Output is
  byte-identical to the npm build over 5,009 inputs (READMEs, fuzzed Markdown and
  GFM probes). Its only WASM imports are wasm-bindgen value-marshalling helpers,
  so it has no ambient authority.
- **Highlighter: highlight.js 11.11 via lowlight 3.3.** It emits `hljs-*`
  classes natively, so there are never inline styles under the strict CSP. Compared
  with Shiki it is about 8x faster, initializes about 25x faster and is 14x
  smaller. The cost is regex grammars instead of TextMate grammars. There are 45
  languages: lowlight's `common` set plus Dart, Dockerfile, Elixir, Haskell, nginx,
  PowerShell, Protobuf and Scala. There is no auto-detection. `HIGHLIGHT_CSS`
  carries GitHub's light and dark palettes, taken from highlight.js's github themes
  (BSD-3-Clause).
- **Sanitizer: `hast-util-sanitize` over parse5** (the same spec-compliant tree
  builder `share-html.ts` uses). sanitize-html (htmlparser2, with 2026 parser-differential
  CVEs) and DOMPurify (needs a DOM) were ruled out. ammonia has no maintained
  WASM build, and adding a Rust toolchain to the build was not justified.

### Sanitization model

- **Parse, never filter strings.** Repo HTML is parsed as a document. comrak's
  output is parsed as `<body>` children, which is innerHTML semantics.
  `parse-html.ts` bounds parse5's real stacks:
  - open elements and active formatting elements ≤ 512 (Chromium stops nesting at 512);
  - ≤ 128 attributes per tag;
  - a 32M-unit work budget for adoption-agency scans.

  Sources are capped at 1 MiB and 50,000 `<` markers, and comrak's output at 8 MiB.
  Every limit throws `RenderError` with `reason` `too-large`, `too-complex` or
  `too-deep`. A crashed engine throws `engine`, and the isolate refuses further
  Markdown, because wasm-bindgen cannot re-instantiate after a Rust panic.
- **Allowlist schema.** GitHub-style content elements and attributes only.
  - Script-capable, raw-text, embedding and foreign-namespace elements are removed
    with their content: `script`, `style`, `svg`, `math`, `iframe`, `object`, `template`,
    `noscript`, `textarea`, `xmp`, `base`, `meta`, `link`, media and so on.
  - Unknown elements, including MDX components, are unwrapped.
  - No `style`, event handler, `srcset`, `ping`, `formaction` or other URL-bearing attribute survives.
  - Inputs are disabled checkboxes.
  - Table parts outside a table are dropped rather than re-parented.
  - Author `id`/`name`/`aria-describedby` get the `user-content-` prefix, as on
    GitHub, so content cannot clobber globals in the viewer frame.
- **URLs.** Before sanitizing, `href`/`src` are normalized the way the URL
  parser will read them: tabs, newlines and controls stripped, backslashes treated
  as slashes.
  - Only `http(s)` and `mailto:` (links only) remain.
  - Protocol-relative URLs become `https:`.
  - Fragments gain `user-content-`, matching the prefixed ids.
  - Relative and `/`-rooted references resolve against the document's repo path, the
    way GitHub resolves README links, and are emitted relative to the document's own
    directory, so the frame resolves them under whatever commit, branch or ticket base
    it was loaded from without rewriting the HTML (#242). A reference that leaves the
    repository, or encodes a separator or control character, loses its `href`.
  - External links get `rel="nofollow noopener noreferrer"`. Images get
    `loading="lazy" decoding="async" referrerpolicy="no-referrer"`.
  - External images go through the `rewriteImageUrl` hook after sanitizing; the
    ingest Worker sets it to the signed same-origin image proxy
    (see [Image proxy](#image-proxy)). Without a hook they lose their `src`. An image that cannot be proxied (a blocked
    target or a URL over 2,048 characters) loses its `src`. The output schema
    accepts only same-origin image sources — the signed proxy's `/`-rooted path or a
    path relative to the document — so no third-party host survives in
    rendered output even if a transform forgets one. `srcset` never survives
    sanitizing, so `src` is the only image URL.
- **Fixed point.** The trusted transforms (alerts, heading ids, highlighting,
  attributes) emit only what a second `outputSchema` allows. The serialized HTML
  must survive parse → sanitize(outputSchema) → serialize byte for byte. That
  proves the browser's re-parse matches the sanitized tree, which catches
  mutation-XSS differentials and transform mistakes. Output that does not settle
  within three passes throws `unstable`.
- **Evidence.** `tests/fixtures/ingest/hostile-corpus.ts` holds 102 public
  vectors:
  - scripts and handlers;
  - `javascript:`/`vbscript:`/`data:` and entity- or whitespace-obfuscated schemes;
  - SVG/MathML namespace confusion;
  - mXSS nesting and raw-text differentials, including the 2026 sanitize-html CVE shapes;
  - `<base>`, `<meta http-equiv>`, forms and `formaction`, `srcset`, `ping`, CSS `url()`;
  - comments, CDATA and entities.

  `ingest-sanitize.test.ts` checks every output against an independent statement of
  the contract, using stock parse5. `ingest-sanitize-browser.test.ts` loads every
  output in Chromium with no CSP behind it, with a canary installed (and a
  positive control proving the canary fires). It asserts that no script or
  handler ran, no request left the origin, and the live DOM holds only allowed
  elements, attributes and URL schemes. The sandboxed iframe and strict CSP
  remain defence in depth.

### Headings, titles and render keys

- **Heading ids** use github-slugger over the heading text in document order,
  with `-1`, `-2` for repeats, so README `#fragment` links keep working. The
  resulting id is `user-content-<slug>`. An emoji-only heading has an empty slug
  and no id, as on GitHub. An author-set heading id is kept, but the slug counter
  still advances. `headings` returns `{depth, text, slug, id}` for the TOC and
  comment anchors.
- **Titles** come from front matter `title`, then the first `h1`, then the first
  heading. For HTML documents, `<title>` comes before the headings.
- **GitHub alerts** (`> [!NOTE]` and the rest) become `markdown-alert` markup.
- **MDX** top-level `import`/`export` blocks are removed.
- **Render keys** are `render/v<RENDERER_VERSION>/<kind>/<blobSha>/<sha256(directory)[:32]>`.
  Output depends on the renderer version, the document kind and the blob, and also
  on the directory, because links and images are emitted relative to it. An unchanged
  file in an unchanged directory reuses its render across commits. Bumping
  `RENDERER_VERSION` invalidates everything: version 3 emits document-relative links
  and images, where version 2 emitted `/<repo path>` for the serving layer to rewrite.

### Image proxy

Sanitized repo content would otherwise keep `<img src="https://…">` pointing at
any host, so every reader's browser would tell the repo author's chosen host
its IP address and user agent. Like GitHub's camo, Rendro rewrites external
images at ingest to `/img/<sig>/<encoded-url>` on its own origin and fetches
them server-side (#224).

- **Signing** (`src/image-proxy.ts`). `encoded-url` is the base64url of the exact
  URL (as normalized by `new URL().href`), and `sig` the base64url HMAC-SHA256 of
  that URL under `IMAGE_PROXY_SECRET`. The HMAC key is imported once per isolate.
  The proxy recomputes the signature and compares the strings with
  `constantTimeEqual`, so no character of either segment can vary. It also requires
  the canonical encoding, so a URL has exactly one signed path. Anything else,
  including an unsigned or mis-signed path, is an empty 404 that never fetches.
- **Upstream checks** (`src/image-proxy-target.ts`), applied when ingest signs a URL
  and again on every redirect hop. Only `http(s)` on the default port, without
  credentials. IP-literal hosts in loopback, private, CGNAT, link-local (cloud
  metadata), reserved, documentation and multicast IPv4 ranges are refused. For IPv6
  only global unicast (`2000::/3`) is allowed, minus documentation, 6to4 and Teredo,
  which rules out loopback, ULA, link-local, and mapped or NAT64 IPv4. Single-label
  names, local suffixes (`.localhost`, `.local`, `.internal`, `.home.arpa`, …) and
  known metadata hostnames are refused.
  - **Residual risk.** Workers cannot resolve DNS, so a public name that resolves
    to a private address is not caught by these checks. Workers egress does not
    reach private networks: subrequests [cannot target IP addresses
    directly](https://developers.cloudflare.com/workers/platform/known-issues/#fetch-to-ip-addresses),
    and private services are only reachable through an explicit [Workers
    VPC](https://developers.cloudflare.com/workers-vpc/) binding, which Rendro
    does not have. The local Node server has no such boundary and is for
    development only.
- **Fetch** (`src/routes/image-proxy.ts`, mounted before session middleware). A GET
  with `redirect: "manual"`, at most 3 redirects (each re-checked), a fixed
  `User-Agent: Rendro-Image-Proxy/1.0 (+https://rendro.app)`, and no cookies,
  credentials, referrer or reader headers. Cloudflare's egress carries its own
  address, not the reader's. A 10 s deadline covers every hop and the whole body.
- **Response.** Only status 200 with a type from the allowlist (`image/png`,
  `jpeg`, `gif`, `webp`, `avif`, `svg+xml`, `x-icon` and its alias
  `vnd.microsoft.icon`). The body is streamed and cut off past 10 MiB (a larger
  `Content-Length` is refused before reading). Only fixed headers leave, so
  upstream `Set-Cookie`, validators, CORS and links are all dropped:
  - `Content-Type` (the normalized type), `Cache-Control`;
  - `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
    on every response, which keeps an SVG inert even when opened directly;
  - `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: no-referrer`;
  - `Cross-Origin-Resource-Policy: cross-origin`. The viewer frames are sandboxed
    without `allow-same-origin`, so their image requests carry an opaque origin.
    Chromium and Firefox then block `same-origin` and `same-site` CORP responses
    (`tests/image-proxy-browser.test.ts` keeps a control for this). The proxied
    bytes are public third-party content, and only signed URLs are served.
  Failures (refused target, redirect limit, bad status or type, oversize,
  timeout, network error) are an empty 502.
- **Cache.** The Workers Cache API, keyed by the SHA-256 of the URL. A success
  lives for the upstream's `max-age`/`s-maxage`, clamped to 5 minutes–7 days
  (1 day when absent; 5 minutes for `no-cache`, `no-store` or `private`, so
  badges stay fresh). Failures live 60 s. A body that fails mid-stream is stored as
  a failure instead. Storing runs in `waitUntil`; the Node server has no cache.
- **Frame CSP.** `RENDERED_DOCUMENT_POLICY` in `src/routes/asset-headers.ts` is the
  publisher frame policy plus `img-src 'self'`, for ingest-rendered documents when
  the serving path (P4) lands. It is not applied to uploaded publisher HTML:
  uploaded sites legitimately load images from other hosts, and tightening their
  frame would break them. Sanitized output needs no `data:` images.
- **Tests.** `tests/image-proxy.test.ts` covers signing, target checks and the route's
  abuse cases. `tests/image-proxy-browser.test.ts` runs the real responses in
  Chromium. `e2e/image-proxy.spec.ts` renders a Markdown document with external
  images, publishes it and checks, in every engine, that the reader's browser
  requests only our origin, while the Worker fetches the harness's fake image host
  with nothing of the reader's.

### Docs detection

`configFilesToRead(entries)` names at most 24 config blobs of 64 KiB or less to
fetch. `detectDocs(entries, { configs, pagesSource })` returns every doc set
`{root, generator, signal, kind, entry, pages, truncated}`. `primary` is the first.
Without config contents, each generator's default applies. The signals, strongest first:

1. Mintlify `docs.json` (verified when read; unread, only beside MDX pages) or `mint.json`.
2. `.gitbook.yaml` `root` (default `./`).
3. `mkdocs.yml` `docs_dir` (default `docs`).
4. `book.toml` `[book] src` (default `src`).
5. `.vitepress/config.*`: the parent directory plus `srcDir`.
6. `.readthedocs.yaml` `sphinx.configuration` or `mkdocs.configuration`.
7. `docusaurus.config.*`: `docs/` beside it.
8. Sphinx `conf.py` next to an `index.*`.
9. Docsify: `index.html` with `window.$docsify`, or the `_sidebar.md` / `.nojekyll`+README hints.
10. The GitHub Pages source, if the caller passes it.
11. A conventional folder (`docs`, `doc`, `documentation`, `website`, `site`,
    `guide(s)`, `book`, `manual`, `wiki`, `handbook`) up to depth 3 that holds Markdown.
12. Prebuilt HTML: `index.html` plus at least 3 HTML pages in the root, `docs`,
    `site`, `build`, `public`, `_site`, `out`, `dist`, `html`, `book` or `_build/html`.
13. The root README.

Rules that apply to every signal:
- Paths under `node_modules`, `vendor`, `third_party`, `bower_components` and hidden
  folders never count. Neither do `_build`/`_site` output inside a source root.
- A configured path outside the repository falls back to the default.
- A candidate with no renderable page (`.md`, `.markdown`, `.mdx`, `.html`, `.htm`)
  is discarded. reStructuredText is not rendered.

**Tie-break.** Every input is sorted first, so listing order never matters.
Doc sets are ordered by:
1. not under a test or example folder;
2. tier: configuration or Pages, then folder, then prebuilt, then README;
3. depth of the signal's directory;
4. the precedence above;
5. more pages;
6. root path, then signal path, in code-unit order.

Then:
- The same root keeps the first set.
- A folder or prebuilt guess that overlaps a stronger set is dropped.
- The README stands only when nothing else does.

**Entry pages** are `index.md`, `index.mdx`, `README.md`, … `index.html` in the root,
else the shallowest page. `SUMMARY.md` and `_*.md` navigation files are never
entries. The Docsify shell `index.html` is not a page. Sets hold at most 5,000 pages.

`buildSidebar(docSet, titles)` returns the entry first, then the tree under the
root:
- A directory's README/index becomes its landing page, and its title (when the page has one) titles the directory.
- Untitled pages are named from the file name (`getting-started.md` → "Getting started").
- Siblings sort naturally (`2-setup` before `10-deploy`) by code unit, never by locale.

### Open points for the serving phases

- Repo HTML loses its scripts, inline styles and `<link>` stylesheets, so it is
  shown in Rendro's typography. Allowing repo-relative stylesheets is a product decision.
- External images are rewritten at ingest to the signed same-origin image proxy
  (#224, see [Image proxy](#image-proxy)), so readers' IPs never reach the image host.
- Math (`$…$`) and Mermaid fences stay as text and code. mdBook `SUMMARY.md`,
  MkDocs `nav` and Docusaurus sidebars are not yet used for ordering.

## Repository Ingest Orchestration (GitHub pivot, P3b)

This section covers how a GitHub commit becomes a ready-to-serve snapshot (#220, part of epic #214). It is built and tested against a fake GitHub, and nothing on the request path uses it yet. The webhook route arrives with P1 (GitHub App), and serving arrives with P4. The content step sits behind the `ContentPipeline` interface in `src/ingest/orchestrator/pipeline.ts`. `contentPipeline()` (`content-pipeline.ts`) adapts the P3a modules above to it: `configFilesToRead`, `detectDocs`, `renderDocument`, `renderKey` and `buildSidebar`. The ingest Worker's main module, `entry.ts`, imports the comrak binary as a `WebAssembly.Module` and initializes the engine before anything renders.

| Module | Role |
|---|---|
| `src/ingest/github/source.ts`, `http-source.ts` | The `GitHubSource` interface and its REST implementation: refs with ETag/304, recursive and per-directory trees, raw blobs checked against their git ID, and archives |
| `src/ingest/github/rate-governor.ts` | Client-side pacing and backoff for one token's budget |
| `src/ingest/github/tar.ts` | Streaming tar reader for GitHub archives (pax, GNU long names, base-256 sizes, checksums) |
| `src/ingest/github/webhook.ts`, `deliveries.ts` | Push webhook verification and parsing (not routed yet); webhook redelivery client |
| `src/ingest/orchestrator/content-pipeline.ts` | The P3a pipeline behind `ContentPipeline`; render failures become per-page failures |
| `src/ingest/orchestrator/snapshot.ts`, `ingest.ts` | Snapshot build and the render-then-flip pointer move |
| `src/ingest/orchestrator/coordinator.ts` | Per-repository Durable Object logic: serialization, single flight, dedupe |
| `src/ingest/orchestrator/consumer.ts`, `reconcile.ts`, `worker.ts`, `entry.ts` | Queue consumer, cron reconciliation, the ingest Worker, and its main module |

### Ingest Worker and bindings (development and tests only)

`wrangler.ingest.toml` defines a separate ingest Worker, `rendro-ingest-dev`. It has no routes, no `workers.dev` URL and no deploy script, and `wrangler.toml` does not refer to it. `tests/ingest-workerd.test.ts` runs it on real workerd through Wrangler's test harness, with outbound fetches routed to the in-process fake GitHub.

| Binding | Type | Purpose |
|---|---|---|
| `INGEST_BUCKET` | R2 | Content cache under `gh/v1/` (GitHub stays the source of truth) |
| `INGEST_QUEUE` | Queue producer and consumer (`rendro-ingest-dev`, dead-letter queue `rendro-ingest-dev-dlq`, 10 retries) | One message per "bring this branch up to date" |
| `INGEST_COORDINATOR` | Durable Object `RepoIngestCoordinator` (SQLite-backed, migration `v1`) | One instance per repository, named `repo:<GitHub repository ID>` |
| Cron `*/10 * * * *` | Scheduled handler | Re-checks heads and redelivers failed webhooks |
| `GITHUB_API_ORIGIN`, `GITHUB_ARCHIVE_ORIGINS` | Vars, optional | Point the client at a fake GitHub; the defaults are `api.github.com` and `codeload.github.com` |
| `GITHUB_DEV_TOKEN` | Secret, optional | Development token until P1 mints installation tokens; without it requests are unauthenticated |
| `IMAGE_PROXY_SECRET` | Secret, required | Signs image proxy URLs in rendered pages (#224); must equal the serving Worker's value |
| `REPO_SEARCH` | D1, optional | The repository search index (#251); absent where no database is provisioned, and ingest then skips indexing |

### Storage key schema

Every key a repository owns sits under `gh/v1/repo/<repo id>/`. The prefix uses GitHub's numeric repository ID, so renames and transfers move nothing, and purging a repository (P9) is one prefix delete. The ref pointer is the only mutable object; every other key names immutable bytes.

```text
gh/v1/
├── repo/{repoId}/
│   ├── blob/{blobSha}                                  raw blob bytes, content-addressed
│   ├── render/v{rv}/{kind}/{blobSha}/{dirHash}         rendered page { html, title, headings }, or a cached { error } (renderKey)
│   ├── tree/{treeSha}.json                             one directory listing (truncated-tree walks only)
│   ├── snapshot/{commitSha}/r{rv}/sidebar.json
│   ├── snapshot/{commitSha}/r{rv}/manifest.json        written last; its presence means the snapshot is complete
│   └── ref/{encodeURIComponent(branch)}.json           the pointer: { commit, rendererVersion, sequence, flippedAt }
├── tracked/{repoId}.json                               reconciliation registry: { repo, branches }
└── reconcile/redelivery.json                           redelivery checkpoint
```

- Snapshot keys include the renderer version (`r{rv}`). After a renderer change, a commit's snapshot is rebuilt next to the old one, never overwritten, so caches keyed by commit stay valid. The rebuild reads blobs from R2 and makes no GitHub requests.
- Blobs are fetched once per repository and reused across commits. A rename or move costs no fetch.
- The manifest maps each page and asset path to `{ sha, size, render?, title?, error? }`. A page that cannot be rendered records `error`, and the rest of the snapshot is still built. The reason is `too-large` when the tree listing already shows the page over 1 MiB (it is never fetched), otherwise the `RenderError` reason: `too-large`, `too-complex`, `too-deep`, `unstable` or `engine`.
- Render failures are deterministic for a blob, a directory and a renderer version, so the failure is stored at the render key like an output. A hostile page is rendered once, not on every push.
- The exception is the engine itself. After comrak crashes, the isolate refuses all further Markdown. The page that crashed it is recorded as `engine`. Later Markdown pages fail the attempt with the transient `markdown-engine-unavailable`, which the queue retries, so good pages are never marked as broken. A Durable Object may keep its isolate across retries, so recovery waits for the isolate to be recycled; re-instantiating a fresh engine in a live isolate is not yet supported.
- Pages are keyed by directory as well as blob, because relative links resolve against the directory. A page moved to another directory is rendered again, from the blob in R2 and without a GitHub request. Assets need nothing.
- Assets are images (`png`, `jpg`, `gif`, `svg`, `webp`, `avif`, `ico`, `bmp`) under the docs root, outside vendored and hidden folders. The sanitizer removes stylesheets, scripts and media elements, so no other file types are ever referenced.
- Private-repository content (blobs, renders, tree listings, sidebar and manifest) is written through the `ContentSealer` hook. Today the hook stores bytes as they are; P9 adds per-repo AES-GCM. The pointer, the registry and the checkpoint hold only IDs and names, and are not sealed.

### Render-then-flip

1. Under the repository's coordinator, read the pointer, then GitHub's current head. The head request is conditional; a 304 costs no primary quota.
2. If the head is already served at the current renderer version, stop.
3. If `manifest.json` already exists for the head, skip to step 6.
4. List the tree: one recursive request. When GitHub truncates the listing (past 100,000 entries or 7 MB), walk it one directory at a time instead. Each directory listing is cached by its tree ID, so the next push fetches only the directories on changed paths. `node_modules`, `vendor` and similar folders are never entered.
5. Read the config files detection asks for, detect, and diff against the previous snapshot.
   - If the docs root's tree ID, the detection and the renderer are all unchanged, reuse the previous file map and sidebar: one manifest write, no blob fetches.
   - Otherwise fetch only blobs missing from R2, checking with an R2 HEAD first. A first import with at least 32 missing blobs takes them from one archive, provided the repository is under 512 MiB and either under 16 MiB or at least a quarter docs by bytes.
   - The archive redirect is followed at once and never stored, since private-repo links expire in five minutes. The installation token is never sent to the archive host. Archive entries carry no blob IDs, so each wanted entry is hashed and checked against the tree listing.
   - Files whose archive bytes differ from their blob (export-subst, LFS) are fetched one by one, as is everything still missing when the archive fails partway (an expired link, a cut connection, a different commit in the pax header).
   - Pages render as their bytes arrive. Then write the sidebar, and the manifest last.
   - Image hook (#224): `contentPipeline({ rewriteImageUrl })` passes every external (`http`/`https`) image source through a rewrite, after sanitizing and before serialization, so the output allowlist (same-origin images only) and the fixed-point check apply to the rewritten URL. Returning null drops the source; without a hook every external image loses its source (fail closed). The ingest Worker sets `rewriteImageUrl: imageProxyRewriter(env.IMAGE_PROXY_SECRET)`, so external images become signed `/img/` proxy URLs and non-public targets lose their source. The hook may be async (signing uses WebCrypto), so `ContentPipeline.render` is async. The output depends on the rule and the secret, so changing either must bump `RENDERER_VERSION` (now 3, which adds document-relative links and images on top of the version-2 image proxy).
6. Flip: write the new pointer with a compare-and-swap on the pointer object's ETag (R2 `onlyIf`). If another writer got there first, the attempt fails and retries.
7. Re-check the head (normally a free 304). If it moved during the build, ingest again, up to two follow-ups per call.

The pointer moves only in step 6, so a crash, eviction or failure anywhere earlier leaves the previous snapshot served. The objects already written are reused on retry. The workerd test reloads the Worker mid-ingest to show this.

### Single flight, idempotency and dedupe

- **One coordinator per repository.** The Durable Object for `repo:<id>` runs one ingest at a time, however many isolates, queue batches or readers ask. Durable Objects are single-instance per name, but their input gates open while a request awaits network I/O, so the coordinator serializes with its own promise chain. It also refuses messages for any other repository ID.
- **Single flight per branch.** A request joins the running job if it carries no hint or the same commit. Otherwise it joins the one job queued behind it, which reads the head when it starts and so covers any hint. Concurrent first views of an unseen repository are coalesced twice: per isolate by `firstViewEnsurer`, then across isolates by the coordinator; the serving Worker's read path uses both directly (the subsection "First view: ingest on first visit" of "Repository read path", #242). With the snapshot built, `ensure` answers from the pointer without calling GitHub.
- **Forward-only.** The head observed by a job is never older than the one behind the current pointer, because jobs are serialized and each reads GitHub's head. A late or duplicate delivery therefore cannot move a branch back. Push payloads (`after`) are hints only.
- **Stale hints.** A hint that is neither the served commit nor in the branch's flip history (the last 50) may come from a push the ref API has not shown yet. The consumer re-checks it twice, 15 seconds apart, then leaves it to reconciliation.
- **Delivery dedupe.** `X-GitHub-Delivery` is the dedupe key; redeliveries reuse it. A delivery is remembered only once its work has settled (flipped, current, no branch, or a permanent failure), for four days, which is longer than GitHub's three-day redelivery window. A transient failure or an unconfirmed hint leaves it retryable. Dedupe saves work; commit-level idempotency (manifest present means already built; pointer at the head means nothing to do) is what makes duplicates safe.
- **Failures.** GitHub 404, 403 and too-large responses, and a tree past 20,000 directories, are permanent: the message is acked and the failure is recorded against that head, so reconciliation skips it until the head moves. Everything else (5xx, network errors, rate limits, storage errors, pointer conflicts) is retried by the queue. Rate limits use GitHub's retry time; other failures back off exponentially from 10 s up to an hour, then go to the dead-letter queue.

### GitHub budget

- One `RateGovernor` per token allows 4 requests in flight, well under GitHub's 100-concurrent secondary limit and the Workers 6-connection limit. It paces each endpoint at 10 requests/s after a burst of 10, under the 900-per-minute endpoint limit.
- After a primary limit (remaining 0), it sends nothing until `x-ratelimit-reset`. After a secondary limit, it waits for `Retry-After`, or 60 s doubling to 15 minutes. Waits of up to 1 s happen in place; longer ones fail the attempt with `retryAt`, so a queue retry is delayed instead of holding the consumer.
- 5xx and network errors get two retries with jittered backoff.
- A 401 drops the token and retries once, since installation tokens rotate hourly.
- Redirects are followed only within the API origin, so renamed repositories keep working.

Measured against the fake GitHub for a repository with 300 docs pages, 40 images and 1,500 other files (`tests/ingest-measure.test.ts`, real comrak rendering). Billable requests are the ones that cost primary quota: 304s and the archive download are free. In Node with no network latency, the first import took 0.9–1.9 s (archive) and 0.5–0.9 s (per-blob, pacing excluded). Pushes took 25–100 ms. The host load average was 13–21.

| Scenario | Billable requests | Blob requests | Pacing time |
|---|---|---|---|
| First import, archive | 3 (ref, tree, archive) | 0 | 0 s |
| First import, per-blob (forced) | 343 | 341 | about 33 s |
| Push changing 2 pages and 1 image | 5 | 3 | 0 s |
| Push outside the docs folder | 2 | 0 | 0 s |
| Duplicate delivery | 0 | 0 | 0 s |
| Reconciliation, nothing moved | 0 (one 304) | 0 | 0 s |

On workerd (`tests/ingest-workerd.test.ts`, local machine, real comrak bundled as WASM), a private repository with 61 pages, 6 images and 40 other files went from queue message to flipped pointer in about 2.3 s for the first import (3 billable requests) and about 1.2 s for a two-file push (4 billable). Both times include the queue's one-second batch window.

### Reconciliation

GitHub never retries a failed webhook, and sends no event for some bulk pushes. The cron therefore runs two independent steps; a failure in one is logged and does not stop the other.

- **Heads.** For each `tracked/` entry, the repository's coordinator re-checks every tracked branch with its stored ETag. A head that differs from the pointer is queued like a push; a head with a recorded permanent failure is skipped. Repositories share the token's governor, so once GitHub rate-limits one check, the rest wait for the next run.
- **Redelivery.** The `WebhookDeliveries` client lists app webhook deliveries (newest first) back to the checkpoint, minus an hour of overlap, and never further than GitHub's three-day window. It groups them by GUID and redelivers those whose newest attempt failed, oldest first, up to 20 per run. A GUID that failed three times is logged and left alone. The checkpoint advances only when a run saw the whole window and handled every failure. The app JWT comes with P1; until then the step reports `not-configured`.

## Repository Read Path (GitHub pivot, P4a)

This section covers how a reader gets an ingested snapshot (#234, part of epic #214). A page view never calls GitHub or the database: a signed capability cookie answers "may this reader see this repository", and the bytes come from isolate memory, the colo's Cache API or R2, in that order. The code is in `src/repo-read/`. It is mounted before the session middleware and looks the session up only when the cookie cannot answer.

| Module | Role |
|---|---|
| `paths.ts` | URL grammar; rejects traversal, encoded separators and malformed refs before anything else runs |
| `capability.ts` | Capability tokens: HMAC-SHA256, derived keys imported once per isolate, constant-time comparison |
| `access.ts` | The `RepoPermissionSource` and `RevocationEpochs` interfaces, the control-Worker protocol (client and `repoAccessHandler`), and the KV epoch reader |
| `authorize.ts`, `grant.ts` | Authorization order, cookie minting and background refresh, asset tickets; issues the `RepoGrant` every read requires |
| `snapshot.ts` | Memory → Cache API → R2 reads of #229's key schema; pointer stale-while-revalidate |
| `frame.ts`, `tree.ts`, `routes.ts` | Document frame, sidebar directory pages, the Hono route |

### URLs

| URL | Serves |
|---|---|
| `/r/{owner}/{repo}` | Shell for the default branch; `?doc=<repo path>` selects the document (default: the snapshot's entry page) |
| `/r/{owner}/{repo}/~{branch}` | Shell for a branch. The branch is one segment: a `/` in its name is written `%2F` |
| `/r/{owner}/{repo}/@{commit}` | Shell for one commit (immutable) |
| `…[/{ref}]/files/{path}` | A rendered page as a document frame, or an image's bytes |
| `…[/{ref}]/tree?dir=&cursor=` | One sidebar directory page (JSON), as the viewer's lazy tree reads it |
| `…[/{ref}]/search?q=&limit=` | Full-text search over the snapshot (#251), JSON; optional binding (`REPO_SEARCH`) |
| `/r/{owner}/{repo}/@{commit}/view/{ticket}/files/{path}` | Private repositories: the same, authorized by the asset ticket alone |
| `/r/{owner}/{repo}/@{commit}/viewer-ticket?manifestKey={commit}` | Ticket renewal for the trusted shell (cookie-authorized, JSON) |
| `POST /r/{owner}/{repo}/comment-access` | Comment access for the trusted shell: authorized like a page view, then recorded in Convex (same-origin, JSON; see [Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6)) |
| `/__repo-cache/tiered/v1/{sig}/{epoch}/{key}` | Not a reader URL: the Worker's own cacheable subrequest for one public immutable object (see [Read order and caches](#read-order-and-caches), #242). The signature covers `public\n{epoch}\n{key}` and `{epoch}` is the repository's visibility epoch; a bad signature, a stale epoch, an unknown object or an unconfigured Worker is a plain 404 |

Owner and repository names must be literal GitHub names and match case-insensitively. A `{path}` is decoded once per segment; an empty, `.` or `..` segment, an encoded `/`, a backslash or a control character is a 404 before authorization. A path is only a lookup key into the manifest's `files` map (own properties only), never part of a storage key: every key comes from the manifest (render key, blob SHA) and from #229's key functions, so traversal has nothing to reach. Anything else under `/r/` is a 404.

### Order of a request

1. Parse the URL (above).
2. Authorize (below). A denial is a plain 404 page, JSON or empty asset body: `private, no-store`, no `ETag`, no `Retry-After`, the same bytes as a repository that does not exist. Nothing private has been looked up yet.
3. Resolve the ref: a commit as given, or a branch through its pointer (`ref/{branch}.json`, the default branch from the permission source). A branch with no pointer is a plain 404 — except for the shell of a branch or default URL, which instead enqueues an ingest and renders the preparing page (the subsection "First view: ingest on first visit" below). A commit URL or any other target is 404 in every case.
4. Read the manifest. A pointer whose manifest is missing or malformed means a broken store, so the answer is #225's retryable 503, never a 404. Malformed pointers, sidebars and render objects, storage timeouts (10 s) and transient faults (`transientStorageFault`) are 503s too.
5. Serve the shell, a tree page, a renewal, a frame or an asset.

### Capability cookie

A private grant sets `__Host-rendro-repo.{repoId}` (`rendro-repo.{repoId}` over local HTTP, where `Secure` is unavailable): `HttpOnly; SameSite=Lax; Path=/; Max-Age=300`. Its value is `v1.<base64url claims>.<base64url HMAC-SHA256>`:

| Claim | Meaning |
|---|---|
| `u`, `r`, `n` | Rendro user ID, GitHub repository ID, lower-cased `owner/name` |
| `p`, `b` | Visibility and default branch when granted |
| `e` | The user's revocation epoch, read before the grant |
| `s` | Binding to the session cookie: an HMAC of the session-token cookie, so signing out or switching accounts invalidates it at once and no session material is stored |
| `i`, `x` | Issued and expiry times (five minutes) |

Keys are derived per purpose from `REPO_CAPABILITY_SECRET` (`HMAC(secret, "rendro-repo-capability:v1:<purpose>")`) and imported once per isolate. Verifying costs one HMAC and `constantTimeEqual` (`shared/constant-time.ts`); claims are parsed only after the signature matches. Over HTTPS only the `__Host-` name counts, so a sibling subdomain cannot plant one. A cookie that fails to verify, belongs to another session or names another repository ID is cleared (on denials and private responses only: a public response may be cached by anyone, so it never sets a cookie); cookies for other repositories are left alone.

Authorization, in order:

1. A public repository seen by this isolate in the last minute: no lookup at all.
2. A valid cookie for this `owner/name` whose epoch is current: granted. Only the epoch store is read.
3. Past half its lifetime, the cookie is still honoured, and a refresh (session, epoch, permission source) runs in `waitUntil`, one per session and repository at a time. Its result serves this isolate's next request with that session's cookie: a renewed cookie, or a denial that clears it. Another session of the same user is unaffected.
4. Otherwise: the session (Convex, the middleware's 15 s cache), then the epoch, then the permission source. A private grant mints a cookie; a public answer goes to the isolate's public-repository memory; an anonymous denial is remembered for 30 s so unauthenticated probing does not reach the permission source.

An unknown answer from the session, the epoch store or the permission source is a 503 with `Retry-After`, never a denial.

### Asset tickets for private frames

The document frame is an opaque sandbox (#79), and requests it makes carry no cookies. A private frame's `<base>` therefore points at `/r/{owner}/{repo}/@{commit}/view/{ticket}/files/…`, where the ticket is a capability for the same user and repository bound to that commit instead of a session (15 minutes). Ticket requests check the signature, repository, commit and the epoch on every request. Renewal reuses the private viewer's protocol: the frame asks the trusted shell, the shell calls `…/viewer-ticket` with its cookie, and resource URLs are swapped in place. A ticket cannot renew itself.

### Revocation epochs, and the contract P5 implements

`RevocationEpochs.currentEpoch(userId)` is read on every private request (cookie or ticket). A capability minted at an older epoch is stale: the request falls through to the permission source, which re-mints or denies. The Worker reads `epoch:<userId>` from the `REPO_EPOCHS` KV namespace (decimal milliseconds; absent is 0; anything else is a 503) with `cacheTtl: 60`.

P5 implements this contract (#243): see [Repository Permission Mirror](#repository-permission-mirror-github-pivot-p5).

- **The permission source.** A control Worker, bound to the serving Worker as the `REPO_ACCESS` service, mounts `repoAccessHandler(source)`. Its `authorize(viewer, owner, name)` returns `{ id, owner, name, private, defaultBranch }` for the repository `owner/name` (case-insensitive) when `viewer` (a Rendro user ID, or null for anonymous readers, who see public repositories only) may read it now, and null when the repository is missing or forbidden, without distinguishing the two. It throws when it cannot tell; the client turns that, a non-200/404 status, a timeout (5 s) or an answer about another repository into a 503. It must build the answer from its mirror of the user's installation repositories (`GET /user/installations/{id}/repositories`), never by calling GitHub per view.
- **The epoch bumps.** On `member`, `membership`, `team` (`added_to_repository`, `removed_from_repository`, `edited`), `organization.member_removed`, `repository` (`privatized`, `publicized`, `transferred`, `deleted`), `installation_repositories`, `installation` (`deleted`, `suspend`) and `github_app_authorization`: first update the mirror so `authorize` already denies, then write `epoch:<userId>` = the current time in milliseconds for every affected user. Write a time, not an increment: KV has no compare-and-swap, and a read-modify-write loses concurrent bumps. The order matters: the serving Worker reads the epoch before it asks for a grant, so a bump that lands in between leaves the new cookie already stale.
- **The KV tier.** Revocation takes effect when the bumped epoch reaches the reader's colo. KV Classic propagates in about 60 s or more, and its colo cache (`cacheTtl`, at least 60 s) adds up to a minute, so expect 60–90 s, bounded above by the five-minute cookie in any case. KV Instant (private beta) replicates in under a second (p99 256 ms) and reads in about 1.6 ms, but allows 1 MB and one write per second per namespace, so it fits only if P5 stores just recently bumped epochs and batches writes.
- **Grants webhooks do not cover** (enterprise policy, IdP sessions) end with the cookie's lifetime and the source's own mirror TTL.
- **Repositories made private.** Anonymous readers hold no cookie: the serving isolate's one-minute public-repository memory is the bound, after the source already denies.

### Read order and caches

| Object | Memory (per isolate) | Public: cacheable subrequest (all tiers) | `caches.default` (per colo) | R2 |
|---|---|---|---|---|
| Ref pointer (mutable) | Fresh 5 s, then served stale up to 60 s while one refresh runs | Never | Never | On a miss |
| Manifest, sidebar, rendered page, image blob (immutable keys) | 16 MiB LRU, entries up to 1 MiB, parsed | `{origin}/__repo-cache/tiered/v1/{sig}/{storage key}`, `Cache-Control: public, max-age=31536000, immutable` | `{origin}/__repo-cache/v1/{storage key}`, filled in `waitUntil` | On a miss |

Every immutable object is read in that order: memory, then — for a public repository — a signed cacheable subrequest, then the per-colo `caches.default`, then R2. `caches.default` is per colo and a `cache.put` never reaches Cloudflare's Tiered Cache or Cache Reserve, so a public miss is fetched from the Worker's own origin as a subrequest instead: the Worker reads R2 and answers with an immutable `Cache-Control`, and the colo cache and every tier above it keep the copy, which the next isolate (or colo) reuses. The subrequest path carries an HMAC over `public\n<visibility epoch>\n<storage key>` under `REPO_CAPABILITY_SECRET`, with the epoch in the path, so the route only serves keys this Worker decided are public at the epoch they were decided at: a private key has no valid signature, no two objects or repositories share a cache key, and a privatized repository's outstanding URLs die at the epoch. Before serving, the route re-reads the repository's visibility epoch from KV (`epoch:repo:<id>`, written by the access directory when a repository is made private, removed, or left by its installation; never expiring, since a revert to 0 would revive old URLs): a URL minted before the bump no longer matches and is the plain 404, an epoch store that cannot answer is a retryable 503, and the KV read's colo TTL (60 s) is the revocation bound. The subrequest is cacheable (`cf.cacheEverything` with per-status TTLs: a year for 200s, a minute for the revocation 404, never a 5xx — the signed URL is deterministic, so a cached faulting fill would poison every later read) and only GET/HEAD apply. Private repositories skip the subrequest entirely — their objects are sealed and must not enter a shared cache — and read through `caches.default` and R2 as before. The `caches.default` keys live under a path no route serves, so only this code can read them, and only with a `RepoGrant`; the tiered route is the one exception, and it serves only signed public keys straight from R2 (it must not recurse into the layered reader). Bytes are cached as stored and opened per read, so P9's per-repository encryption will apply to both caches. A commit-pinned URL without a snapshot at the current renderer version falls back to the previous version's while a rebuild runs.

**Deployment requirement.** A same-zone `fetch()` re-invokes the Worker only when it runs on a Custom Domain (on a route or `workers.dev`, the platform refuses same-zone Worker-to-Worker fetches), and the Custom Domain makes the Worker its own origin, so there is no separate origin to configure and no loop: the subrequest re-enters the Worker once at the signed route, which answers from R2 without issuing further subrequests, and a filled cache answers before the Worker runs at all. Deploy the serving Worker on a Custom Domain (e.g. `rendro.app`, `dev.rendro.app`) for the shared tier to fill; on a route the subrequest fails, the reader falls back to the per-colo path, and public reads stay correct but never reach the shared tier. With `REPO_SHARED_CACHE_DEBUG=1` (development only), a public frame response carries `X-Repo-Shared-Cache: cf=<CF-Cache-Status>; age=<Age>` from the request's last subrequest, so a shared-tier hit is provable in a deployed environment.

### Headers

| Response | `Cache-Control` | Validator |
|---|---|---|
| Shell | `private, no-cache` (never `no-store`; each response has its own nonce) | none |
| Frame or image at a commit URL | `public` or `private`, `max-age=31536000, immutable` | Public frames `"page-<render key>-<template tag>"`; images `"git-<blob SHA>"`. A 304 needs no object read |
| Frame or image at a branch URL | `public` or `private`, `max-age=10, stale-if-error=86400` | Same |
| Private frame | as above | none: it embeds a per-reader ticket |
| Ticket-authorized image | `private, max-age=900` | `"git-<blob SHA>"` |
| Tree page | as the URL's ref | `"tree-<commit>-r<renderer>"` |
| Renewal, denials, faults | `private, no-store` | none |

Images get `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'self'`, ranges and HEAD through `serveObject` (#94). Frames are generated, so they are never ranged. Every response has `Referrer-Policy: no-referrer`.

### First view: ingest on first visit (#242)

A reader who opens a repository or branch nobody has ingested yet should not have to wait for a webhook. After authorization succeeds, the read path asks the per-repository coordinator Durable Object (`REPO_INGEST` binding, the serving Worker's cross-script binding to the ingest Worker's `RepoIngestCoordinator`) to `ensure` the branch: the same single flight, admission state, pointer write and failure recording as the queue path (above). `installationIds` stay in the permission source's mirror; the reader's `RepoRef` carries `installationId: null`.

What the reader sees depends on the outcome inside a 5-second window (`PREPARE_WINDOW_MS`):

- **Outcome arrives in window.** `flipped`/`current`: the pointer is read again, this time fresh (the same request's "never ingested" pointer miss would otherwise hide the just-published branch for up to 5 s, so `RepoSnapshots.pointer` takes a `fresh` flag), and the response is the ordinary docs. `duplicate`: still building, the preparing page. `no-ref`: a plain 404, no readiness header. `failed`: the retry page, 503.
- **Window expires.** The response is the preparing page (200) while the build continues unattended (`waitUntil` holds the coordinator call; the build proceeds whatever the reader does). Every later poll runs its own `ensure` — the per-isolate `SingleFlight` still shares any call still open, and the coordinator coalesces the rest — so the page is self-healing and the server stays stateless. A transport failure from the coordinator is #225's retryable 503; it never becomes a 404. "Ready but no pointer" (the coordinator answered while the store lost the pointer) is a broken store, so also a retryable 503.

The preparing page (`renderPreparingPage` in `src/repo-read/preparing.ts`) is `aria-busy`, announces itself politely (`role="status"`), polls its own URL with `fetch` (`cache: "no-store"`) after the response's `Retry-After` (5 s) doubling per attempt, capped at 60 s, pausing while the tab is hidden. The poll reads the state from `X-Rendro-Readiness` and the status: a 404 stops with "These docs are no longer available.", a `failed` state loads the retry page with `location.replace`, and anything else that is no longer `preparing` reloads into the docs. The server never polls itself from `waitUntil` and stores no per-reader state: any reader of the URL can re-check what any other is preparing. The retry page (503) is the same layout with `role="alert"` and a `Retry` link to the URL itself; the retry re-runs `ensure` (the coordinator records the failure but always re-attempts, so reader retries are fresh attempts).

| Response | `Cache-Control` | State header |
|---|---|---|
| Preparing page (200) and retry page (503) | `private, no-store` | `X-Rendro-Readiness: preparing` / `failed`, `Retry-After: 5` |

Enqueueing happens strictly after authorization, so an unauthorized reader neither leaks the repository's existence into the coordinator nor triggers a build; commit-pinned URLs and every non-shell target (frames, trees, tickets, files) are plain 404s with no enqueue. Where the binding is absent (today: production and the E2E worker), every URL under `/r/` behaves exactly as before, 404 included; no migration to `wrangler.toml` is made until the ingest Worker ships.

The binding is read per request through `services(c)`'s shape check (`durableFirstView`), shaped once per isolate per namespace (`WeakMap`). Tests: `tests/repo-read-routes.test.ts` (first-view dispatch, preparing/retry/404, single flight across requests, transport 503), `tests/repo-read-units.test.ts` (window race, outcomes, page rendering, backoff) and `tests/repo-read-first-view-workerd.test.ts` (real cross-script binding, gate on GitHub, preparing then docs).

### Viewer integration

The shell is `renderScopedDocumentShell` with the lazy tree, as for projects and publications:

- `data-document-base` is the URL the reader opened (`/r/o/r` or `/~branch`), so history and copied links follow the branch.
- `data-frame-base` pins frames and tree pages to the commit the branch served (lazy tree v46). A branch view therefore stays consistent while browsing; a reload picks up a newer commit.
- Tree pages come from the snapshot's sidebar index, with titles. Folders between the repository root and the docs root appear too, and a directory's landing page is its first child.
- Private shells add the private viewer's parent script (ticket renewal) and its update notice.
- The share button copies the viewer URL ("Copy link").

The frame wraps the sanitized page in Rendro's markup: the comment widget (#254), the hashed `repo-doc` stylesheet (GitHub-style typography plus `HIGHLIGHT_CSS`, kept identical by a test), the navigation bridge and, for private repositories, the ticket base and renewal client. Ingest emits repository-internal links and images relative to the document's own directory (see "Rendering and sanitizing"), so the frame resolves them under whatever commit, branch or ticket base it was loaded from without rewriting the HTML (#242). External images that ingest wrote as signed image-proxy paths (`/img/<sig>/<url>`, see "Image proxy") stay absolute, but only when `verifyImageProxyPath` accepts them, so a repository folder named `img` still resolves inside the repository. The derived body depends only on the render key, so it is derived once per isolate and kept in memory (a variant key prefixes `legacy-` for a version-2 render, which the read path still rewrites to the old `/<repo path>` form until the rebuild finishes). A page ingest could not render shows a notice instead.

### Bindings and configuration

| Binding | Type | Purpose |
|---|---|---|
| `REPO_CONTENT` | R2 | The ingest bucket (`gh/v1/`), read through #229's `ObjectStore` and `ContentSealer` |
| `REPO_EPOCHS` | KV | Revocation epochs |
| `REPO_ACCESS` | Service binding | The control Worker's permission source |
| `REPO_SEARCH` | D1 | The repository search index (#251); without it the search URL is the plain 404 |

None is configured in `wrangler.toml` yet. The control Worker exists (`wrangler.control.toml`, development and tests only, #243), and the owner wires both once the GitHub App exists ([SETUP.md](SETUP.md#github-repository-reads-not-configured-yet)). Until then every `/r/` URL is a 404 in production and development. `REPO_CAPABILITY_SECRET` is required now, so the secret exists before the bindings do. Test configurations add all four bindings to a copy of the production configuration (`e2e/repo-read-config.ts`): the E2E suite and `tests/repo-access-workerd.test.ts` with the real control Worker over a fake GitHub, `tests/repo-read-workerd.test.ts` with a fixture control Worker (`e2e/repo-access/`) that speaks the same protocol from grants it is given.

### Measurements

Measured with `tests/repo-read-workerd.test.ts` on 2026-10-18. Setup: the production Worker on local workerd (Wrangler's test harness), sequential keep-alive HTTP straight to workerd's socket, 200 requests per row (80 for the R2 row), two runs, on a shared i5-8300H with load average about 12. These are wall times through the local development stack. `/health` measures that stack's own floor (Miniflare's entry Worker, Hono's middleware, loopback), so the read path's server time is roughly the difference. The R2 row uses Miniflare's on-disk R2, not production R2, which publishes no latency figures. The cookie-miss row answers the session lookup in-process, so a real deployment adds one Convex round trip (once per reader, repository and five minutes).

| Request | p50 ms (run 1 / run 2) | p90 ms | Over `/health` (p50) |
|---|---|---|---|
| `/health` (Hono stack, no storage) | 5.2 / 5.1 | 9.3 / 8.0 | – |
| Cached private frame, capability cookie hit (HMAC verify + KV epoch + memory) | 7.5 / 9.3 | 13.7 / 20.1 | +2.3 / +4.2 |
| Cached public frame | 5.3 / 5.8 | 8.2 / 10.7 | +0.1 / +0.6 |
| Cached private shell at a branch URL (pointer from memory, ~150 KB HTML) | 7.9 / 7.9 | 12.8 / 12.8 | +2.7 / +2.8 |
| R2 miss (rendered page read from R2, parsed and rewritten; manifest warm) | 10.5 / 10.9 | 16.5 / 22.3 | +5.3 / +5.8 |
| Capability-cookie miss (session, KV epoch, control Worker over the service binding, new cookie) | 11.8 / 10.7 | 22.4 / 17.2 | +6.6 / +5.6 |

An earlier pair of runs at load about 9 (before the rewritten body was memoized) measured `/health` at 3.5–4.0 ms and a cached private frame at 5.3–6.3 ms, the same 2 ms above the floor. A cached view stays well inside the 10 ms server-time target. The shell costs more than a frame because it renders the full viewer template. In-shell navigation fetches only frames and tree pages, which are immutable at commit URLs.

### Open points

- The repository shell has no account menu: the capability cookie carries no display identity. P1's GitHub sign-in reworks the shell.
- `Server-Timing` phases and real-user monitoring (P0) for these routes.

## Repository Search (GitHub pivot, P7)

Full-text search over one repository's docs (#251, part of epic #214). Sections are indexed from the rendered hast at ingest into a D1 FTS5 table, and a bounded JSON endpoint under the read path's authorization answers queries that the shell's search box runs. The index is optional: without a `REPO_SEARCH` binding (production, until P-deploy provisions it) the search URL is the plain 404 and ingest behaves exactly as before.

| Module | Role |
|---|---|
| `src/ingest/sections.ts` | `extractSections(tree)`: document-order heading sections from the rendered hast; `sectionsFromHtml(html)` for the reuse path |
| `src/search/index.ts`, `d1.ts` | The `SearchIndex` interface and the D1 implementation (external-content FTS5 over a plain `sections` table) |
| `src/search/query.ts` | `neutralizeQuery`: free text → quoted trigram phrases; FTS syntax becomes separators |
| `src/repo-read/search.ts` | The query boundary: bounds, commit scoping by manifest, ranking passthrough |
| `src/lazy-tree/lazy-tree.ts` | The shell's search box: `/` focus, debounce, keyboard navigation, in-shell activation |

### Index model

One row per heading section: `(repo_id, blob_sha, slug)` primary key, plus the heading's title and the section's text; an external-content FTS5 virtual table (`tokenize='trigram'`) over it, kept in step by triggers, and queried with `bm25(sections_fts, 5.0, 1.0)` (the title weighs five times the body). Trigram was chosen over unicode61 because code identifiers must match: a search for `neutralizeQuery` finds the function's section, and a prefix-free quoted phrase (`"install"`) matches inside words, which a unicode61 term cannot without a prefix `*` operator that hostile input must never reach. The cost is the three-character minimum: terms shorter than three characters are dropped at the query boundary and match nothing at the index (a deliberate bound, announced in the UI).

Section text is extracted after heading ids are assigned but before link decoration and code highlighting, so it is plain prose. Each section's text (8,000 chars), title (512), the page's total text (200,000) and section count (256) are capped, and whitespace/control characters collapse to single spaces so the `\u0002`/`\u0003` code points stay reserved for query snippets. Rows are keyed by blob SHA and are content-addressed like renders: a blob rendered at two paths is indexed once.

### Incremental ingest hook

`buildSnapshot` gains an optional `search` (the `SearchIndex`; absent where no binding is configured). A fresh render indexes its blob's sections after the render object is stored; a reused render (a page moved, a key changed) re-indexes only when `hasBlob` says the blob has no rows, so unchanged blobs reuse their rows across commits instead of paying a rewrite per push — the same reuse discipline the render cache follows. Writes happen before the pointer flip, so a commit is served only once its pages are indexed; a D1 outage fails the attempt and the queue retries it. A snapshot built before the binding existed is not backfilled; it gains rows the next time one of its blobs renders or its render key changes (P-deploy can backfill once, if ever needed).

### Query endpoint

`GET /r/{owner}/{repo}[/{ref}]/search?q=&limit=` sits behind the same authorization as every other `/r/` read (#239): a denial is the plain 404, and the URL is script-read JSON, so its denial and errors are JSON like a tree page's, `private, no-store`. Bounds: `q` at most 200 characters (shared with the shell input's `maxlength`), `limit` clamped to 1–50 (default 20). `neutralizeQuery` never passes reader text to FTS5 as syntax: terms are reduced to `\p{L}\p{N}` runs of at least three characters (at most 16 terms, each at most 64 characters) and quoted, so `NEAR`, `*`, quotes, column filters and parentheses become separators and cannot error or widen the query.

Candidates are fetched at four times the page size, then mapped back onto the served snapshot's manifest by blob SHA: a hit is returned only when a renderable page of this exact snapshot carries that blob, so content that moved still resolves to its current path and nothing leaks across repositories or commits (the unit suite pins both). `more` reports that the candidate fetch filled up, approximately.

### Shell UI

The search box sits in the repository shell's sidebar (`renderRepoSearch`, markup also mirrored in the browser-test fixture). `/` focuses it from anywhere outside a typing context; typing is debounced (200 ms) into one request to the pinned commit's `/search`; results are a listbox of options with `path#slug`, the title and a snippet whose matched runs arrive wrapped in `\u0002`/`\u0003` and are rendered as `<mark>` text nodes — snippet text is never parsed as HTML. Arrow keys move the selection (wrapping), Enter or a click activates it through the same in-shell `loadDoc` a tree row uses, so the shell owns the history entry and the frame scrolls to the section. Escape, an outside click and the clear button close the panel. Loading ("Searching…"), empty and error states (with a Retry control) are announced through a `role="status"` live region, and the shell's `maxlength` bounds the input client-side. Asset version: lazy-tree 50.

### Measurements

Measured with `tests/repo-read-workerd.test.ts` on 2026-10-19 (`search query (1,000-page repo, limit 20)`, 200 sequential keep-alive requests cycling four terms): p50 11.6–18.3 ms and p90 14.5–30.4 ms wall time through local workerd and its local D1 (Miniflare SQLite) across runs, on the shared i5-8300H under load 12–15, against the 50 ms p50 target. Roughly `/health`'s 3.2 ms stack floor plus the FTS5 MATCH + bm25 ranking over 1,000 pages and the commit-scoping map. Production D1 adds its network round trip in place of Miniflare's in-process SQLite.

### Open points

- No index GC: rows of blobs a repository no longer contains stay until P9's purge removes the repository's D1 prefix wholesale (purging one repository is one D1 delete by `repo_id`).
- Backfill of pre-existing snapshots (above) is manual if ever needed.
- The abuse-driven FTS settings (16 terms, 64 chars each, 200-char queries) are generous for humans and bounded for robots; tightening later is a constant change.

## Repository Permission Mirror (GitHub pivot, P5)

This section covers who may read which repository (#243, part of epic #214): the permission source and revocation epochs the read path's contract asks for (above). GitHub is the authority; the control Worker keeps a mirror current enough that a view never waits on GitHub, and it fails closed: anything it cannot decide is a 503, never a grant. It is built and tested against a fake GitHub (`tests/helpers/fake-github.ts`). Real sign-in (P1) plugs into two interfaces: the account hand-over below, and `InstallationTokenProvider` (#229) for installation tokens.

| Module | Role |
|---|---|
| `src/repo-access/worker.ts`, `entry.ts` | The control Worker: routes, configuration checks, the `RepoAccessDirectory` Durable Object class |
| `src/repo-access/directory.ts` | The directory: registry, per-user mirrors, single-repository checks, webhook application, the epoch outbox |
| `src/repo-access/events.ts` | Webhook payload → plan (pure) |
| `src/repo-access/github.ts` | The permission endpoints, paced by a `RateGovernor` per user and per installation |
| `src/repo-access/tokens.ts` | User-to-server tokens: sealing at rest, refresh |
| `src/repo-access/removal.ts` | `confirmRemoval`: asks GitHub whether the app has truly lost a repository before anything of it is purged (#258) |

### Control Worker

`wrangler.control.toml` defines `rendro-control-dev`. It has no route, no `workers.dev` URL and no deploy script, and `wrangler.toml` does not bind it yet. It answers:

| Request | Who sends it | What it does |
|---|---|---|
| `POST https://repo-access.internal/v1/authorize` | The serving Worker (`REPO_ACCESS`) | `repoAccessHandler` over the directory: the read path's protocol (#234) |
| `POST https://repo-access.internal/v1/accounts/link` | P1's sign-in | `{ userId, githubId, login, tokens }`: binds a Rendro user to a GitHub account and stores its user-to-server tokens. 204, no body |
| `POST https://repo-access.internal/v1/accounts/unlink` | P1's sign-out of GitHub | `{ userId }`: drops the tokens and mirror and revokes the user |
| `POST /v1/github/webhook` | GitHub | Permission events. 202 applied, 200 duplicate, 204 ignored, 400 malformed, 401 bad signature, 503 not configured |

Internal endpoints answer only requests addressed to `repo-access.internal`, a host only a service binding can send, so the public route the webhook will need never exposes them.

One Durable Object, `RepoAccessDirectory` (named `directory`, SQLite-backed), holds everything. A single instance makes the registry and the mirrors change consistently, and every `authorize` reaches it only on a capability-cookie miss (at most once per reader, repository and five minutes) or for an anonymous reader whose isolate has not seen the repository in a minute. That is the scaling limit to watch; sharding mirrors by user is the next step when it binds.

### What the directory keeps

- **Registry**: every repository the app can see (`repo:<id>`: owner, name, visibility, default branch, installation, removed, `check`), a name index, and each installation's state (`active`, `suspended`, `deleted`). A name resolves only to an active repository in an active installation.
- **Mirror per user**: the repository IDs `GET /user/installations` and `GET /user/installations/{id}/repositories` list for the user's token, with each page's ETag. A mirror is used for `MIRROR_TTL_MS` (five minutes), then refreshed with conditional requests (a 304 costs no primary quota). A listing stops after 20 pages of 100; an installation listed only in part falls back to `GET /repos/{o}/{r}/collaborators/{login}/permission` (installation token) for the one repository asked about, cached like a mirror. GraphQL `viewerPermission` would only help batch many single checks, which the listing already avoids, so it is not used.
- **Who holds what**: `holder:<repo>:<user>` and `member:<installation>:<user>`, written before the mirror they come from, so every user a mirror lets read a repository can be found when it must be revoked.
- **Tokens**: sealed (below), with a version that changes whenever they are replaced or dropped.
- **Delivery dedupe** (#229's, `DeliveryDedupe`) and the **epoch outbox**. Where comments are configured, the outbox also holds `notify:<user>` (an epoch Convex has not heard yet), `removed:<repo>` (a repository that left the app) and `restore:<repo>` (one GitHub says the app still has), so comment grants end with page access ([Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6)). Of a removal and a restore for one repository only the newer stays queued.
- **Purge ledger** (#258): `purge:<due time>:<repo>`, earliest first, with `purging:<repo>` naming each repository's one entry ([below](#purging-removed-repositories)).

`authorize(viewer, owner, name)`: resolve the name in the registry; a public repository is granted to anyone. Otherwise an anonymous reader, an unknown user or a user without tokens is denied. A linked user's mirror is refreshed if stale (single flight per user), the name is resolved again (a listing may have taught the registry a repository no webhook announced), and the repository is granted only if the mirror lists it, or the single-repository check says so.

### Webhooks

Deliveries are verified with #229's `readVerifiedWebhook` (HMAC-SHA256 over the raw body, 25 MB cap, nothing parsed before the signature matches) and deduplicated by `X-GitHub-Delivery`. A delivery is remembered once it is applied, so a failure stays retryable.

A signature covers the body, not the delivery ID, and payloads carry no timestamp, so a captured body could be replayed under a new ID. Plans are therefore built so that a payload can only deny:

| Event | Registry | Users reached | Epoch bump |
|---|---|---|---|
| `member` added / edited / removed | – | The named user | edited, removed |
| `membership` added / removed | – | The named user | removed |
| `organization` member_added / member_removed | – | The named user | member_removed |
| `organization` renamed | Owner renamed, repositories re-checked | – | – |
| `organization` deleted | Installation deleted | Everyone the installation lists | yes |
| `team` removed_from_repository, edited (with a repository) | – | Holders of the repository | yes |
| `team` deleted, edited (without one) | – | Everyone the installation lists | yes |
| `team` created, added_to_repository | – | Everyone the installation lists | – |
| `repository` deleted | Removed | Holders | yes |
| `repository` privatized | Private at once | – (cookie holders keep access) | – |
| `repository` transferred | Re-checked | Holders | yes |
| `repository` publicized, renamed, edited, created, … | Re-checked | – | – |
| `installation` deleted / suspend | Deleted / suspended | Everyone the installation lists | yes |
| `installation` created / unsuspend / new_permissions_accepted | Active, re-checked; announced repositories re-checked | Everyone the installation lists | – |
| `installation_repositories` added / removed | Re-checked / removed | Installation users / holders | removed |
| `github_app_authorization` revoked | – | The named user: tokens and mirror dropped | yes |

"Re-checked" sets `check`: before that record grants anything again, the directory asks GitHub with an installation token (`GET /repos/{o}/{r}`, or `GET /installation/repositories` for an installation, whose token GitHub refuses once suspended). A replayed `publicized` or `unsuspend` therefore grants nothing GitHub does not confirm. Reaching a user means a new generation: their mirror and single-repository checks are no longer used, and the next authorize asks GitHub. People events never trust the payload's direction either; GitHub's listing decides.

**Order.** The plan updates the registry, then reaches users (mirrors are now stale, so `authorize` already asks GitHub and denies), then queues the epochs, remembers the delivery and writes the epochs. Epochs are written from a durable outbox (`pending:<user>`): inline after each delivery, and by the Durable Object's alarm, which also retries failed KV writes every 10 s. Each value is `max(now, previous + 1)` in milliseconds, written by one serialized pass at a time, so a user's epoch only grows. KV keys expire after an hour (`EPOCH_TTL_SECONDS`): an epoch outlives every capability minted before it (cookies five minutes, tickets fifteen), and KV holds only recently bumped users, which is what KV Instant needs.

**Races.** The Durable Object's input gates open while it awaits GitHub, so a webhook can land mid-refresh or mid-check. Two rules keep a stale grant out:

- Every answer is decided from storage alone, with no other await in between, so it reflects every webhook applied so far. When the decision needs GitHub first (an installation or repository check, a stale mirror, a single-repository check), that work runs and the decision is taken again from storage afterwards. After six rounds (webhooks kept changing the answer) it is a 503.
- GitHub work never commits a result an event overtook. A refresh records the user's generation and the registry's event sequence when it starts. It commits nothing if the user's generation changed, and it never overwrites a registry record an event changed after it started (tombstones included). A repository or installation check, or a single-repository check, is dropped the same way. So a listing GitHub sent before a revocation is never committed after it, and an uninstall that lands while a repository is being confirmed decides that very request.

### Failing closed

| Situation | Answer |
|---|---|
| GitHub error, timeout or rate limit while a mirror is fresh | The mirror answers (within `MIRROR_TTL_MS`) |
| The same once the mirror is stale | 503; for 5 s (`FAILURE_COOLDOWN_MS`) the same work answers 503 without calling GitHub again |
| Token near expiry | Renewed first (one renewal per user at a time: GitHub rotates the refresh token on use) |
| Renewal fails (network, 5xx, no OAuth client configured) | 503 |
| GitHub refuses the refresh token, or refuses a freshly renewed access token | The user is forgotten (tokens and mirror dropped, epoch bumped): private repositories are denied until they sign in again |
| Stored tokens cannot be opened (another key) | 503 |
| Unknown user, no tokens, no installation | Denied (public repositories stay readable) |
| A `check` that GitHub cannot answer | 503 |
| `GITHUB_TOKEN_KEY` missing, under 32 characters or equal to another secret | Every directory request 503 |
| `GITHUB_WEBHOOK_SECRET` missing | Webhooks 503 (GitHub records a failure the reconciler can redeliver) |

### Tokens

User-to-server tokens (`{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`) are stored as `v1.<IV>.<ciphertext>`: AES-256-GCM with a fresh 12-byte IV, under a key derived with HKDF-SHA256 from the dedicated `GITHUB_TOKEN_KEY` secret and imported once per isolate. The additional data is the Rendro user ID, so a sealed value moved to another user does not open. Tokens never appear in a response, a log line or the serving Worker. Refresh uses GitHub's documented `POST /login/oauth/access_token` with `grant_type=refresh_token`; only `bad_refresh_token` is final. Rotating the key secret makes stored tokens unreadable (503) until users sign in again.

### Rate budget

User-token requests go through a `RateGovernor` per user (`user:<id>`: user tokens share the user's own 5,000 per hour) and installation-token requests through one per installation (`installation:<id>`), at most 1,000 budgets in memory. A refresh costs one `GET /user/installations` page plus one page per 100 repositories per installation, all conditional; it runs at most once per user per mirror TTL, or after an event reaches the user. Unknown names never reach GitHub.

### Revocation bounds

From GitHub's change to the first denied view:

| Change | Bound |
|---|---|
| Covered by a webhook, KV Classic | GitHub's delivery latency (unpublished; usually seconds) + the control Worker (measured below) + the epoch reaching the reader's colo: KV Classic is visible elsewhere within about 60 s, the serving Worker's `cacheTtl: 60` adds up to a minute, so expect 60–90 s |
| Covered by a webhook, KV Instant | Delivery latency + under a second (p99 256 ms replication); the serving Worker's `cacheTtl` would then be the floor to lower |
| If the epoch never arrives (KV outage) | The cookie's five minutes for pages and branch views; fifteen minutes for frame resources through a ticket already issued |
| No webhook (enterprise policy, a lost delivery the reconciler has not redelivered) | Mirror TTL + cookie lifetime: at most ten minutes for pages (tested: `tests/repo-access-revocation.test.ts`); a ticket issued just before can add its fifteen minutes for frame resources of that commit |
| Repository made private, anonymous readers | Delivery latency + the serving isolate's one-minute public-repository memory (no epoch involved) |

Measured on workerd (`tests/repo-access-workerd.test.ts`, 2026-10-18, final code, local machine at load about 10, 25 revocations per run, two runs). The production Worker reads through the real control Worker over the service binding. KV is Miniflare's, with no propagation delay, so "delivery to first denied view" is only the Workers' own share. `/health` is the local stack's floor. The refresh rows include the harness's round trip from workerd to the fake GitHub in the Node test process, which dominates them.

| Request | p50 ms (run 1 / run 2) | p90 ms |
|---|---|---|
| `/health` (floor) | 4.2 / 4.7 | 5.7 / 10.1 |
| Webhook: verify, apply in the directory, write the KV epoch | 10.4 / 11.7 | 12.0 / 15.8 |
| Delivery to the first denied view (includes that view's mirror refresh) | 67.9 / 55.5 | 75.3 / 74.4 |
| Capability-cookie miss, fresh mirror (session, epoch, control Worker) | 11.4 / 12.3 | 13.0 / 20.2 |
| Capability-cookie miss with a mirror refresh (two conditional GitHub requests) | 86.6 / 94.0 | 99.1 / 100.6 |

Real GitHub adds its own latency to a refresh (typically 100–300 ms per request from the edge, unmeasured here); it is paid once per user and mirror TTL, or after an event, never on a cookie hit.

### Bindings and configuration (development and tests only)

| Binding | Type | Purpose |
|---|---|---|
| `REPO_ACCESS_DIRECTORY` | Durable Object `RepoAccessDirectory` (SQLite, migration `v1`) | The directory |
| `REPO_EPOCHS` | KV | Epochs, written here; the serving Worker binds the same namespace to read them |
| `GITHUB_TOKEN_KEY` | Secret, required | Seals stored user tokens. Dedicated: never equal to another secret |
| `GITHUB_WEBHOOK_SECRET` | Secret, required | The GitHub App's webhook secret |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | Var and secret, optional until P1 | Token refresh; without them an expired user token is a 503 |
| `GITHUB_DEV_TOKEN` | Secret, optional | Installation token for checks until P1 mints installation tokens |
| `GITHUB_API_ORIGIN`, `GITHUB_WEB_ORIGIN` | Vars, optional | Point at a fake GitHub; the defaults are `api.github.com` and `github.com` |
| `CONVEX_URL`, `CONVEX_INTERNAL_SECRET` | Var and secret, optional | Comments (#254): Convex hears every epoch and removed repository. Both are needed; without them comment grants end with their own lifetime (at most five minutes) |

What the owner configures later is in [SETUP.md](SETUP.md#github-repository-reads-not-configured-yet).

### Purging removed repositories

Hiding on a restrictive payload is safe, because a replay can only deny. Deleting is not: a replayed `installation_repositories` removal or `installation` deletion would otherwise hide a repository that is still installed, then purge its data if nobody read it in the meantime. So hiding stays immediate (the registry, the mirrors, the epochs and Convex's `removeRepos` exactly as above), and only the irreversible step waits for GitHub:

1. A removal (a repository removed or deleted, or every repository of a deleted installation) puts the repository in the purge ledger, due `REMOVAL_PURGE_DELAY_MS` (30 days) later. A repeated removal keeps the first time.
2. The Durable Object's alarm takes due entries, 20 at a time (`PURGE_BATCH`), and asks `confirmRemoval` with the repository's installation token (`InstallationTokenProvider`): `GET /repos/{o}/{r}`, and on a 404 `GET /installation/repositories?per_page=1`, so only a token GitHub accepts as the installation's can prove the repository gone. A provider that mints tokens (P1) reports a deleted installation as `GitHubError("not-found")`, which also confirms it.
3. The answer decides:

| GitHub says | What happens |
|---|---|
| Removed | Convex is asked to purge (`purgeRepos`). Convex keeps its own window and names any repository not due yet, which is rescheduled for then. A failed call is postponed and confirmed with GitHub again; an earlier answer is never reused |
| Still accessible (same repository ID) | The registry record is restored from GitHub's answer, an installation marked deleted or suspended is re-checked on the next read, the entry is dropped and `restore:<repo>` tells Convex (`restoreRepos`, with an audit event). Nothing is deleted |
| Unknown: no installation or no token, an outage, a rate limit, a suspended installation, another repository under the name | Postponed: 15 minutes (`PURGE_RETRY_MS`), doubling up to a day (`PURGE_RETRY_MAX_MS`). Never purged on doubt |
| Anything decided while an event changed the record, or while Convex has not yet heard of the removal | Postponed the same way |

A single-repository check that finds the repository accessible during the window (a reinstall: the `added` event marks it for a check, and the next read asks GitHub) cancels the purge and restores the comments at once; a later removal starts a new window. The alarm is re-armed for the earliest entry after every pass, never later than a retry the outbox needs sooner. Logs carry counts only (`access.purge`, `access.removal-reverted`); the audit trail is Convex's `auditEvents` (`repository.removal_reverted`, `repository.comments_purged`). P9's R2 purge on uninstall is to call `confirmRemoval` the same way before deleting anything.

### Open points

- One GitHub App has one webhook URL, but push events go to the ingest Worker (#229) and permission events here. P1 decides on a single ingress; the recommendation is the control Worker verifying once and forwarding `push` to the ingest queue.
- The account hand-over is a service-binding call; if P1's sign-in runs in Convex rather than a Worker, it needs an authenticated public path instead.
- Asset tickets live fifteen minutes and are only epoch-checked, so a missed webhook can leave frame resources of an open commit readable that long; five minutes would match the cookie.
- With KV Instant, the serving Worker's `cacheTtl: 60` becomes the dominant term.
- Commit-pinned frames of public repositories are cached `public, immutable`; a repository made private stays readable from browser caches that already hold a page.

## Comments on Repository Docs (GitHub pivot, P6)

This section covers inline comments on pages the read path serves (#254, part of epic #214). Who may read or write a repository's comments is exactly who may read the repository: the read path decides, Convex enforces, and P5's revocations end both together. The widget and the parent protocol are the ones project documents use ([Inline Comments](#inline-comments)); only the anchor, the scope and the authorization are new.

```text
repo frame (widget, no network) ──postMessage──► repository shell ──one Convex client──► repoComments (queries, mutations)
                                                    │                                         ▲ checks
                                                    └─ POST /r/{owner}/{repo}/comment-access ─► serving Worker: authorizeRepo ─► repoCommentAccess.grant
control Worker (P5) ── epoch / uninstall ──► repoCommentAccess.revokeUser / removeRepos ────────────────────┘ deletes grants
                    ── after GitHub confirms (#258) ──► repoCommentAccess.purgeRepos / restoreRepos
```

| Module | Role |
|---|---|
| `convex/repoCommentAccess.ts` | Grants, epochs, removed repositories, expiry and purge; `repoCommentReader` decides every read and write |
| `convex/repoComments.ts` | Threads and replies: bounded, indexed pages and the writes |
| `src/repo-read/comments.ts` | The serving Worker's half: records grants after `authorizeRepo`, and the frame's widget tag |
| `src/repo-access/comments.ts` | The control Worker's Convex sink for the epoch outbox and the purge ledger |
| `src/commentor/repo-anchor.ts` | Anchors: making them from a selection, finding them again |
| `src/commentor/parent-host.ts` | The shell: repository scope, anonymous reads, access renewal, `ConvexRepoCommentBackend` |

### Anchors that survive commits

A thread anchors to `(repoId, path, blobSha, headingSlug, textQuote{prefix, exact, suffix})` plus the quote's offset in its section. A page's sections run from one heading to the next, named by ingest's heading ids (`user-content-<slug>`, #215); text before the first heading is the section `""`, and a heading without an id (emoji-only) stays in the section before it. A selection must lie in one section; the context is up to 32 characters each side, the quote at most 4,096.

Finding the anchor in the page a reader is shown, in the frame:

1. The section must exist, else the thread is **orphaned**.
2. On the blob the comment was made on, the quote must sit exactly at its offset (this also tells two identical quotes in one section apart).
3. Otherwise (a new commit changed the page, or the offset is wrong) the quote is searched in that section: exactly one occurrence with its full prefix and suffix wins; failing that, the only occurrence of the quote at all; anything else is orphaned.

An orphan is listed in the drawer as "Anchor no longer found" and never pinned. There is no fuzzy matching, so a comment never jumps to other text. Nothing is re-anchored on the server: the stored anchor is untrusted client data that only ever selects text by these checks, so a forged anchor can at worst find nothing. An unchanged blob therefore keeps its anchors exactly, whatever else the commit changed. Convex lists a page's threads by `(repoId, path)`; `(repoId, blobSha)` indexes them by blob (the purge walks it).

### Authorization at the Convex boundary

Convex cannot reach the permission source or read KV, so it holds **grants** that only the read path writes:

- The repository shell (`RENDRO_REPO_COMMENT_CONFIG`) calls `POST /r/{owner}/{repo}/comment-access`, same-origin only. The route runs `authorizeRepo`, the same order as a page view (public-repository memory, capability cookie and epoch, then session, epoch and permission source), and a denial is the read path's plain 404.
- A granted request records `repoCommentAccess:grant` with `CONVEX_INTERNAL_SECRET`: `{ repoId, userId, epoch, expiresAt }`, where `userId` is null for a public repository and `expiresAt` is the authorization's own bound (`RepoGrant.until`: the capability cookie's expiry, at most five minutes, or the isolate's one-minute public-repository memory). The route asks `authorizeRepo` for at least 30 s of that (`COMMENT_GRANT_MIN_MS`): a memory or cookie closer to its end is decided again, as if it had lapsed, so a grant always outlives the shell's renewal halfway through it and comments never flicker out between renewals. Convex caps it at five minutes and schedules one `expireGrant` per grant. Each isolate reuses a grant still more than half fresh, so many readers of one public repository make one write, and Convex extends a grant only when it moves by more than 10 s (`GRANT_EXTEND_SLACK_MS`), because every write to it re-runs the comment queries that read it.
- Every query and mutation calls `repoCommentReader` first: the repository must not be removed, and a grant must exist for it, either public (anyone reads; signed-in users write) or for the signed-in user. Queries read only these rows, never the clock (#159), so a cached result changes exactly when a grant is written or deleted. Mutations also compare the grant's expiry with the clock.
- A denial reveals nothing: reads return an empty page (`{ page: [], isDone: true }`, the same as a repository nobody has commented on), writes fail with "not found", like a missing thread. Thread and reply IDs are checked against the repository and page only after that, so an ID from another repository is "not found" too. Anonymous writes are "unauthenticated".
- The shell renews its grant halfway through (at least every 15 s, at most a minute apart while failing; a denial is retried after a minute), holds renewals while the tab is hidden, and tells the widget whether this reader may write (`canWrite` in the ready message): repository frames are the same for everyone and cached publicly, so their widget configuration (`data-commentor-config`: repository, page, blob) says nothing about the reader.

**Revocation.** P5's epoch outbox writes each epoch to KV, then sends the same value to `repoCommentAccess:revokeUser` (an outbox entry of its own, `notify:<user>`, so a Convex outage never rewrites KV). Convex records it, deletes the user's grants, and refuses any grant decided before it (a lower epoch), so a revoked reader's open subscription empties at once. The bounds are therefore those of page views, or tighter:

| Change | Comments end |
|---|---|
| Covered by a webhook | When the control Worker applies it (before KV propagates) |
| The Convex call fails | Retried by the outbox alarm every 10 s; the grant's own expiry (at most five minutes) bounds it meanwhile |
| No webhook | Mirror TTL + the cookie the grant rests on: at most ten minutes, as for pages |
| Repository made private, anonymous readers | The public grant's one minute, as the isolate memory for pages |
| Comments not configured on the control Worker | The grant's expiry: at most five minutes |

**Public repositories.** Anyone may read. Writing needs a signed-in session (the shell's Convex JWT) and the public grant, and is rate limited like project comments: 30 writes a minute per user and 300 per repository (`consumeWriteQuota(ctx, "comments", user, "repo:<id>")`). Author names are shown, email addresses never (a public repository's comments are public).

### Data model and retention

| Table | Indexes | Holds |
|---|---|---|
| `repoCommentGrants` | `by_repo_user`, `by_user` | Live grants |
| `repoCommentEpochs` | `by_user` | The latest epoch P5 reported per user |
| `repoCommentRepos` | `by_repo` | A repository readers have seen, and `removedAt` once GitHub reported it gone |
| `repoThreads` | `by_repo_path` (with `deletedAt`, `createdAt`), `by_repo_blob`, `by_operation` | Threads: anchor, body, author, resolved, archived |
| `repoReplies` | `by_thread` (with `deletedAt`, `createdAt`), `by_operation` | Replies |

Pages are bounded like project comments: 20 threads (24 rows, 1 MB read) with the newest 10 replies each, and 20 replies per reply page. Creates and replies are deduplicated by `clientOperationId`; resolve and archive take an explicit target, so a retry is a no-op. Anyone who may write may resolve; archive and delete belong to the author. Deleting a thread leaves a scrubbed tombstone and scrubs its replies in batches of 100.

**Uninstalled repositories.** When GitHub reports a repository removed from the installation or deleted, or the installation or organization deleted, the control Worker's outbox (`removed:<repo>`) calls `repoCommentAccess:removeRepos`. Its comments are **hidden at once** (`removedAt`; every grant deleted). Convex never purges on its own: after 30 days the control Worker confirms the removal with GitHub ([Purging removed repositories](#purging-removed-repositories)) and only then calls `repoCommentAccess:purgeRepos`, which checks the window again against its own `removedAt` (`REMOVED_REPO_RETENTION_MS`; one not due yet is named in the answer), records `purgeConfirmedAt` and an audit event, and deletes in batches of 20 threads and 100 replies. A batch job runs only for a confirmed purge. If GitHub still grants the repository (a replayed removal, a reinstall), `repoCommentAccess:restoreRepos` clears `removedAt` and any confirmation, with an audit event, and a running purge stops at its next batch. A grant recorded more than a minute after the removal (`REMOVAL_SETTLE_MS`; anything sooner may have been decided before it) also means the repository is back. A suspended installation hides comments through access alone and purges nothing.

### Commentor integration

The frame adds `<script defer src="/commentor.js?v=…" data-commentor-config="…">`. Its policy allows exactly that script and the widget's one shadow-root stylesheet by hash (`COMMENTOR_STYLE_HASH`, checked against `src/commentor/styles.ts` by a test), never `'unsafe-inline'`, and still has no `connect-src`: the widget cannot open a connection, so the shell's client is the only one. The parent host derives the scope from the frame's URL (`parseRepoPath`, the shell's own repository at any ref) and the shell's repository ID, ignoring anything the frame claims. Click-to-comment anchors to the clicked element's text; an element without text asks for a selection. Sign-out in another tab ends comments like everywhere else; a reader who was never signed in stays an anonymous reader.

Tests: `tests/repo-comments-convex.test.ts` (access, revocation, removal and purge, forged anchors, cross-repository IDs, oversized text, rate limits), `tests/repo-comments-routes.test.ts` (the access route and frame policy), `tests/repo-access-comments.test.ts` (the outbox), `tests/repo-access-purge.test.ts` (the purge ledger with the directory and Convex together: a replayed removal never purges, a real one purges after the window, an outage postpones, a reinstall restores), `tests/repo-access-removal.test.ts` (`confirmRemoval`), `tests/repo-anchor.test.ts`, `tests/repo-comments-host.test.ts`, `tests/repo-comments-browser.test.ts` (the real frame and widget in Chromium) and `e2e/repo-comments.spec.ts` (create, reply and resolve; an unrelated commit; an orphan; a revoked reader; an anonymous reader).

---

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
| Repo docs rendered and sanitized once at ingest | comrak (cmark-gfm lineage) is linear on hostile Markdown; a parse5 allowlist with a fixed-point re-parse check is the XSS boundary, and readers never pay render cost |
| Stateless repository capability cookie plus revocation epoch | A cached repository page view verifies one HMAC and reads one epoch; GitHub and the database are reached only on a cookie miss, and revocation reaches every colo with the epoch store |
| One Durable Object for the permission registry and mirrors; webhook payloads may only deny | Registry and mirrors change consistently and races with webhooks are detectable; a replayed body cannot grant, because permissive changes are confirmed with GitHub first |
| Comment access as Convex grants written by the read path, deleted by expiry jobs and P5's epochs | Convex cannot ask GitHub or read KV; grants make every comment read and write follow the page view's decision, keep queries free of clock reads, and end with page access |
| Repository comment anchors re-found in the frame, never re-anchored on the server | Heading slug plus quote with strict uniqueness rules cannot jump to other text, and an untrusted anchor stays data |

## Known Limitations

1. There is no search. Rendro does not index document content.
2. Publisher HTML is rendered in sandboxed iframes and can still produce its own internal scroll behavior.
3. Publication slugs are global, so product naming policy must account for collisions.
4. Retention cleanup needs R2 credentials in the scheduled GitHub environment; bounded runs may take multiple daily invocations to finish a large backlog.
5. Legacy slug-based routes remain only for the staged migration window and must be removed after production verification.
6. The first Convex HTTP action after a cold start can add latency.
