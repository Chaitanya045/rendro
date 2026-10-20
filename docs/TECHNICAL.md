# Rendro — Technical

Technical reference: architecture, data flow, routes, design decisions, and operational details.

> For the chronological evolution of these decisions, see [docs/HISTORY.md](HISTORY.md).
> Dated QA and performance reports live in [docs/archive/](archive/README.md). They are point-in-time evidence, not current guidance.

---

## Architecture

Rendro renders the Markdown in a GitHub repository as navigable documentation, with inline comments, for the people who can read that repository (#286). Nothing is uploaded: a GitHub App's webhooks drive ingest, and every page view is authorized against the repository's own permissions.

```text
Browser
   │ session cookie, repository capability cookie
   ▼
Serving Worker (`rendro`, src/worker.ts, Hono)
   ├── landing, email sign-in, /home, /account/security
   ├── /api/auth/* proxy ───────────────► Convex: Better Auth component (users, sessions, accounts)
   ├── /r/{owner}/{repo} read path ─────► R2 snapshots, KV revocation epochs, D1 search
   │        └── permission source ──────► Control Worker (service binding)
   ├── comment access (POST …/comment-access) ► Convex app tables (repository comment grants)
   ├── /img/<sig>/<url> image proxy
   └── POST /rum real-user monitoring ──► Workers Analytics Engine

Ingest Worker (`rendro-ingest`, src/ingest/orchestrator/entry.ts)
   queue consumer + coordinator Durable Object: fetch a commit, render its Markdown, write R2, index D1

Control Worker (`rendro-control`, src/repo-access/entry.ts)
   GitHub App webhooks, permission directory Durable Object, writes KV epochs, tells Convex about revocations
```

### Component Roles

| Component | Technology | Purpose |
|---|---|---|
| **Serving Worker** | Hono on Cloudflare Workers (`wrangler.toml`) | Pages, the auth proxy, the `/r/` read path, image proxy, static assets |
| **Ingest Worker** | Workers, Queues, a Durable Object coordinator (`wrangler.ingest.toml`) | Fetches a commit from GitHub, renders and sanitizes its Markdown, writes immutable snapshots to R2 and the search index to D1 ([Repository Content Ingest](#repository-content-ingest-github-pivot-p3a), [orchestration](#repository-ingest-orchestration-github-pivot-p3b)) |
| **Control Worker** | Workers, a Durable Object directory, KV (`wrangler.control.toml`) | Mirrors GitHub repository permissions, receives webhooks, writes revocation and visibility epochs ([Repository Permission Mirror](#repository-permission-mirror-github-pivot-p5)) |
| **Identity** | Better Auth Convex component | Email and password accounts, email verification, sessions, rate limits |
| **Application data** | Convex | Repository comment grants, threads and replies, write quotas, audit events |
| **Browser UI** | Server HTML + vanilla TypeScript bundles | Landing, auth and account pages, the repository shell (lazy tree, search, comments) |

The serving Worker reaches R2 only through the read path's bindings; there are no storage credentials, and every bucket must stay private (see [R2 bucket privacy](#r2-bucket-privacy)). Local development and the E2E suite use Miniflare's R2, KV, D1, Queue and Durable Object simulations; nothing needs Docker for storage.

### R2 bucket privacy

Worker routes are the only authorization boundary, so no bucket may be reachable any other way: no managed `r2.dev` URL and no custom domain. `pnpm check:r2-public` (`scripts/check-r2-public-access.ts`) asks the Cloudflare API for both lists for every bucket in the three Worker configurations (`wrangler.toml`, `wrangler.ingest.toml`, `wrangler.control.toml`) and exits non-zero if either is enabled, if a custom domain is attached at all, or if a bucket cannot be verified. It needs `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` limited to R2 read access; without them it exits `2` ("was NOT verified"), never `0`. `--dry-run` prints the requests without credentials. `.github/workflows/r2-public-access.yml` runs it daily and on demand with those two repository secrets, and as a dry run on pull requests that touch the script, the workflow or a Worker configuration.

---

## Authentication

Better Auth runs inside Convex HTTP actions (`convex/auth.ts`). The Worker proxies `/api/auth/*` to Convex and never stores sessions itself. Email and password is the only sign-in method until GitHub sign-in (P1); Google sign-in was removed (#286).

### Sign-in methods

| Method | Behavior |
|---|---|
| Email and password | `POST /api/auth/sign-up/email` and `/api/auth/sign-in/email`. Email verification is required before sign-in; verification is sent on sign-up and sign-in. Passwords are 15–128 characters |
| Password recovery | `/forgot-password` and `/reset-password`; reset tokens expire after one hour and revoke existing sessions. A reset also creates the password of an account that had none |
| Initial password | `POST /api/auth/set-initial-password` (custom Convex route) lets a signed-in account without a password add one from `/account/security`. Accounts created with the retired Google sign-in have no password; they add one here, or through password recovery |

Sign-up responses do not reveal whether an address is already registered. Better Auth rate limits are stored in the database; sign-in and sign-up endpoints have tighter per-route limits. Verification, reset and existing-account notices are sent through Resend (`RESEND_API_KEY`, `AUTH_EMAIL_FROM`). Delivery retries transient transport failures and provider 5xx/429 with bounded immediate attempts, and logs the outcome when it still fails; the sign-up response stays neutral either way, and users retry through the resend form. Account linking keeps its guards (a verified local email, matching emails, never unlinking the last method) for the next OAuth provider.

The provider-neutral OAuth error path stays for GitHub sign-in: `/api/auth/error` and any upstream redirect to it are rewritten by the Worker to `/sign-in?error=<code>`, which shows fixed copy for cancellation, an expired or mismatched state, a failed link and unknown codes, never the upstream text.

`/account/security` loads the account's sign-in methods from the browser (`/api/auth/list-accounts`) but reserves the final layout at first paint (#312). The live method list shares a grid cell with an invisible, inert copy of every row the lookup can end in (loading, configured, not configured, failed), and the controller clones the matching row into the list. Both password sections stack in one cell with a section skeleton, the inactive ones `visibility: hidden` rather than `display: none`. The card is therefore as tall as its tallest outcome from the start, and the footer links never move.

The local authentication regression suite (`e2e/auth.spec.ts`) exercises these
flows against workerd and the disposable Convex backend, with captured mail.
Original signup verification and resend are separate journeys; reset mismatch
asserts no request, and the shared sign-out helper waits for method loading to
settle before clicking the moving footer control. Sign-out asserts hidden, inert
protected containers in both tabs. Expiry tests age disposable backend records;
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
whether an account exists.

Auth-page styles enforce `[hidden]{display:none!important}`, so layout rules
cannot expose inactive controls. Sign-up success hides the credential form; both
sign-up and password-reset success focus the labelled confirmation panel. Failed
requests retain the form and allow retry; following the sign-in/create-account
links returns to fresh, enabled controls with the original destination preserved.
Auth templates and their runtime are inline in no-store HTML, outside the
versioned bundles.

A signed-in reader lands on `/home` (the root redirects there, and so does a
sign-in without a destination). It names the account, explains how to open a
repository at `/r/{owner}/{repo}`, and links to account security and sign-out.
Until GitHub sign-in can list the reader's repositories, that is all it does.

### Session lifetime

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
refresh or cookie persistence, including Worker reads and viewer-ticket
authorization. Only endpoints that never resolve the caller's session (`/ok`,
`/error`, `/sign-out`, and Convex JWKS/OpenID discovery) skip the plugin; a test
enumerates every Better Auth endpoint to keep that list exact. The plugin runs
after the read limiter and reuses its resolved session; it does not bypass rate
limits. Password changes that revoke sessions carry the authenticated session's
choice into the replacement session and cookie.

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
Server-side session reads (the initial-password route) pass only the Cookie
header, and none at all when the request carries `Authorization`. The Convex
plugin's 15-minute `convex_jwt` cookie keeps its Max-Age for non-remembered
users. This is accepted: it is a short-lived access token minted from a live
session, not a session. It expires within 15 minutes and cannot refresh or
extend the session.

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

**One session-cookie name per site (#208).** Each site reads exactly one session-cookie name. Better Auth reads only the site's prefix, and `sessionCookieHeaders` (`convex/sessionLifetime.ts`) passes the Cookie header through unchanged. The Worker's token matcher is `authCookiePair(site, suffix)` in `shared/auth-cookies.ts`. The viewer-ticket filter in `src/viewer-ticket.ts`, the session middleware, the session cache, the auth proxy's cache eviction and the repository read path all use it. It applies the same rule as Convex: `__Host-better-auth.*` on HTTPS, unprefixed `better-auth.*` on local HTTP. The site is `cookieSite(request.url)`: the configured `SITE_URL`, else the request's own origin, as write admission already does. On HTTPS this rules out two kinds of cookie:

- the unprefixed local names, which any sibling subdomain can set with a parent `Domain`
- the retired pre-#89 `__Secure-better-auth.*` names

Neither kind ever authenticates, even with a validly signed session. On its own, such a cookie causes no session lookup and leaves the browser signed out. Next to the site's own cookie, before or after it, it can't displace that cookie, be forwarded or looked up, or make the session-cache key ambiguous. Nothing renames or re-issues it either. The pre-#89 migration (promote, re-issue, expire) was removed without waiting for the session window to pass, because production had no real sessions to migrate. Anyone still holding an old cookie signs in again. Deploy order doesn't matter: the Worker and Convex each ignore the retired names on their own.

**Sign-out** expires every auth cookie name under all three prefixes, the retired `__Secure-` one included (host-only, plus the parent domain except for `__Host-`, which browsers reject with a Domain). It also sends `Clear-Site-Data: "cache"`, so the browser also drops the HTTP cache holding any private frame the viewer cached immutably in that profile (#242). The `"cookies"` directive is deliberately absent: it would clear cookies for the whole registrable domain, so a sign-out on one subdomain would wipe sessions on every other one, while the per-name expiry is exact.

`tests/auth-cookies.test.ts` runs the real Better Auth handler, Convex adapter, Worker proxy, session middleware and cache over HTTPS and HTTP. `e2e/retired-cookies.spec.ts` checks two things in Chromium and Firefox: a browser holding only the retired names is signed out, and sign-out through the Worker expires them. WebKit doesn't send Secure cookies on a loopback HTTP origin, so it skips there. The spec reads the jar with expired entries ignored, because Firefox can keep listing a cookie that a `Max-Age=0` response has already expired (#210).

### Session middleware

`src/middleware/session.ts` runs on every route registered after it (landing, auth and account pages, `/home`). If the request carries a session-token cookie, it calls Convex `GET /api/auth/get-session` and sets `c.get("user")`. Those pages always use a fresh identity: the middleware evicts the presented cookie from the identity cache and never reads it (#286; the organization pages that used to reuse a cached identity were removed). Requests under `/api/auth/` skip the lookup; Convex authorizes them itself.

The repository read path is mounted **before** the middleware and asks for the session only when its capability cookie cannot answer, through `sessionViewer()`. That is the one caller of the per-isolate identity cache (`src/session-cache.ts`): an LRU bounded to 1,024 entries including in-flight lookups. Keys are SHA-256 hashes of the session cookie **value**, never raw tokens; cookie names must also match, and ambiguous multiple-token headers bypass caching. Entries contain only allowlisted user fields and normalized session expiry, never the session payload or token. Concurrent misses for the same cookie share the first lookup only; failures are removed before backoff and retries run independently without entering the cache. Missing, invalid, expired, malformed, failed (including 429/5xx/timeouts), or negative results are not retained. Better Auth's cookie cache remains disabled.

The TTL is **at most 15 seconds**, capped by session expiry and measured from the start of the lookup; hits never extend it. **A cached identity may be ≤15 seconds old**, including revocations handled by another isolate or directly by Convex; the read path's capability cookie and revocation epochs bound what that identity can still read (see [Repository Read Path](#repository-read-path-github-pivot-p4a)). There is no stale-on-error fallback after that deadline. Sign-out evicts the cookie in the handling isolate before and after forwarding, including failed forwarding. Other Worker auth operations that can revoke sessions (single/all/other-session revocation, password changes and resets, account deletion) evict the caller before and after forwarding and clear the isolate cache on successful mutation, because they may target sessions other than the caller's. Rejected or anonymous calls do not flush other users' entries, and eviction prevents earlier in-flight reads from repopulating the cache. A direct Better Auth missing-session response evicts as well. This is not a distributed invalidation guarantee: other isolates expire naturally within the TTL.

HTTP `/get-session` reads use atomic fixed 60-second windows in the Better Auth component's rate-limit table. The primary limit is 600 reads per window, keyed by `session-read:` plus SHA-256 of the decoded token, **only after verifying the exact configured session-token cookie's HMAC and finding its active persisted session**. Unknown, expired, unsigned, or non-session values (including other cookies signed with the same secret) share a 120-read verified-IP fallback. Raw tokens and client-supplied identifiers are never stored as rate-limit keys; valid sessions retain their bucket across IP changes and alternate cookie encodings. A separate 6,000-read verified-IP backstop runs before session resolution. Direct unverified callers share `no-trusted-ip`. Each bucket's start time stays fixed during the window; accepted and rejected traffic cannot delay replenishment, and `Retry-After` reports time until reset. Better Auth's inactivity-based limiter is disabled for this endpoint; credential, reset and verification limits and the exact-path verifier exemptions are unchanged.

The limiter resolves the signed token once, normalizes the Convex adapter's numeric `expiresAt` (also accepting Date/ISO values, failing closed on invalid values), and replaces only the current endpoint context's adapter reference with a wrapper that returns that result, including null, to Better Auth's unconditional `findSession` call. The shared adapter remains untouched; later requests, and any other token looked up within the same request, resolve afresh. Better Auth still owns expiry deletion and refresh writes.

A component cron runs every five minutes, paging 100 rows at a time through the `lastRequest` index at a fixed expired-window cutoff. It deletes only the `session-read` namespaces (and expired rows left by the retired `organization-read` limiter) and schedules continuation pages, preserving all built-in credential, reset and verification buckets, including stale ones. Schema regeneration targets `schema.generated.ts`, keeping the custom index in `schema.ts`.

Session lookup infrastructure failures return retryable 503 responses, with one bounded retry of the lookup GET only. Failures never replay protected writes or discard the session cookie.

Responses that performed a session lookup receive `Cache-Control: private, no-store`. Responses that pass through the middleware also receive numeric `Server-Timing` metrics: `session;dur=…` (when a lookup ran) and `render;dur=…`. The metrics contain no identity or response data.

### Cookie-authenticated write admission

Custom Convex HTTP writes declare their admission policy at registration. The shared `shared/request-admission.ts` helper requires an exact match to the origin of Better Auth's configured `SITE_URL`, rejects absent, opaque or foreign origins and `Sec-Fetch-Site: cross-site`, and requires `application/json` for JSON bodies (charset parameters are allowed). Origin checks never replace persisted session authorization. Initial-password setup additionally reads the persisted session and checks its creation time against Better Auth's `sessionConfig.freshAge` (24 hours by default); stale sessions must sign in again.

The Worker checks its own cookie writes with the same rules (`src/middleware/write-admission.ts`), using `SITE_URL` when set or the trusted ingress URL origin. Its registrations are exactly: Better Auth's `POST /api/auth/*` (forwarded with Origin and Fetch Metadata so Better Auth's own origin checks apply), `POST /api/auth/set-initial-password` (cookie JSON), `POST /r/*` (repository comment access, bodyless, checked by the read path itself) and `POST /rum` (a beacon that reads and sets no cookie). `tests/request-policy-matrix.test.ts` inventories the actual Convex HTTP registrations, the Worker's mutation registrations and the public state-changing RPCs. Comment RPCs use explicit session JWTs; ambient cookies do not authorize them.

### Workers Proxy Details

`src/auth-proxy.ts` handles four concerns:

1. **Header allowlist**: only `accept`, `content-type`, `cookie`, `origin`, `sec-fetch-site`, and `user-agent` are forwarded, plus the signed client-IP headers. `Host`, `Authorization` and `cf-*` headers are excluded.
2. **Domain stripping**: Convex sets `Domain=convex.site` on cookies. The Worker strips the Domain attribute so cookies bind to the Worker origin.
3. **Redirect control**: `redirect: "manual"` leaves redirects to the browser; a redirect to Better Auth's error page becomes `/sign-in?error=<code>`.
4. **Sign-out**: `GET /api/auth/sign-out` shows confirmation; a same-origin `POST` calls Convex sign-out, then expires every known auth cookie under the current, legacy and local names (host-only and parent domain; `__Host-` names host-only) and sends `Clear-Site-Data: "cache"` (#242). `"cookies"` is deliberately absent: it clears cookies for the whole registrable domain, not just this origin, and the expirations are already exact per name.

---

## Data Storage

### Convex Tables

The Better Auth component owns users, sessions, accounts, verification records, JWKs and rate-limit state. Sessions keep the retired `activeOrganizationId`/`activeTeamId` fields as optional values so existing rows still validate (#286).

The application schema (`convex/schema.ts`) owns:

| Table | Purpose |
|---|---|
| `repoCommentGrants`, `repoCommentEpochs`, `repoCommentRepos` | Comment access recorded by the trusted shell, revocation epochs, and known repositories ([Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6)) |
| `repoThreads`, `repoReplies` | Repository comment threads and replies, anchored to text in a rendered page |
| `admissionBuckets` | Expiry index of the write-quota buckets, so idle buckets are cleaned up |
| `auditEvents` | Actor/action/resource audit trail for privileged changes |

Repository snapshots, sidebars and manifests live in R2 under the `gh/v1/` key schema ([Storage key schema](#storage-key-schema)); the search index lives in D1; permissions and epochs live in the control Worker's Durable Object and KV.

---

## Workers Internals

### Request Pipeline

`src/worker.ts` registers middleware and routes in this order (Hono matches the first handler that responds). Steps 4 and 7–11 come from `mountPublicRoutes()` and `mountSessionRoutes()` in `src/app-routes.ts`:

```
Request
  │
  ├─ 1. Security headers (outermost; applied after the response is built)
  ├─ 2. Env bridging (string c.env values → process.env, without overwriting) and the trusted client IP
  ├─ 3. Request logging (route templates only)
  ├─ 4. Public routes, before the session middleware
  │   ├─ /img/<sig>/<url>                image proxy
  │   ├─ /r/{owner}/{repo}/…              repository docs (own capability cookie; session only on a miss)
  │   └─ POST /rum                        real-user monitoring beacons (no cookie read or set)
  ├─ 5. Public static assets (explicit allowlist, `src/routes/public-assets.ts`)
  │   ├─ versioned bundles: /lazy-tree.js, /private-viewer.js, /commentor-parent.js, /commentor.js, /rum.js
  │   └─ /favicon.svg, /favicon.ico, /landing-product.webp, /fonts/*, /styles/*
  ├─ 6. Session middleware
  ├─ 7. Write admission and body admission
  ├─ 8. Auth
  │   ├─ GET /api/auth/sign-out confirms; same-origin POST → Convex, cookie cleanup
  │   └─ /api/auth/* → Convex proxy
  ├─ 9. Auth and account pages: /sign-in, /sign-up, /verify-email, /forgot-password, /reset-password,
  │      /home, /account/security
  ├─ 10. / → landing page, or a redirect to /home when signed in
  ├─ 11. /health → "ok"
  ├─ 12. GET * → shared 404 HTML (no ASSETS fallthrough)
  └─ 13. Error handler → generic JSON 500
```

`src/index.ts` is the Node.js entry for local development (`pnpm dev`, `pnpm start`). It mounts the same route groups from `src/app-routes.ts` and serves the same asset allowlist with `serveStatic` and the same headers.

Public routes and static assets run before the session middleware so they never trigger a session lookup. Their safety comes from capability validation, not route position. Body admission bounds bytes before any JSON or form parser.

### Response security headers

Every registered Convex HTTP action passes through `convex/httpErrors.ts`, which
sets `Cache-Control: private, no-store` after both successful handling and failure
mapping, including admission failures and malformed input. `shared/http-cache.ts`
owns the sole API exception: an exact GET `/api/auth/convex/jwks` returning 200
without `Set-Cookie` receives `public, max-age=300, must-revalidate`. New actions
inherit the private default. The Worker proxy preserves and enforces this policy,
including sanitized upstream failures; the outer Hono middleware applies it to
every `/api` response, including local denials and errors. Other Worker responses
without an explicit cache policy also default to private/no-store.

Reset and verification pages receive `private, no-store` and
`Referrer-Policy: no-referrer`, including errors. The registration-derived cache
matrices exercise direct Convex actions and Worker routes; proxy tests cover cookie
rewriting and sanitized failures. A simulated intermediary checks that responses
cannot be reused across users or after denial.

Request/error logs in Node and the Worker record Hono route templates, never raw
paths, query strings, or URL suffixes (including unmatched wildcard requests).
`src/logger.ts` exposes a small logging facade that applies the shared recursive
sanitizer in `src/log-redaction.ts` before delegating to Pino. Child bindings are
sanitized when captured and merged into each sanitized record. This policy runs
in both Node and the Worker, where bundling selects `pino/browser.js` and ignores
Pino's top-level redaction/hooks/formatters options. Header, body, URL, query,
stack and cause fields are redacted; exceptions retain only fixed categories. Log
message text must be a static application-authored string. Storage and proxy
catch blocks log fixed categories, without exception objects or storage keys.
Better Auth diagnostics emit only a fixed category, without library messages or
exception arguments. Registration-derived tests capture actual Pino output with
synthetic capabilities, alternate encodings, malformed paths, and errors. A
separate esbuild regression uses Wrangler's Worker conditions/browser resolution,
verifies that `pino/browser.js` was bundled, and checks the same fixtures against
Node output. Cloudflare raw invocation logs remain disabled because they include
request URLs (capability tickets).

`src/middleware/security-headers.ts` is the outermost Hono middleware in both the Worker and Node entry points, including static files, redirects, preflights, 404s and errors. Every response gets `X-Content-Type-Options: nosniff`, a default `Referrer-Policy: strict-origin-when-cross-origin`, and a restrictive `Permissions-Policy` disabling camera, microphone, geolocation, payment, USB, display capture, motion sensors, autoplay, encrypted media, fullscreen, picture-in-picture, MIDI, credential retrieval, wake locks and XR. Route-specific referrer policies (especially `no-referrer`) are preserved. HTTPS requests additionally get `Strict-Transport-Security: max-age=15552000`, without `preload`; local HTTP does not. The request URL is authoritative, not an untrusted forwarded-protocol header. Adding `includeSubDomains` is an owner decision pending confirmation that every subdomain is HTTPS-only.

| Route class | Framing | Content Security Policy / exceptions |
|---|---|---|
| Landing, auth, account, home and other app HTML, ordinary 404s | `frame-ancestors 'none'`; `X-Frame-Options: DENY` | `default-src 'self'`; `script-src 'self' 'nonce-…' 'strict-dynamic'`; nonced style elements; no inline event handlers or eval; explicit font/image/connect sources below |
| Repository docs shell (`/r/{owner}/{repo}[/{ref}]`) | Deny framing; `frame-src 'self'` permits the document iframe | The same policy, with `no-referrer`. The one trusted shell whose `Cache-Control` stays `private, no-cache` (revalidated on every navigation, so each gets a fresh nonce, but bfcache-eligible) |
| Repository document frames (`/r/…/files/*`, `/r/…/view/:ticket/files/*`) | `frame-ancestors 'self'`; `X-Frame-Options: SAMEORIGIN` | `sandbox allow-scripts allow-popups`, `default-src 'none'`, scripts only from `/private-viewer.js`, styles only from `/styles/`, images from self only (external images arrive through the signed image proxy); content was sanitized at ingest, so this is defence in depth |
| Styled HTML errors on document routes | Self-only framing, so they stay visible inside the viewer | The trusted nonce policy |
| JSON/API, redirects, and static assets | No added framing restriction | Baseline headers only; asset cache, CORS and cookie headers remain intact; no HTML policy is applied |

**Cross-origin isolation headers (#89).**

| Route class | `Cross-Origin-Opener-Policy` | `Cross-Origin-Resource-Policy` | Why |
|---|---|---|---|
| Top-level trusted HTML (every row above with `frame-ancestors 'none'`, including the repository shell and the sign-out page) | `same-origin` | `same-origin` | The page gets its own browsing context group, so no cross-origin window it opened or was opened by keeps a handle to it. Nothing needs an opener: sign-in is same-origin, copying uses the clipboard, and comments use the document iframe's `postMessage` channel, which COOP does not affect. |
| Styled HTML errors on document routes | none | `same-origin` | They render inside the opaque viewer iframe, where COOP does not apply. |
| `/api/*` (JSON, redirects, preflights, errors) | none | `same-origin` | Refuses no-cors embedding of API data by other sites (`<script>`, `<img>`, `<link>`). CORS and same-origin fetches are unaffected. |
| Static assets (`/*.js`, `/fonts/*`, `/styles/*`, favicons) | none | none | Opaque-origin viewer frames load `/private-viewer.js` and `/commentor.js` with no-cors `<script src>`. |
| Image proxy (`/img/<sig>/<url>`) | none | `cross-origin` | Opaque-origin viewer frames load proxied images with no-cors `<img>`; `same-origin` or `same-site` would block them. The bytes are public third-party images, behind a signature (see [Image proxy](#image-proxy)). |

Trusted HTML policies also use `object-src 'none'`, `base-uri 'self'`, and `form-action 'self'`. `connect-src` permits self, the exact configured `CONVEX_URL` and `CONVEX_SITE_URL` HTTP(S) origins, and the corresponding WS(S) origin for `CONVEX_URL`. Local Convex HTTP/WS URLs work without production-wide wildcard allowances. Fonts and the viewer stylesheets are self-hosted: `script-src` and `style-src` have no third-party origin, `font-src` is exactly `'self'`, and images allow only self and data URLs (#286 removed the Google sign-in form target and avatar host).

**Inline allowances:** scripts never use `'unsafe-inline'`, `'unsafe-eval'`, or `'unsafe-hashes'`. Trusted templates explicitly emit a cryptographically random 144-bit nonce from request-local async context; responses are not scanned to authorize arbitrary script tags. `'strict-dynamic'` lets nonced scripts load further scripts and makes CSP3 browsers ignore `'self'`, which stays only as the fallback for browsers without `'strict-dynamic'`. So every parser-inserted `<script>` in trusted HTML carries the nonce. Style elements are nonced too: `style-src` is `'self' 'nonce-…'` on every trusted page. `style-src-attr 'unsafe-inline'` supports existing authored attributes and interactive sizing and loading behavior.

`tests/security-headers.test.ts` covers route policies, nonce isolation, HTTPS detection, private protections and non-HTML responses. `tests/security-headers-browser.test.ts` runs Chromium against actual Worker routes on an isolated local server, with fixture auth and comment backends, a `securitypolicyviolation` listener in every frame and CSP console checks. It exercises the landing page, sign-in errors and auth error redirects, email verification, the home and account pages, 404s and the real comments postMessage host and widget. The suite uses the shared offline Chromium harness ([Chromium tests](BROWSER_TESTS.md)); any external request, including a CSS CDN, fails it.

### Convex access from the Worker

The Worker never opens a WebSocket to Convex. It calls Convex HTTP actions at `CONVEX_SITE_URL` for auth, signing the trusted client IP with `CONVEX_INTERNAL_SECRET` (`src/auth-client-ip.ts`). The read path's comment access (`src/repo-read/comments.ts`) calls the Convex function API at `CONVEX_URL` through `src/convex-internal.ts`, with the same secret inside the arguments of internal-secret-gated functions:

```typescript
POST ${CONVEX_URL}/api/query     Body: { "path": "module:function", "args": [{ ..., "internalSecret": "…" }] }
POST ${CONVEX_URL}/api/mutation  Body: { "path": "module:function", "args": [{ ..., "internalSecret": "…" }] }
```

The control Worker also calls a Convex mutation, with the same secret, to tell it about revoked readers and removed repositories (#254).

If `CONVEX_SITE_URL` is unset, `src/config.ts` derives it from `CONVEX_URL` (`.cloud` → `.site`, local port 3210 → 3211). The browser's comment client talks to Convex directly with a short-lived JWT ([Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6)).

### Write quotas

Convex's `@convex-dev/rate-limiter` component owns the transactional creation quota (`convex/writeQuotas.ts`). Each comment thread or reply consumes both an authenticated-user bucket (30, refilling 30 a minute, across all repositories) and the repository's bucket (ten times that). No client-supplied actor ID is accepted, and unrelated readers or repositories share no global bucket. Limiter debits and inserts share one Convex mutation transaction: a failed write rolls the debits back, and a repository denial also rolls back the user debit. Comment operation deduplication precedes charging, so a confirmed write retried with the same operation ID stays idempotent. Direct comment RPCs return the component's structured `RateLimited` application error, which the widget recognizes by bucket name (the repository bucket keeps its historical `comments:organization` name). `convex/admissionBuckets.ts` records each bucket's expiry so idle buckets are reset by a cron.

### Time never decides access in a query

Convex caches a query result until a document it read changes; elapsed time does not invalidate it. A query that compares `Date.now()` with a deadline can keep returning a stale "allowed" after the deadline passes (revocation is unaffected because it changes a document). Queries and `internalQuery` handlers therefore never read the clock (`Date.now()`, argument-less `new Date()`, `performance.now()`, `Temporal`), directly or through helpers. They return the stored deadline and the calling action or httpAction compares it with `Date.now()`, once, and denies. Mutations may read the clock freely.

`tests/query-clock-purity.test.ts` enforces this. A TypeScript-AST analysis (`tests/helpers/convex-query-clock.ts`) starts from every query registration in `convex/**` (including factories that wrap `queryGeneric`), follows each referenced top-level declaration through relative imports, re-exports and namespace imports, and fails on any reachable clock read. The set of queries it finds must equal the set of exports Convex registers at runtime (`isQuery`), so a new registration shape cannot slip past it. Justified non-access uses are listed with a reason in the test's `allowedClockReads` map; an entry that no query reaches fails, so the list can only shrink. Code in `node_modules` (Better Auth, the Convex adapters) is outside the analysis; the Convex platform validates the auth token itself.

---

## Document Viewer

### Component Architecture

```
Server (Hono SSR)
  │
  ├─ renderScopedDocumentShell(options)  (src/routes/app.ts, called by src/repo-read/routes.ts)
  │   ├─ Topbar (repository title, copy-link, theme, shell hide/show; mobile "More document actions" menu)
  │   ├─ Sidebar (#doc-sidebar, resizable, mobile drawer)
  │   │   ├─ repository search (#repo-search, when the search binding exists)
  │   │   ├─ data-document-base / data-frame-base attributes
  │   │   └─ #tree-container with #active-indicator
  │   ├─ Main area
  │   │   ├─ #main-placeholder
  │   │   └─ #content-frame (sandboxed iframe)
  │   ├─ Inline scripts (theme, shell hide/show, shortcut forwarding, copy-link feedback)
  │   ├─ <script src="/lazy-tree.js?v=…">, /rum.js?v=…
  │   └─ /commentor-parent.js?v=… (comment host, when Convex is configured)
  │
  ├─ Document frames (src/repo-read/frame.ts): the rendered page, /private-viewer.js?v=… (link bridge,
  │   ticket renewal) and /commentor.js?v=… (the comment widget)
  │
  ├─ renderNotFoundPage(options)  (src/routes/not-found.ts)
  │   └─ Shared 404 HTML for missing routes, documents, and iframe objects
  │
Client (lazy-tree.js, built from src/lazy-tree/)
  │
  ├─ GET …/tree?dir=…&cursor=… per folder (root first), with "Load more" pagination
  │   └─ A deep link expands its ancestors and loads later pages of only those folders to reveal its row
  │       (overlapping reveals share a folder that is still loading; a superseded reveal stops at
  │       each awaited step — newest-wins — and only the newest marks its row)
  ├─ File click → loadDoc(path, pushState)
  │   ├─ Optimistically select row + updateIndicator
  │   ├─ Add html.doc-loading and set iframe.src to the frame URL
  │   ├─ On iframe load, keep tree feedback for the rest of the 520ms minimum window
  │   └─ history.pushState (?doc=<path>)
  ├─ postMessage listener (current content iframe only, while it shows a document the shell loaded: #296)
  │   ├─ doc-navigate → parent authorization / confirmation → loadDoc(path, push/replace)
  │   ├─ doc-external (another site, or a page of this site that is not a document) → parent confirmation → window.open(href, "_blank", "noopener,noreferrer")
  │   ├─ doc-loaded → acknowledge expected path (no navigation or tree fetch)
  │   ├─ doc-pointer → (inline shell script) close the More menu; carries no data
  │   └─ shell-toggle → Ctrl/Cmd+Shift+H inside the iframe toggles the shell
  └─ popstate / initial URL → loadDoc(path)
```

The script URLs carry `?v=` versions from the asset-version ledger (see "Public static assets"); read the current values in `src/routes/versioned-bundles.ts` rather than copying them.

Reveals are newest-wins (#169): a reveal captures a token when it starts and
bails out after every awaited step once a newer navigation has begun, so a
superseded reveal neither issues further folder or page requests, opens
folders the reader left behind, nor marks a row. Only the newest navigation
selects its row, once its ancestors are ready. Back/Forward to a history entry
that names no document (`docPath` absent from the state and the URL) changes
the URL only: the last document stays showing with its selection, because
nothing tells the viewer what to show.

Document fragments use one link bridge (`src/viewer/navigation.ts`). Bare
`#fragment` links refer to the current document. Explicit same-document links
scroll in place, without navigating the iframe or touching comment anchors and
drafts. Targets are percent-decoded and matched by ID, then `<a name>`; empty `#`
and an unmatched case-insensitive `#top` scroll to the top, and missing targets
do nothing. Fragment-only clicks use `history.replaceState` in the parent;
document changes keep the tree's `pushState`, including the destination
fragment. The parent passes its hash to the frame after load, including on
reload and back/forward. Bridge messages check the current frame source and
expected origin, and hashes are bounded to 4096 characters and used only as data.

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

Navigation remains confined to the current repository snapshot.
`validRelativeDocumentPath` rejects literal traversal and malformed path segments;
the shell encodes each path segment beneath its own fixed document route
(`data-document-base`). Encoded traversal, schemes and foreign repository
prefixes cannot replace that route. The server separately enforces the
repository grant. The parent updates only its viewer route, and the
opaque iframe sandbox does not permit top navigation, even with activation.

The repository shell owns one navigation gate for its entire lifetime. A valid `doc-navigate` from the current content frame requires
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
`toggle` messages also fail closed when the API is absent.

A web link that is not a repository document of the frame (#296) never loads in the sandboxed frame: a link to
another site (an absolute `http(s)` address on a different origin), which the shell's frame policy would refuse, and
a page of this site that is not a document, which only the shell may load there. The frame cancels the click and
sends `doc-external` with the resolved address (a link too long to show is cancelled and dropped); standalone
documents, `mailto:` and script URLs keep native behavior. The parent (`lazy-tree.ts`) re-validates the address (a
string of at most 2,048 characters, `http(s)`) and offers it through the same bounded confirmation as a document: one
visible prompt that is never retargeted, one silently replaced pending address while dismissed, and a parent-owned
"Review external link" button ("Review link" for a page of this site, whose prompt reads "Open … in a new tab?"). The
label is assigned with `textContent`. Only the reader's "Open external link" (or "Open in new tab") press opens it,
with `window.open(href, "_blank", "noopener,noreferrer")`, so the page gets a new tab with no handle back to the
viewer and the document, its history and its selection stay where they were. The sandbox is unchanged. The prompt
itself is one component, `createNavigationNotice()` in `src/viewer/navigation-notice.ts` (state machine in
`navigation-confirmation.ts`), used by
`lazy-tree.ts`; the shell supplies its own `.document-navigation-notice` and `.load-more-btn` styles.

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
- The reveal runs inside `document.startViewTransition` so the old and new documents cross-fade instead of flashing, unless the reader prefers reduced motion or the API is absent. Either way a `rendro:frame-switch` `performance.measure` records the switch (the target is under 200 ms for a warmed frame), and on the repository read path one `rendro:navigation` measure records activation → swap → load → paint for real-user monitoring (see [Real-user monitoring](#real-user-monitoring-282)).
- After a reveal the shell re-sends the fragment and settles the loader exactly as a fresh load does.
### Shell-loaded frame documents

The shell answers its content frame only while the frame shows a document the shell itself loaded (#296). The
frame's `src` attribute alone cannot say that: a document that navigates the frame by itself (or a reload from the
frame's context menu) leaves `src` unchanged. `src/viewer/content-frame.ts` records every navigation a shell script
starts on the frame element, which no document inside the frame can touch: `startShellNavigation(frame)` raises
`data-navigation` (a counter) and marks it `data-loading`, and one capture-phase `load` listener on the shell's
document settles it (`data-document`). A load with no navigation pending removes `data-document`. The listener is on
the document because a frame's `load` never reaches the window, and capture there runs before any listener on the
frame element. The lazy tree records its loads and preloads, and the inline Try again handler its reload, before
setting `src` or replacing the frame's location. `shellFrameNavigation(frame)` returns the latest navigation while the
document is the shell's (during a navigation, the page being left still counts), otherwise `null`:

- the lazy tree acts on no message from an untrusted frame (navigation, link, fragment or load reports);
- the comment host drops the comment session at such a load and answers nothing at all, not even a refusal, to its
  reads, writes or reload requests; its own late acknowledgements and updates are dropped too;
- the private viewer's ticket renewal asks the read path for nothing, and drops an answer if the frame's navigation
  changed, or its document stopped being the shell's, while the request was out.

The frame stays untrusted until the reader opens a page and that navigation loads. A frame's first navigation leaves
the empty document it was created with (the shell's `about:blank`, or a new preload buffer), which runs nothing, so
the opening document may speak before its own `load`.
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

Repository docs render in an opaque sandboxed iframe. The comment widget (`commentor.js`) runs inside it; the trusted shell (`commentor-parent.js`) owns the session, the Convex client and every write. Authorization and anchors are covered in [Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6).

```text
document iframe -> scoped messages -> trusted parent shell -> authenticated Convex
document iframe <- scoped results  <- trusted parent shell <- reactive pages
```

The parent's Convex client refreshes its JWT shortly before it expires (`forceRefreshToken`); each refresh confirms the identity first (`/api/auth/get-session`) and then asks `/api/auth/convex/token`. The iframe receives only document-scoped comment data and operation results, never a JWT or session credential. The widget bundles no `convex/` module (#315): the parent maps every failure from a real `ConvexError` (`src/commentor/errors.ts`) and sends only the resulting message, the rejection flag and a quota's `retryAfter`; the frame rebuilds the quota as a `CommentErrorEnvelope` and reads envelopes structurally (`src/commentor/frame-errors.ts`). Both inject their reader into one Convex-free mapping (`src/commentor/error-mapping.ts`). `tests/build-scripts.test.ts` asserts from esbuild's metafile that `commentor.js` has no `convex/` input. The parent derives the repository and document from its trusted configuration and frame URL, allowlists comment operations, and answers only the frame document it loaded itself (#296).

Convex delivers the reactive snapshot that contains a new comment or reply before the mutation's acknowledgement, so the widget treats either order as normal. Closing the composer returns focus to the control that opened it even when the snapshot closes the composer first. Thread and reply history uses bounded reactive Convex pages; explicit load-older controls preserve access to the full history, and loaded pages stay subscribed.

### Pin layout

Pins, the open thread bubble and the highlighted anchor are positioned in one batched pass per animation frame (`Commentor.repositionPins`). Scroll, window resize and a `ResizeObserver` on `<html>` and `<body>` (content that reflows without either, such as late images or fonts) only schedule that frame. The pass reads everything first (viewport size, one anchor rectangle per pin through a thread-id map built once, the open bubble's pin rectangle and size, the highlighted anchor's rectangles) and writes afterwards, so the browser runs a single layout however many pins exist; previously every pin's write was followed by the next pin's read, one forced layout per pin. A pin's new box is derived from its previous box and its new `left`/`top`, so keeping the open bubble attached costs no further read; only a pin that was hidden before needs one. Pins keep `position: fixed` with `left`/`top` (their CSS `transform` is the rotation and hover scale, and the positions are part of the tested contract). Orphaned anchors, anchors outside the viewport, the drawer and every dock edge keep their previous behaviour.

Measured in Chromium with 40 scroll frames and every pin on screen (`tests/commentor-pin-layout-browser.test.ts` asserts one layout per frame): layouts per frame 9 / 90 / 450 before at 10 / 100 / 500 pins, 1 / 1 / 1 after; layout time per frame at 100 and 500 pins fell from 25 ms and 598 ms to 0.4 ms and 1.8 ms. Remaining script time is the anchor lookup itself (`querySelector` per pin, roughly 30 µs each); caching it is possible future work.
### Anchor Format

```typescript
type RepoAnchor = {
  kind: "repo-text";
  blobSha: string;      // the Git blob the quote was taken from
  headingSlug: string;  // the section that holds the quote
  prefix: string; exact: string; suffix: string;  // up to 32 characters of context each side
  offset: number;       // where the quote started in that section
};
```

An anchor re-attaches to its quote in a later commit by text and section, not by DOM path (`src/commentor/repo-anchor.ts`); one it cannot place is listed in the drawer, never pinned to other text.

---

## Deployment

### Site URLs

| Purpose | URL |
|---|---|
| Landing | `/` (a signed-in reader is redirected to `/home`) |
| Sign-in, sign-up, verification, password recovery | `/sign-in`, `/sign-up`, `/verify-email`, `/forgot-password`, `/reset-password` |
| Signed-in home | `/home` |
| Account security | `/account/security` |
| Repository docs | `/r/{owner}/{repo}[/~{branch}` or `/@{commit}]` (see the read path's [URLs](#urls)) |
| Image proxy | `/img/<sig>/<url>` |
| Health | `/health` |

### Production URLs

| Service | URL |
|---|---|
| Web app | `https://rendro.app` (`https://dev.rendro.app` for the development environment) |
| Serving Worker | Cloudflare Workers custom-domain deployment (`wrangler.toml`) |
| Ingest and control Workers | `wrangler.ingest.toml`, `wrangler.control.toml` (development and tests only until the GitHub App exists) |
| Convex API | `CONVEX_URL` |
| Convex HTTP actions | `CONVEX_SITE_URL` |

### Deploy Commands

```bash
pnpm exec convex deploy
pnpm run deploy                       # serving Worker (production)
pnpm run deploy --env development     # serving Worker (development)
pnpm exec wrangler deploy --config wrangler.ingest.toml
pnpm exec wrangler deploy --config wrangler.control.toml
```

`pnpm run deploy` rebuilds the browser assets before uploading the Worker. Use
the explicit `run`: plain `pnpm deploy` invokes pnpm's unrelated workspace
deployment command. Do not replace it with a bare Wrangler deployment from a
fresh checkout: the bundles under `public/*.js` are generated release artifacts,
ignored by Git, not source files.

### Public static assets

Every file the Worker serves from `public/` is public and is served **before the session middleware** in both runtimes, so an asset request never costs a session lookup, never evicts a warm identity-cache entry and never gets the session's `private, no-store` policy. The allowlist is exact (`publicAssetPaths` in `src/routes/public-assets.ts`): anything else is a 404, never an ASSETS fallthrough.

| Class | Paths | `Cache-Control` | Notes |
|---|---|---|---|
| Versioned bundles | `/lazy-tree.js`, `/private-viewer.js`, `/commentor-parent.js`, `/commentor.js`, `/rum.js` | `public, max-age=31536000, immutable` only for the exact current `?v=<version>`; otherwise `no-store` | `text/javascript; charset=utf-8` |
| Fonts | `/fonts/<name>.<hash>.woff2` | `public, max-age=31536000, immutable` | content-hashed name; license texts: one day |
| Stylesheets | `/styles/<name>.<hash>.css` | `public, max-age=31536000, immutable` | content-hashed name |
| Icons and images | `/favicon.svg`, `/favicon.ico`, `/landing-product.webp` | `public, max-age=86400` | stable URLs (the image is also an external preview), so a daily refresh rather than immutable |

**Why `?v=` and not hashed file names.** The version of every bundle is recorded with its SHA-256 in `scripts/asset-versions.json`; `pnpm verify` rebuilds the bundle and fails when the bytes do not match the recorded hash of the current version, and the CI guard forbids rewriting a recorded hash. So a URL names exact bytes, and its immutable caching is safe. The ledger also keeps the history of retired bundles (the management bundles removed in #286), which are never served.

**Old and unknown versions.** The Worker only holds the current build (the ledger keeps hashes, not bytes), so an open tab or a request that straddles a rollout can ask for a version that no longer exists, or a not-yet-live one on an older isolate. Such a request is answered `200` with the current bytes and `Cache-Control: no-store`, never cached under a version it does not name.

**Adding or changing a bundle.** Bump its constant in `src/viewer/asset-versions.ts`, `pnpm build:assets`, then `pnpm record:assets` (rebase onto `main` first; a version collision is a ledger conflict). CSP nonces are unaffected.

**Bundle-size budget (#285).** `scripts/bundle-budget.json` records the raw and Brotli (quality 11, what the edge serves) bytes of every served bundle: the five versioned bundles, the stylesheets and font subsets (keyed without their content hash) and the comrak WASM. `pnpm verify:budget` runs at the end of `pnpm verify` (so in CI's verify job, after `pnpm build:assets`) and fails when a bundle grows more than 1% over its recorded size in either measure, when a served bundle has no entry, or when an entry names a bundle that is no longer served. The message names the bundle, the old and new sizes and the delta. Shrinking always passes, with a hint to lower the budget. When added weight is intended, run `pnpm build:assets` and `pnpm record:budget` and commit the budget file with the change, so a weight change is reviewed like a baseline (after a rebase onto a `main` that changed a bundle, re-record). The 1% tolerance absorbs toolchain noise; it is measured against the recorded size, not the previous build, so small increments still add up to a failure. Recorded sizes match under Node 22 (CI) and Node 24.

| Bundle (2026-10-21) | Raw | Brotli |
|---|---|---|
| `commentor.js` (document frame, no `convex/` module, #315) | 102,428 | 23,194 |
| `commentor-parent.js` (repository shell, holds the Convex client) | 98,174 | 24,419 |
| `lazy-tree.js` | 26,274 | 8,057 |
| `rum.js` | 12,893 | 4,418 |
| `private-viewer.js` | 6,269 | 2,163 |
| `repo-doc.css` / `viewer-base.css` | 7,231 / 1,435 | 1,987 / 577 |
| Fonts (Inter Latin, Latin Extended, icons; already compressed woff2) | 34,380 / 55,820 / 5,184 | n/a |
| `comrak_engine_bg.wasm` (Worker, not sent to browsers) | 368,424 | 99,904 |

### Self-hosted fonts

Inter and a Material Symbols Outlined subset are committed under `public/fonts/` as content-hashed woff2 files (`<name>.<sha256[:10]>.woff2`), with their licenses beside them: `LICENSE-Inter-OFL-1.1.txt` (SIL OFL 1.1) and `LICENSE-Material-Symbols-Apache-2.0.txt` (Apache-2.0). They are static assets of the Worker (`[assets]` directory `public/`).

| File | Bytes | Contents |
|---|---|---|
| `inter-latin.<hash>.woff2` | 34,380 | Inter variable, `wght` clamped to 400–700, Latin |
| `inter-latin-ext.<hash>.woff2` | 55,820 | same, Latin Extended (loaded only when such characters appear) |
| `material-symbols-outlined.<hash>.woff2` | 5,184 | 22 icons; FILL 0, GRAD 0, wght 400, opsz 20–24 |

`scripts/build-fonts.ts` (`pnpm build:fonts`) regenerates them reproducibly offline from the pinned devDependencies `@fontsource-variable/inter` and `material-symbols` using `subset-font` (HarfBuzz subsetter with axis instancing), and writes `src/routes/font-manifest.ts`. The icon list is scanned from the source that renders icons (`scripts/fonts/icon-names.ts`). `pnpm verify:fonts` (part of `pnpm verify`) regenerates into memory and fails when a committed file, the manifest or the icon list disagrees.

`GET /fonts/*` is public and runs before the session middleware in both runtimes (`src/worker.ts`, `src/index.ts`). `fontResponseHeaders` (`src/routes/fonts.ts`) decides the response: hashed `*.woff2` → `Content-Type: font/woff2`, `Cache-Control: public, max-age=31536000, immutable`; license texts → `text/plain; charset=utf-8` for a day; anything else under `/fonts` is a 404.

### Self-hosted viewer styles

The repository shell and its document frames load no CSS from a CDN (#89). `src/styles/viewer-base.css` holds the shell's utility rules, and `src/styles/repo-doc.css` styles rendered repository pages, including the syntax highlighting palette (`src/ingest/highlight-theme.ts`, byte for byte). `scripts/build-styles.ts` (`pnpm build:styles`) copies each source to `public/styles/<name>.<sha256[:10]>.css` and writes `src/routes/style-manifest.ts`. `pnpm verify:styles` (part of `pnpm verify`) fails when a committed file, the manifest or a stale file disagrees with the source. `GET /styles/*` follows the font contract in both runtimes.

### Environment Variables (Workers)

`src/config.ts` validates the serving Worker's environment at startup. The table lists every named string setting it reads; `ASSETS` and the read path's bindings are separate (see [Bindings and configuration](#bindings-and-configuration)). Both production (top-level) and `development` declare the same required secrets: `CONVEX_INTERNAL_SECRET`, `IMAGE_PROXY_SECRET`, `REPO_CAPABILITY_SECRET` and `REPO_CONTENT_KEY`. Wrangler checks these at deploy time, and `src/config.ts` validates them at startup; no two of them may share a value.

| Variable | Storage | Purpose |
|---|---|---|
| `NODE_ENV` | Wrangler var | Runtime mode; `production` selects JSON logs at `info` level |
| `CONVEX_URL` | Var/secret (optional at startup) | Convex deployment URL for comment access and the browser comment client; defaults to empty |
| `CONVEX_SITE_URL` | Var/secret (optional) | Convex HTTP action origin for auth; derived from `CONVEX_URL` when unset. Startup and `/health` work without either URL; backend routes do not |
| `CONVEX_INTERNAL_SECRET` | Secret (required, ≥32 chars) | Signs the trusted client IP for Convex and authorizes the Worker's internal Convex functions; same value in Convex |
| `IMAGE_PROXY_SECRET` | Secret (required, ≥32 chars) | HMAC key for same-origin image proxy URLs (see [Image proxy](#image-proxy)). Set the same value on the ingest Worker. Rotating it requires a `RENDERER_VERSION` bump, so stored renders are rebuilt with new signatures |
| `REPO_CAPABILITY_SECRET` | Secret (required, ≥32 chars, serving Worker only) | Signs repository capability cookies, asset tickets and the public shared-cache subrequest URLs; rotating it only sends readers back through the permission source once |
| `REPO_CONTENT_KEY` | Secret (required, ≥32 chars) | Seals private-repository content in R2 (see [Repository content lifecycle](#repository-content-lifecycle-github-pivot-p9b)); the ingest Worker holds the same value |
| `REPO_CONTENT_KEY_PREVIOUS` | Secret (optional, ≥32 chars) | Only during a [key rotation](#key-rotation): the previous `REPO_CONTENT_KEY`, which still opens content sealed under it |
| `REPO_SHARED_CACHE_DEBUG` | Var (optional, development only) | Set to `1` to surface the shared-cache subrequest's `CF-Cache-Status`/`Age` as `X-Repo-Shared-Cache` on public frame responses. Never set in production |
| `LOG_LEVEL` | Var (optional) | Pino log level; defaults to `debug` outside production, `info` in production |
| `PORT` | Local only; not read by the Worker | Validated in `src/index.ts`; Node.js server port (integer 1–65535, default 3000) |

The ingest and control Workers' settings are listed with their sections ([ingest bindings](#ingest-worker-and-bindings-development-and-tests-only), [control bindings](#bindings-and-configuration-development-and-tests-only)).

### Environment Variables (Convex)

| Variable | Purpose |
|---|---|
| `AUTH_SECRET` | Better Auth signing (required at runtime) |
| `SITE_URL` | Canonical Worker origin; Better Auth base URL and trusted origin (required at runtime) |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Verification, reset and existing-account email |
| `CONVEX_INTERNAL_SECRET` | Verifies signed client IPs and authorizes the Workers' internal functions; same value as the Workers |

### CI workflows

| Workflow | Trigger | Runs |
|---|---|---|
| `.github/workflows/quality.yml` | Pull requests, pushes to `main`/`development`, manual | `verify` (`pnpm verify`, dependency audit); `comrak-engine` (rebuilds the Markdown engine's WebAssembly from source and compares it with the committed bytes); `e2e-engine` (Playwright Test on workerd, two weighted shards per browser engine, `e2e (<engine> <i>/2)`, each with a duration guard) and its `e2e` gate and report; `visual (chromium baselines)` (`pnpm visual` in the pinned container); `a11y` (axe scans on Chromium, Firefox and WebKit); `coverage` (`pnpm coverage`, summary artifacts) |
| `.github/workflows/r2-public-access.yml` | Daily cron, manual; dry run on pull requests touching it | `pnpm check:r2-public` ([R2 bucket privacy](#r2-bucket-privacy)); needs `CLOUDFLARE_ACCOUNT_ID` and a read-only R2 `CLOUDFLARE_API_TOKEN` |
| `.github/workflows/stability.yml` | Nightly cron, manual | `coverage-twice` (two consecutive `taskset -c 0,1 pnpm coverage` runs, then per-test outcome and coverage-counter diffs) and `e2e-no-retries` (per engine and shard, `E2E_RETRIES=0`); read-only permissions, no secrets |

Supply-chain policy (enforced by `tests/workflow-supply-chain.test.ts`): every external `uses:` is pinned to a full
40-character commit SHA followed by a `# vX.Y.Z` comment; every checkout sets `persist-credentials: false` (a
`true` value needs a justification comment); each workflow declares workflow-level permissions without writes and
each job declares its own block. Dependabot (`.github/dependabot.yml`) proposes weekly SHA and comment bumps. To pin
by hand, resolve the tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and dereference annotated tags to
their commit.

No workflow deploys a Worker or Convex to a shared environment. The E2E job pushes application code only to a
harness-owned disposable loopback backend.

`pnpm e2e` starts the real serving Worker through Wrangler's `createTestHarness`, with the production compatibility
flags and static-asset configuration, and the real control Worker over a fake GitHub, on isolated loopback ports
with generated test secrets and guarded outbound requests. Repositories are ingested in process by the production
ingest pipeline from the same fake GitHub. The suite uses pinned local Convex with
real Better Auth, HTTP actions and WebSockets, Miniflare's local R2, KV, D1 and Queue simulations and an in-memory
mail sink. A generated local instance/admin key, a loopback target assertion, a sanitized environment and a
temporary source copy isolate every Convex push from shared deployments. Every cached Convex archive is SHA-256
checked against its pinned release digest on every use. Setup journals child process identities and its private
directory before returning any teardown callback, and the next run sweeps abandoned journals. Four seeded,
verified users sign in with email; repository access is granted per test. See
[the two browser test layers](BROWSER_TESTS.md) for setup, limitations, failure traces and the journeys.

The UI transition registry in `tests/ui-transitions.json` records behavior and assertion evidence for epic #99.
Its validator runs in `pnpm verify` and checks the actual Hono registrations against page families and explicit
non-page exclusions; retired families, routes and inventory references keep their IDs with a reason. See
[UI transition registry](BROWSER_TESTS.md#ui-transition-registry-99--102) for status semantics, the audit
baseline, and `scripts/ui-transition-report.ts`.

Source coverage includes the authored Worker and Node code, Convex, shared and script code, with root-anchored
filters and generated-code exclusions. The coverage gate merges the Node, browser (V8, mapped through the real
bundles) and subprocess shards, checks the complete source manifest, and requires 100% per file: `coverage-debt.json`
is empty, and CI rejects ledger increases relative to the base revision. Coverage runs separately from verify to
preserve its budget. See [source coverage and debt](BROWSER_TESTS.md#source-coverage-and-debt-gate) for commands,
reports, transform normalization and the subprocess collector.

---

## Operational Runbooks

### Revoke access

- A reader's repository access follows GitHub: removing a collaborator, a team membership or the App installation reaches the control Worker by webhook, which bumps the reader's revocation epoch. Every capability cookie and asset ticket minted before it stops working within the bounds in [Revocation bounds](#revocation-bounds).
- A session: revoke it from Better Auth (`/api/auth/revoke-session`, or a password change with "Sign out other sessions"); the Worker's identity cache drops it within 15 seconds in other isolates.
- A secret: rotate it as its row above describes; `REPO_CONTENT_KEY` follows the [key rotation](#key-rotation) procedure.

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
                                                                   ─► task-list checkbox labels, focusable pre/table
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
| `transforms.ts`, `paths.ts` | URL rewriting, GitHub heading slugs, alerts, link/image attributes, image proxy rewrite, task-list checkbox labels and focusable `pre`/`table` scroll regions (#270) |
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
  (BSD-3-Clause), with the tokens the stock themes renders below 4.5:1 on the
  frame's code background replaced by GitHub's own higher-contrast tokens
  (#270): light keyword `#cf222e`, variable `#953800`, tag and light addition
  `#116329`, dark heading `#4493f8`; every token reads at 4.5:1 or better on
  `--subtle` in both appearances, which `tests/ingest-render.test.ts` checks.
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
  - Inputs are disabled checkboxes, named from their item's text (#270).
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
    directory, so the frame resolves them under whatever commit or branch URL it was
    loaded from without rewriting its links (#242); a private frame only prefixes its
    repository images with an asset ticket (#293). A reference that leaves the
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
  task-list labels, focusable scroll regions, attributes) emit only what a second
  `outputSchema` allows. The serialized HTML
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
  only global unicast (`2000::/3`) is allowed, minus documentation (`2001:db8::/32`
  and RFC 9637's `3fff::/20`), 6to4 and Teredo, which rules out loopback, ULA,
  link-local, and mapped or NAT64 IPv4. Single-label names, local suffixes
  (`.localhost`, `.local`, `.internal`, `.home.arpa`, …) and known metadata
  hostnames are refused. So is Rendro itself (#295), so a proxied fetch never
  re-enters the site: `rendro.app` and every subdomain (`dev.rendro.app`
  included), the site's Workers on any `workers.dev` subdomain (a first label with
  a `rendro` part, so preview URLs too), and, on every hop, the host the proxy
  request itself arrived on.
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
| `REPO_CONTENT_KEY` | Secret, required | Seals private-repository content (#263); must equal the serving Worker's value. Without a valid one, private repositories are not ingested (`content-unconfigured`, retried) |
| `REPO_CONTENT_KEY_PREVIOUS` | Secret, optional | During a [key rotation](#key-rotation) only |
| `REPO_IDLE_EXPIRY_SECONDS` | Var, tests only | Shortens the idle window (default 30 days) |

### Storage key schema

Every key a repository owns sits under `gh/v1/repo/<repo id>/`. The prefix uses GitHub's numeric repository ID, so renames and transfers move nothing, and purging a repository (#263) is one prefix delete. The ref pointer is the only mutable object; every other key names immutable bytes.

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
├── audit/purge/{repoId}/{startedAt}.json               a purged repository's audit record (#263): IDs, times, counts
└── reconcile/redelivery.json                           redelivery checkpoint
```

- Snapshot keys include the renderer version (`r{rv}`). After a renderer change, a commit's snapshot is rebuilt next to the old one, never overwritten, so caches keyed by commit stay valid. The rebuild reads blobs from R2 and makes no GitHub requests.
- Blobs are fetched once per repository and reused across commits. A rename or move costs no fetch.
- The manifest maps each page and asset path to `{ sha, size, render?, title?, error? }`. A page that cannot be rendered records `error`, and the rest of the snapshot is still built. The reason is `too-large` when the tree listing already shows the page over 1 MiB (it is never fetched), otherwise the `RenderError` reason: `too-large`, `too-complex`, `too-deep`, `unstable` or `engine`.
- Render failures are deterministic for a blob, a directory and a renderer version, so the failure is stored at the render key like an output. A hostile page is rendered once, not on every push.
- The exception is the engine itself. After comrak crashes, the isolate refuses all further Markdown. The page that crashed it is recorded as `engine`. Later Markdown pages fail the attempt with the transient `markdown-engine-unavailable`, which the queue retries, so good pages are never marked as broken. A Durable Object may keep its isolate across retries, so recovery waits for the isolate to be recycled; re-instantiating a fresh engine in a live isolate is not yet supported.
- Pages are keyed by directory as well as blob, because relative links resolve against the directory. A page moved to another directory is rendered again, from the blob in R2 and without a GitHub request. Assets need nothing.
- Assets are images (`png`, `jpg`, `gif`, `svg`, `webp`, `avif`, `ico`, `bmp`) under the docs root, outside vendored and hidden folders. The sanitizer removes stylesheets, scripts and media elements, so no other file types are ever referenced.
- Private-repository content (blobs, renders, tree listings, sidebar and manifest) is sealed through the `ContentSealer` hook: per-repository AES-256-GCM ([Repository content lifecycle](#repository-content-lifecycle-github-pivot-p9b)). The pointer, the registry, the audit records and the checkpoint hold only IDs and names, and are not sealed.

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
| `/r/{owner}/{repo}/@{commit}/view/{ticket}/files/{path}` | Private repositories: an image's bytes, authorized by the asset ticket alone. Never a page: a page path here is no URL at all, the plain 404 (#293) |
| `/r/{owner}/{repo}/@{commit}/viewer-ticket?manifestKey={commit}` | Ticket renewal for the trusted shell (cookie-authorized, JSON) |
| `POST /r/{owner}/{repo}/comment-access[?path=]` | Comment access for the trusted shell: authorized like a page view, then recorded in Convex (same-origin, JSON). With `?path=`, the answer also carries that page's first threads (#284). See [Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6) |
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

The document frame is an opaque sandbox (#79), and requests it makes carry no cookies. A private frame's repository images therefore load from `/r/{owner}/{repo}/@{commit}/view/{ticket}/files/…`, where the ticket is a capability for the same user and repository bound to that commit instead of a session. It lives five minutes, as long as the capability cookie (`TICKET_TTL_SECONDS`). Ticket requests check the signature, repository, commit and the epoch on every request.

A ticket reaches images only (#293). The URL grammar has no page under `/view/{ticket}/`: such a path is the plain 404 of an unknown URL, with or without a cookie, before any session, ticket or storage read. Pages are always read with the cookie. The frame has no `<base>`, so its links, footnotes and fragments resolve against the frame's own cookie-authorized URL, and a link the reader middle-clicks, ctrl-clicks or copies is that URL, never a ticket. Only `img src` values that are relative to the document get the ticket prefix (`ticketImageSlots` in `frame.ts`). The split depends only on the render, so it is derived once per isolate, and each request joins it with its own ticket. Frame CSP is `base-uri 'none'`.

Renewal reuses the private viewer's protocol: the frame asks the trusted shell, the shell calls `…/viewer-ticket` with its cookie, and image URLs are swapped in place. A ticket cannot renew itself. The frame's client is told when the server issued its ticket and renews halfway through its life (2.5 minutes), checking once a minute and on focus, page show and resource errors, so a long-open page keeps loading images (a frame from the browser cache, with an older ticket, renews at once). A cookie that has lapsed meanwhile is re-decided through the session at the renewal request.

### Revocation epochs, and the contract P5 implements

`RevocationEpochs.currentEpoch(userId)` is read on every private request (cookie or ticket). A capability minted at an older epoch is stale: the request falls through to the permission source, which re-mints or denies. The Worker reads `epoch:user:<userId>` from the `REPO_EPOCHS` KV namespace (decimal milliseconds; absent is 0; anything else is a 503) with `cacheTtl: 60`. The `user:` part keeps user epochs (which expire) apart from visibility epochs (`epoch:repo:<id>`, which must not), whatever a user ID looks like (#295).

P5 implements this contract (#243): see [Repository Permission Mirror](#repository-permission-mirror-github-pivot-p5).

- **The permission source.** A control Worker, bound to the serving Worker as the `REPO_ACCESS` service, mounts `repoAccessHandler(source)`. Its `authorize(viewer, owner, name)` returns `{ id, owner, name, private, defaultBranch }` for the repository `owner/name` (case-insensitive) when `viewer` (a Rendro user ID, or null for anonymous readers, who see public repositories only) may read it now, and null when the repository is missing or forbidden, without distinguishing the two. It throws when it cannot tell; the client turns that, a non-200/404 status, a timeout (5 s) or an answer about another repository into a 503. It must build the answer from its mirror of the user's installation repositories (`GET /user/installations/{id}/repositories`), never by calling GitHub per view.
- **The epoch bumps.** On `member`, `membership`, `team` (`added_to_repository`, `removed_from_repository`, `edited`), `organization.member_removed`, `repository` (`privatized`, `publicized`, `transferred`, `deleted`), `installation_repositories`, `installation` (`deleted`, `suspend`) and `github_app_authorization`: first update the mirror so `authorize` already denies, then write `epoch:user:<userId>` = the current time in milliseconds for every affected user. Write a time, not an increment: KV has no compare-and-swap, and a read-modify-write loses concurrent bumps. The order matters: the serving Worker reads the epoch before it asks for a grant, so a bump that lands in between leaves the new cookie already stale.
- **The KV tier.** Revocation takes effect when the bumped epoch reaches the reader's colo. KV Classic propagates in about 60 s or more, and its colo cache (`cacheTtl`, at least 60 s) adds up to a minute, so expect 60–90 s, bounded above by the five-minute cookie in any case. KV Instant (private beta) replicates in under a second (p99 256 ms) and reads in about 1.6 ms, but allows 1 MB and one write per second per namespace, so it fits only if P5 stores just recently bumped epochs and batches writes.
- **Grants webhooks do not cover** (enterprise policy, IdP sessions) end with the cookie's lifetime and the source's own mirror TTL.
- **Repositories made private.** Anonymous readers hold no cookie: the serving isolate's one-minute public-repository memory is the bound, after the source already denies.

### Read order and caches

| Object | Memory (per isolate) | Public: cacheable subrequest (all tiers) | `caches.default` (per colo) | R2 |
|---|---|---|---|---|
| Ref pointer (mutable) | Fresh 5 s, then served stale up to 60 s while one refresh runs | Never | Never | On a miss |
| Manifest, sidebar, rendered page, image blob (immutable keys) | 16 MiB LRU, entries up to 1 MiB, parsed | `{origin}/__repo-cache/tiered/v1/{sig}/{storage key}`, `Cache-Control: public, max-age=31536000, immutable` | `{origin}/__repo-cache/v1/{storage key}`, filled in `waitUntil` | On a miss |

Every immutable object is read in that order: memory, then — for a public repository — a signed cacheable subrequest, then the per-colo `caches.default`, then R2. `caches.default` is per colo and a `cache.put` never reaches Cloudflare's Tiered Cache or Cache Reserve, so a public miss is fetched from the Worker's own origin as a subrequest instead: the Worker reads R2 and answers with an immutable `Cache-Control`, and the colo cache and every tier above it keep the copy, which the next isolate (or colo) reuses. The subrequest path carries an HMAC over `public\n<visibility epoch>\n<storage key>` under a key derived from `REPO_CAPABILITY_SECRET` for this purpose alone (`HMAC(secret, "rendro-repo-shared-cache:v1")`, #295; the capability purposes have their own), with the epoch in the path, so the route only serves keys this Worker decided are public at the epoch they were decided at: a private key has no valid signature, no two objects or repositories share a cache key, and a privatized repository's outstanding URLs die at the epoch. Before serving, the route re-reads the repository's visibility epoch from KV (`epoch:repo:<id>`, written by the access directory when a repository is made private, removed, or left by its installation; never expiring, since a revert to 0 would revive old URLs): a URL minted before the bump no longer matches and is the plain 404, an epoch store that cannot answer is a retryable 503, and the KV read's colo TTL (60 s) is the revocation bound. The subrequest is cacheable (`cf.cacheEverything` with per-status TTLs: a year for 200s, a minute for the revocation 404, never a 5xx — the signed URL is deterministic, so a cached faulting fill would poison every later read) and only GET/HEAD apply. Private repositories skip the subrequest entirely — their objects are sealed and must not enter a shared cache — and read through `caches.default` and R2 as before. The `caches.default` keys live under a path no route serves, so only this code can read them, and only with a `RepoGrant`; the tiered route is the one exception, and it serves only signed public keys straight from R2 (it must not recurse into the layered reader). Bytes are cached as stored and opened per read, after authorization (#263): a private repository's `caches.default` entries are sealed, and only bytes that opened under the current key are cached, under that key's ID (`…/v1/sealed/{key id}/{storage key}`). The tiered route never serves sealed bytes (a repository made public keeps its sealed content): it answers them with the plain 404, and the reader opens them from R2. See [Repository content lifecycle](#repository-content-lifecycle-github-pivot-p9b). A commit-pinned URL without a snapshot at the current renderer version falls back to the previous version's while a rebuild runs.

**Deployment requirement.** A same-zone `fetch()` re-invokes the Worker only when it runs on a Custom Domain (on a route or `workers.dev`, the platform refuses same-zone Worker-to-Worker fetches), and the Custom Domain makes the Worker its own origin, so there is no separate origin to configure and no loop: the subrequest re-enters the Worker once at the signed route, which answers from R2 without issuing further subrequests, and a filled cache answers before the Worker runs at all. Deploy the serving Worker on a Custom Domain (e.g. `rendro.app`, `dev.rendro.app`) for the shared tier to fill; on a route the subrequest fails, the reader falls back to the per-colo path, and public reads stay correct but never reach the shared tier. With `REPO_SHARED_CACHE_DEBUG=1` (development only), a public frame response carries `X-Repo-Shared-Cache: cf=<CF-Cache-Status>; age=<Age>` from the request's last subrequest, so a shared-tier hit is provable in a deployed environment.

### Headers

| Response | `Cache-Control` | Validator |
|---|---|---|
| Shell | `private, no-cache` (never `no-store`; each response has its own nonce) | none |
| Public frame or image at a commit URL | `public, max-age=31536000, immutable` | Public frames `"page-<render key>-<template tag>"`; images `"git-<blob SHA>"`. A 304 needs no object read |
| Private frame, image or tree page at a commit URL | `private, max-age=300`: a browser keeps it no longer than the capability cookie lasts, so a copy never outlives a session or an access decision by more than that (#293) | Images and tree pages as public ones |
| Frame or image at a branch URL | `public` or `private`, `max-age=10, stale-if-error=86400` | Public frames and images as above |
| Private frame | as above | none: it embeds a per-reader ticket with the same five minutes, which a revalidated copy would keep past its expiry |
| Ticket-authorized image | `private, max-age=300` (the ticket's lifetime) | `"git-<blob SHA>"` |
| Tree page | as the URL's ref | `"tree-<commit>-r<renderer>"` |
| Renewal, denials, faults | `private, no-store` | none |

Images get `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'self'`, ranges and HEAD through `serveObject` (#94). Frames are generated, so they are never ranged. Every response has `Referrer-Policy: no-referrer`.

### First view: ingest on first visit (#242)

A reader who opens a repository or branch nobody has ingested yet should not have to wait for a webhook. After authorization succeeds, the read path asks the per-repository coordinator Durable Object (`REPO_INGEST` binding, the serving Worker's cross-script binding to the ingest Worker's `RepoIngestCoordinator`) to `ensure` the branch: the same single flight, admission state, pointer write and failure recording as the queue path (above). `installationIds` stay in the permission source's mirror; the reader's `RepoRef` carries `installationId: null`.

What the reader sees depends on the outcome inside a 5-second window (`PREPARE_WINDOW_MS`):

- **Outcome arrives in window.** `flipped`/`current`: the pointer is read again, this time fresh (the same request's "never ingested" pointer miss would otherwise hide the just-published branch for up to 5 s, so `RepoSnapshots.pointer` takes a `fresh` flag), and the response is the ordinary docs. `duplicate`: still building, the preparing page. `no-ref`: a plain 404, no readiness header. `failed`: the retry page, 503. `throttled` (the repository's first-view budget is spent, below): #225's retryable 503 with `Retry-After` set to the end of the budget window.
- **Window expires.** The response is the preparing page (200) while the build continues unattended (`waitUntil` holds the coordinator call; the build proceeds whatever the reader does). Every later poll runs its own `ensure` — the per-isolate `SingleFlight` still shares any call still open, and the coordinator coalesces the rest — so the page is self-healing and the server stays stateless. A transport failure from the coordinator is #225's retryable 503; it never becomes a 404. "Ready but no pointer" (the coordinator answered while the store lost the pointer) is a broken store, so also a retryable 503.

The preparing page (`renderPreparingPage` in `src/repo-read/preparing.ts`) is `aria-busy`, announces itself politely (`role="status"`), polls its own URL with `fetch` (`cache: "no-store"`) after the response's `Retry-After` (5 s) doubling per attempt, capped at 60 s, pausing while the tab is hidden. The poll reads the state from `X-Rendro-Readiness` and the status: a 404 stops with "These docs are no longer available.", a `failed` state loads the retry page with `location.replace`, and anything else that is no longer `preparing` reloads into the docs. The server never polls itself from `waitUntil` and stores no per-reader state: any reader of the URL can re-check what any other is preparing. The retry page (503) is the same layout with `role="alert"` and a `Retry` link to the URL itself; the retry re-runs `ensure` (the coordinator records the failure but always re-attempts, so reader retries are fresh attempts). The page follows the reader's theme (#270): like every Worker-served page it ships the shared theme runtime (`renderThemeAssets`), which sets `html.dark` from the reader's saved choice or appearance, and the page's own variables follow it.

| Response | `Cache-Control` | State header |
|---|---|---|
| Preparing page (200) and retry page (503) | `private, no-store` | `X-Rendro-Readiness: preparing` / `failed`, `Retry-After: 5` |

#### First-view admission (#294)

A first view is the one read that can make Rendro call GitHub on a reader's behalf, so it is admitted at two levels before any GitHub call:

- **Per client, in the serving Worker.** A first view of a branch other than the repository's default (by `~branch` URL) takes one token from the `FIRST_VIEW_LIMIT` Workers Rate Limiting binding, keyed on the ingress-verified client address (`authClientIp`, as `/rum` is, #282; unregistered addresses share one `unverified` bucket). A refusal is #225's retryable 503 with `Retry-After: 60` and enqueues nothing. The default branch, by name or by the bare URL, needs no token: the coordinator builds it once and keeps the answer, and a reader's preparing-page polls never spend tokens there. Without the binding, or when it fails, first views of other branches are refused and the default branch still prepares: nothing else would bound how many branch names one client can make the coordinator ask GitHub about, and pushes still build every pushed branch, so only branches nobody has pushed to since the installation wait. `FIRST_VIEW_LIMIT` is configured in `[env.development]` (20 a minute per address, namespace `2940`) and in the tests.
- **Per repository, in the coordinator** (`ensure`, storage key `first-views`). A branch GitHub answered "no such ref" for is negative-cached for 5 minutes (`MISSING_REF_TTL_MS`): repeats answer `no-ref` with no GitHub call, and a later push or ingest that finds the branch drops the entry. Other than the default branch, a new first-view job (readers joining a queued or running job spend nothing) needs room under two limits: at most 10 distinct branches GitHub did not know per 10-minute window (`UNKNOWN_BRANCH_CAP`; jobs still in flight count as possible misses, so readers arriving together cannot exceed it), and at most 30 first-view jobs per hour (`FIRST_VIEW_BUDGET`, which also bounds builds of real branches). Past either, `ensure` answers `{ status: "throttled", retryAt }` without calling GitHub. Updates to the record are serialized inside the object, so concurrent readers never lose each other's counts. The serving Worker tells the coordinator which branch is the default (`defaultBranch` on `/ensure`); it is exempt from both limits, not from the negative cache.

Enqueueing happens strictly after authorization, so an unauthorized reader neither leaks the repository's existence into the coordinator nor triggers a build; commit-pinned URLs and every non-shell target (frames, trees, tickets, files) are plain 404s with no enqueue. Where the binding is absent (today: production and the E2E worker), every URL under `/r/` behaves exactly as before, 404 included; no migration to `wrangler.toml` is made until the ingest Worker ships.

The same binding receives the read path's view reports for idle expiry (`touchRepo`, at most once an hour per isolate and repository; [Idle expiry](#idle-expiry)). The binding is read per request through `services(c)`'s shape check (`durableFirstView`), shaped once per isolate per namespace (`WeakMap`). Tests: `tests/repo-read-routes.test.ts` (first-view dispatch, preparing/retry/404, single flight across requests, transport 503, per-client admission and the budget 503), `tests/repo-read-units.test.ts` (window race, outcomes, page rendering, backoff), `tests/ingest-coordinator.test.ts` (negative cache, the unknown-branch cap alone and under concurrency, the budget, a real new branch flipping after the window) and `tests/repo-read-first-view-workerd.test.ts` (real cross-script binding and rate-limit binding, gate on GitHub, preparing then docs; an unknown branch asked about once; a new branch prepared).

### Viewer integration

The shell is `renderScopedDocumentShell` with the lazy tree:

- `data-document-base` is the URL the reader opened (`/r/o/r` or `/~branch`), so history and copied links follow the branch.
- `data-frame-base` pins frames and tree pages to the commit the branch served (lazy tree v46). A branch view therefore stays consistent while browsing; a reload picks up a newer commit.
- Tree pages come from the snapshot's sidebar index, with titles. Folders between the repository root and the docs root appear too, and a directory's landing page is its first child.
- Private shells add the private viewer's parent script (ticket renewal) and its update notice.
- The share button copies the viewer URL ("Copy link").

The frame wraps the sanitized page in Rendro's markup: the comment widget (#254), the hashed `repo-doc` stylesheet (GitHub-style typography plus `HIGHLIGHT_CSS`, kept identical by a test), the navigation bridge and, for private repositories, the ticketed image URLs and renewal client (see "Asset tickets for private frames"). Ingest emits repository-internal links and images relative to the document's own directory (see "Rendering and sanitizing"), so the frame resolves them under whatever commit or branch URL it was loaded from without rewriting its links (#242). External images that ingest wrote as signed image-proxy paths (`/img/<sig>/<url>`, see "Image proxy") stay absolute, but only when `verifyImageProxyPath` accepts them, so a repository folder named `img` still resolves inside the repository. The derived body depends only on the render key, so it is derived once per isolate and kept in memory (a variant key prefixes `legacy-` for a version-2 render, which the read path still rewrites to the old `/<repo path>` form until the rebuild finishes, and `private-` for a private frame's image split). A page ingest could not render shows a notice instead.

### Bindings and configuration

| Binding | Type | Purpose |
|---|---|---|
| `REPO_CONTENT` | R2 | The ingest bucket (`gh/v1/`), read through #229's `ObjectStore` and `ContentSealer` |
| `REPO_EPOCHS` | KV | Revocation epochs |
| `REPO_ACCESS` | Service binding | The control Worker's permission source, bound to its `RepoAccessService` entrypoint (#295) |
| `REPO_SEARCH` | D1 | The repository search index (#251); without it the search URL is the plain 404 |
| `FIRST_VIEW_LIMIT` | Rate Limiting | Per-client admission of first views of a branch other than the default (#294); without it those are refused |
| `SEARCH_LIMIT` | Rate Limiting | Per-client search rate (#294); without it searches are not limited per client |

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
- Real-user monitoring and `Server-Timing` phases ship with #282 ([Real-user monitoring](#real-user-monitoring-282)); dashboards and alerting are a follow-up.

## Real-user monitoring (#282)

Every latency budget of the read path (cached view, cold colo, in-shell switch, first view) is checked against field data from two sources: `Server-Timing` phases on every authorized `/r/` response, and a small browser bundle in the repository shell that reports web-vitals and in-shell navigation timings to a Workers Analytics Engine dataset. Only the `/r/` surfaces are instrumented: management pages and the legacy viewers carry neither.

| Module | Role |
|---|---|
| `src/repo-read/timing.ts` | `ReadTiming`: the per-request phase record and its `Server-Timing` header |
| `src/rum/schema.ts` | The beacon schema: enumerations, bounds, the strict validator shared by browser and Worker |
| `src/rum/client.ts` | `/rum.js`: web-vitals, navigation measures, frame and request timings, `sendBeacon` |
| `src/rum/route.ts` | `POST /rum`: cross-site refusal, size cap, schema, in-colo rate limit, one data point per event |
| `src/viewer/navigation.ts` | The frame reports its own response timing with `doc-loaded` (`documentResponseTiming`) |

### Server-Timing phases

An authorized `GET /r/…` response (shell, frame, image, tree page, search, renewal, preparing page, and a 503 after authorization) carries one header such as `Server-Timing: auth;dur=0.4, cache;desc=r2, shared;dur=6.1, r2;dur=2.3, total;dur=11.8`. The metric names are fixed, `desc` is one of four words, and nothing names a repository, path, commit, user or key.

| Metric | Present when | Meaning |
|---|---|---|
| `auth` | always | Authorization (`authorizeRepo` / `authorizeTicket`): cookie verify, the epoch read, and on a miss the session and permission source |
| `cache;desc=` | always | The slowest tier any object read needed: `memory` (all in this isolate), `shared` (the signed cacheable subrequest), `colo` (`caches.default`), `r2` |
| `shared`, `colo`, `r2` | that tier was tried | Wall time spent in that tier, summed over the request's reads (a miss counts too). A pointer refreshed in the background is not on the request's path and is not counted |
| `first-view` | a first view waited | The `ensure` window before the preparing page or the docs (#242) |
| `total` | always | Middleware entry to the response, error mapping included |

Search has no phase (#294): a search response reports the phases above with its `total` rounded up to the next 10 ms (`COARSE_TOTAL_MS`), so it carries no fine-grained measure of the index. Real-user monitoring's `server` metric for the `search` route reads that total, unchanged in shape.

Denials, unknown repositories, malformed URLs and an unconfigured Worker carry no `Server-Timing` at all, so a denial stays byte-for-byte the response for a repository that does not exist. Recording costs a few clock reads per request; the header is built once after the handler. In Workers the clock advances only across I/O, so phases measure I/O waits, not CPU. The shared-tier route and `POST /r/…/comment-access` report nothing.

### What the browser sends

The repository shell loads `/rum.js?v=<RUM_VERSION>` with `async` and the request nonce (a versioned, same-origin bundle in the asset ledger; `connect-src 'self'` already admits the beacon, so the CSP is unchanged). It bundles `web-vitals` 6.2.3 (Apache-2.0; the attribution-free build, licence named in a banner): 12.6 KB minified, 4.8 KB gzip, 4.3 KB Brotli. It never runs on a click: it only observes performance entries, which the browser delivers asynchronously (web-vitals' one input listener ends LCP on the first input).

- **Shell document:** LCP, INP, CLS, FCP and TTFB, plus the shell's own `Server-Timing` total, with the shell's `cache` tier.
- **In-shell navigation:** the lazy tree writes one `rendro:navigation` `performance.measure` per settled navigation (repository read path only). It starts at the activating event's `timeStamp` (a click, a key, a frame's message, a `popstate`; navigation start for the first document) and records the frame swap (`src` replaced, or the preloaded sibling revealed), the frame's `load` (for a preload, the reveal), and the next paint (a task after the following animation frame). Only `performance.now()` reads happen on the click path; the measure is written after the paint. `rum.js` turns it into `swap`, `load` and `switch` events with `preloaded`.
- **Frame response:** an opaque-origin frame never exposes its `Server-Timing` to the shell's resource timing, whatever `Timing-Allow-Origin` says (Chromium reports an empty `serverTiming`). The frame reads its own navigation entry and adds `{ url, tier, server, response }` (its own path and query) to its existing `doc-loaded` message. A frame and the shell run apart, so the report may arrive before or after the navigation measure: the shell matches the two by address, a navigation waits for its report, and one still waiting at the next send goes without a tier or response. Each report serves one navigation, only messages from the shell's own frames count, and at most 16 unused reports are kept.
- **Tree and search:** the resource entries of `/r/…/tree` and `/r/…/search` fetches give `response` (start → response end) and `server`, with their tier.
- **Comments (#284):** the comment host in the shell writes `rendro:comments` when a page's first comments (the first-access snapshot or the live page, whichever came first) reach its widget, from navigation start for the shell's opening page (minus `activationStart` for a prerendered one) and from the frame's `load` for later pages, and `rendro:comment-echo` from sending the reader's own thread or reply to its save. `rum.js` turns them into `comments` events, metrics `ready` and `echo`, with the shell's navigation type for the opening page and `switch` otherwise. See [First comments and the reader's own writes](#first-comments-and-the-readers-own-writes-284).

Navigation types: the shell's own load is `cold`, `reload`, `prerender` (counted from `activationStart`; collection starts at `prerenderingchange`), `back-forward` (refetched) or `bfcache` (restored: no request, so no tier); inside the shell, `switch` (a link, a search result, a confirmed document link) and `history` (back/forward between documents). Tree and search requests carry the shell's navigation type.

Events are queued and sent with `navigator.sendBeacon` as a `text/plain` JSON string, at most 32 to a beacon, when the page becomes hidden, once the queue holds 32 events, and on `pagehide` only if the page is already hidden: leaving fires `pagehide` while still visible and then `visibilitychange`, after web-vitals finalizes LCP, CLS and INP, so one leave sends one complete beacon. There is no `unload` listener, and the page stays eligible for the back/forward cache. An event that would fail the schema is dropped before it is queued.

### `POST /rum`

Mounted before the session middleware; it reads no cookie and sets none, and every answer is `private, no-store` with no body.

1. **Cross-site posts are refused (403).** Where the browser sends `Sec-Fetch-Site`, it must be `same-origin`, and an `Origin` other than `"null"` must equal the site (`SITE_URL`, else the request's origin). Without `Sec-Fetch-Site` the `Origin` must match exactly. (Chromium sends both; the Fetch standard lets a beacon from the `no-referrer` shell carry `Origin: null`, which only `Sec-Fetch-Site` can vouch for.)
2. **No dataset or rate-limit binding: 204, and the body is dropped unread.** Production until its deploy adds both.
3. `text/plain` or `application/json` only (415); the body is capped at 8 KiB while reading (413).
4. **Strict schema (400 for any fault, no partial acceptance):** exactly `{ "v": 1, "events": [...] }`, 1–32 events. Each event has exactly `route`, `metric`, `value`, `nav` and optionally `tier` and `preloaded`, no other key; every string is an enumeration, metrics only on their routes (web-vitals on `shell`, `swap`/`load`/`switch` on `frame`, `response` on `frame`/`tree`/`search`, `server` anywhere), `value` finite and 0 ≤ value ≤ 3,600,000 ms (CLS ≤ 100), `preloaded` a boolean on navigation metrics only.
5. **Rate limit:** one token from a Workers Rate Limiting binding (`RUM_LIMIT`, `[[ratelimits]]`: 60 per 60 s), keyed on the ingress-verified client address the Worker already registers (`CF-Connecting-IP`, `authClientIp`); requests without one share an `unverified` bucket. The counter lives in the colo, so the limit costs no round trip and depends on nothing outside the Worker. Validation runs first, so only a beacon that would be written spends a token. Over the limit, or if the limiter fails, the answer is still 204 and nothing is written: a beacon is never retried, so a refusal status would only add noise. 60 a minute is about one beacon per page leave plus a full-queue flush every 32 events (roughly six switches), with room for a handful of readers behind one NAT; the limiter is per colo and eventually consistent, so it bounds abuse rather than counting exactly.
6. One `writeDataPoint` per event, then 204.

### Dataset schema

Dataset `rendro_rum_dev` (binding `RUM_ANALYTICS`, with the `RUM_LIMIT` limiter, namespace `2820`; `[env.development]` in `wrangler.toml` only; tests fake both). The dataset binding stays commented out until Analytics Engine is enabled on the Cloudflare account; until then dev drops beacons, as production does. One row per event:

| Column | Holds |
|---|---|
| `index1` | `metric` (the sampling key, so rare metrics keep their weight) |
| `blob1` | `route`: `shell`, `frame`, `tree`, `search` |
| `blob2` | `metric`: `LCP`, `INP`, `CLS`, `FCP`, `TTFB`, `swap`, `load`, `switch`, `response`, `server` |
| `blob3` | `nav`: `cold`, `reload`, `prerender`, `back-forward`, `bfcache`, `switch`, `history` |
| `blob4` | `tier`: `memory`, `shared`, `colo`, `r2`, or empty |
| `blob5` | `preloaded`: `1`, `0`, or empty |
| `blob6` | The colo that received the beacon (`request.cf.colo`, three capital letters), or empty |
| `double1` | The value: milliseconds, or the CLS score |

A schema change is a new dataset, never a reinterpretation of these positions.

### Privacy guarantees

- No user, session, repository, owner, path, URL, commit, query or IP is ever sent or stored. The schema has no field that could carry one, and an event with any extra key is refused whole.
- The beacon endpoint reads no cookie and sets none. The client address is only the key of the colo's rate-limit counter; it is never written to the dataset or sent anywhere.
- The colo is the only location, at the granularity of a Cloudflare data centre.
- Server-Timing headers carry fixed names and four tier words, and only on authorized responses.
- Production has no binding until its deploy adds them; without them beacons are accepted and dropped unread.

### Querying the budgets

Against the [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) (`POST https://api.cloudflare.com/client/v4/accounts/<account>/analytics_engine/sql`). Rows are sampled, so weight every aggregate by `_sample_interval`. The budgets are those of the performance research behind #214.

```sql
-- Cached page view: server time ≤ 10 ms, TTFB ≤ 100 ms, LCP ≤ 1.0 s (desktop) at p75, warm colo
SELECT blob2 AS metric, quantileExactWeighted(0.75)(double1, _sample_interval) AS p75, sum(_sample_interval) AS views
FROM rendro_rum_dev
WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob1 = 'shell' AND blob3 IN ('cold', 'reload')
  AND blob4 IN ('memory', 'colo') AND blob2 IN ('server', 'TTFB', 'LCP', 'INP', 'CLS')
GROUP BY metric

-- Cold colo: shell TTFB ≤ 300 ms when the read reached the shared tier or R2, per colo
SELECT blob6 AS colo, quantileExactWeighted(0.75)(double1, _sample_interval) AS ttfb_p75, sum(_sample_interval) AS views
FROM rendro_rum_dev
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'shell' AND blob2 = 'TTFB' AND blob4 IN ('shared', 'r2')
GROUP BY colo ORDER BY views DESC

-- In-shell navigation: click → painted ≤ 200 ms on a cache hit, ≤ 500 ms on an edge miss
SELECT blob5 AS preloaded, blob4 AS tier, quantileExactWeighted(0.75)(double1, _sample_interval) AS switch_p75, sum(_sample_interval) AS switches
FROM rendro_rum_dev
WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob1 = 'frame' AND blob2 = 'switch' AND blob3 IN ('switch', 'history')
GROUP BY preloaded, tier

-- First view: first document painted ≤ 2.5 s after navigation start (the shell's own first document)
SELECT blob4 AS tier, quantileExactWeighted(0.75)(double1, _sample_interval) AS painted_p75
FROM rendro_rum_dev
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'frame' AND blob2 = 'switch' AND blob3 IN ('cold', 'prerender')
GROUP BY tier

-- Search: Worker time per query (target p50 ≤ 50 ms) and what the reader waited
SELECT blob2 AS metric, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50, quantileExactWeighted(0.9)(double1, _sample_interval) AS p90
FROM rendro_rum_dev
WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob1 = 'search' AND blob2 IN ('server', 'response')
GROUP BY metric
```

Push-to-live, revocation and comment round trips are not page-view metrics and are not in this dataset.

### Measured overhead

Measured in Chromium against the real Worker app on 2026-10-20 (shared i5-8300H, load 7–15), two runs of 12 fresh shells per variant, main's lazy tree with no `rum.js` against this one with `rum.js`. Synchronous work in the click handler: median 1.7 ms against 1.6–1.7 ms. Preloaded switch (`rendro:frame-switch`): median 53.4 / 48.6 ms against 53.7 / 48.1 ms. Plain switch: 50.8 / 48.2 ms against 46.9 / 57.2 ms, within the run-to-run noise of either. The navigation marks add 248 bytes Brotli to the lazy tree, which is now minified (v53: 11,148 → 8,418 bytes Brotli for the whole bundle).

### Tests

`tests/repo-read-timing.test.ts` (the builder, the header on each surface and tier, none on denials), `tests/rum-endpoint.test.ts` (schema, cross-site refusal, no binding, size, the rate limit and its key, data points) and `tests/rum-browser.test.ts` (Chromium with the back/forward cache enabled: a cold load, in-shell switches with and without the preload and a full-queue flush, in-shell history and a real back/forward-cache restore, prerender activation, and a browser without navigation timing; beacons are captured as the server received them and answered by the real endpoint).

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

One row per heading section: `(repo_id, blob_sha, slug)` primary key, plus the heading's title and the section's text; an external-content FTS5 virtual table, `sections_search(rk, title, body)` (`tokenize='trigram'`), over the `sections_keyed` view of it, kept in step by triggers. Trigram was chosen over unicode61 because code identifiers must match: a search for `neutralizeQuery` finds the function's section, and a prefix-free quoted phrase (`"install"`) matches inside words, which a unicode61 term cannot without a prefix `*` operator that hostile input must never reach. The cost is the three-character minimum: terms shorter than three characters are dropped at the query boundary and match nothing at the index (a deliberate bound, announced in the UI).

**Scoped in the index (#294).** One index serves every repository, so it is partitioned inside FTS5 itself: the first column, `rk`, holds a repository key (four code points from Supplementary Private Use Area-A, U+F0000–U+FFFFD, the repository ID in base 65,534; the view computes it with `char()`, `repoSearchKey` the same for the query). Every query is `rk : "<key>" AND {title body} : (<terms>)`, so FTS5 walks the key's doclist, which holds that repository's rows only, and advances the term doclists to those rows: what a query reads does not grow with other repositories' content. Indexed titles and bodies are stripped of that code-point range at `putBlob` (query terms are letters and digits only), so no repository's text can contain another's key. `+s.repo_id = ?` stays in the `WHERE` as a second check; the unary plus keeps the planner from driving the query by the `sections` index instead (SQLite versions differ in which they pick). The rank reads only the matched row: sections whose title matches more of the query first (counted from `highlight()` on the title), then the shorter section, then the older row. bm25 was dropped because its inverse document frequency counts every repository's matches of every term on each query. `tests/search-index.test.ts` pins the plan (`EXPLAIN QUERY PLAN`: the FTS index drives, `sections` is joined by rowid), that the index yields only the scoped repository's rows next to 10,000 matching rows of another, and identical results either way.

**Migration.** Forward-only and in code, like the rest of the schema: `migrate()` runs one batch (a D1 transaction) of idempotent statements per isolate. In a database still holding #251's `sections_fts`, the first run creates the view and `sections_search`, swaps the triggers, rebuilds the new index from `sections` (`'rebuild'`, only while `sections_fts` exists) and drops the old index; every later run changes nothing.

Section text is extracted after heading ids are assigned but before link decoration and code highlighting, so it is plain prose. Each section's text (8,000 chars), title (512), the page's total text (200,000) and section count (256) are capped, and whitespace/control characters collapse to single spaces so the `\u0002`/`\u0003` code points stay reserved for query snippets. Rows are keyed by blob SHA and are content-addressed like renders: a blob rendered at two paths is indexed once.

### Incremental ingest hook

`buildSnapshot` gains an optional `search` (the `SearchIndex`; absent where no binding is configured). A fresh render indexes its blob's sections after the render object is stored; a reused render (a page moved, a key changed) re-indexes only when `hasBlob` says the blob has no rows, so unchanged blobs reuse their rows across commits instead of paying a rewrite per push — the same reuse discipline the render cache follows. Writes happen before the pointer flip, so a commit is served only once its pages are indexed; a D1 outage fails the attempt and the queue retries it. A snapshot built before the binding existed is not backfilled; it gains rows the next time one of its blobs renders or its render key changes (P-deploy can backfill once, if ever needed).

### Query endpoint

`GET /r/{owner}/{repo}[/{ref}]/search?q=&limit=` sits behind the same authorization as every other `/r/` read (#239): a denial is the plain 404, and the URL is script-read JSON, so its denial and errors are JSON like a tree page's, `private, no-store`. Bounds: `q` at most 200 characters (shared with the shell input's `maxlength`), `limit` clamped to 1–50 (default 20). `neutralizeQuery` never passes reader text to FTS5 as syntax: terms are reduced to `\p{L}\p{N}` runs of at least three characters (at most 16 terms, each at most 64 characters) and quoted, so `NEAR`, `*`, quotes, column filters and parentheses become separators and cannot error or widen the query.

Each search takes one token from the `SEARCH_LIMIT` Workers Rate Limiting binding (#294), keyed on the verified client address like `FIRST_VIEW_LIMIT`, after authorization (a denied reader spends nothing). Refused: `429` with `Retry-After: 60` and `{ "error": …, "code": "rate_limited" }`, which the shell shows as its existing "Too many searches" wait. Without the binding, or when it cannot answer, the search runs: the index is scoped per repository, so a client's searches cost only that repository's rows. Configured in `[env.development]` (60 a minute per address, namespace `2941`) and in the tests.

Candidates are fetched at four times the page size, then mapped back onto the served snapshot's manifest by blob SHA: a hit is returned only when a renderable page of this exact snapshot carries that blob, so content that moved still resolves to its current path and nothing leaks across repositories or commits (the unit suite pins both). `more` reports that the candidate fetch filled up, approximately.

### Shell UI

The search box sits in the repository shell's sidebar (`renderRepoSearch`, markup also mirrored in the browser-test fixture). `/` focuses it from anywhere outside a typing context; typing is debounced (200 ms) into one request to the pinned commit's `/search`; results are a listbox of options with `path#slug`, the title and a snippet whose matched runs arrive wrapped in `\u0002`/`\u0003` and are rendered as `<mark>` text nodes — snippet text is never parsed as HTML. Arrow keys move the selection (wrapping), Enter or a click activates it through the same in-shell `loadDoc` a tree row uses, so the shell owns the history entry and the frame scrolls to the section. Escape, an outside click and the clear button close the panel. Loading ("Searching…"), empty and error states (with a Retry control) are announced through a `role="status"` live region, and the shell's `maxlength` bounds the input client-side. The panel carries `role="listbox"` only while it holds options: while it shows a single message (no results, an error) the role and the combobox's `aria-controls` are dropped, so screen readers are never told about an empty listbox, and both come back with the next result set (#270). A rate-limited reply (429) is its own message, "Too many searches — try again in N s", read from `Retry-After` (seconds or an HTTP date, shared with the shell's parser): its Retry stays disabled until the wait elapses and the live region announces the wait once and its end; without a usable `Retry-After` Retry is enabled at once (#270). Asset version: lazy-tree 52.

### Measurements

Measured with `tests/repo-read-workerd.test.ts` on 2026-10-19 (`search query (1,000-page repo, limit 20)`, 200 sequential keep-alive requests cycling four terms): p50 11.6–18.3 ms and p90 14.5–30.4 ms wall time through local workerd and its local D1 (Miniflare SQLite) across runs, on the shared i5-8300H under load 12–15, against the 50 ms p50 target. Roughly `/health`'s 3.2 ms stack floor plus the FTS5 MATCH + bm25 ranking over 1,000 pages and the commit-scoping map. Production D1 adds its network round trip in place of Miniflare's in-process SQLite. After the per-repository key and row-local rank (#294), the same test on 2026-10-20 measured p50 22.2 ms / p90 32.4 ms against origin/main's 19.2 / 31.7 ms in back-to-back runs under the same load (about 10–12): within noise. A rank that also counted body matches with `highlight()` measured about twice that and was not kept.

### Open points

- No index GC: rows of blobs a repository no longer contains stay until a purge or an idle expiry (#263) deletes the repository's rows (`deleteRepo`, by `repo_id`, in bounded batches).
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
| `POST /v1/authorize` (entrypoint `RepoAccessService`) | The serving Worker (`REPO_ACCESS`) | `repoAccessHandler` over the directory: the read path's protocol (#234) |
| `POST /v1/accounts/link` (entrypoint `RepoAccessService`) | P1's sign-in, through `REPO_ACCESS` | `{ userId, githubId, login, tokens }`: binds a Rendro user to a GitHub account and stores its user-to-server tokens. 204, no body |
| `POST /v1/accounts/unlink` (entrypoint `RepoAccessService`) | P1's sign-out of GitHub, through `REPO_ACCESS` | `{ userId }`: drops the tokens and mirror and revokes the user |
| `POST /v1/github/webhook` (default handler) | GitHub | Permission events. 202 applied, 200 duplicate, 204 ignored, 400 malformed, 401 bad signature, 503 not configured |

The internal endpoints are served only by the named entrypoint `RepoAccessService` (#295). A named entrypoint is reachable only through a service binding that names it, never over HTTP, so the serving Worker binds it with `entrypoint = "RepoAccessService"` (the URL's host is a convention, `repo-access.internal`, and checked by nothing). The default handler, which the public route the webhook will need exposes, serves the webhook alone and answers 404 for the internal paths on every host.

One Durable Object, `RepoAccessDirectory` (named `directory`, SQLite-backed), holds everything. A single instance makes the registry and the mirrors change consistently, and every `authorize` reaches it only on a capability-cookie miss (at most once per reader, repository and five minutes) or for an anonymous reader whose isolate has not seen the repository in a minute. That is the scaling limit to watch; sharding mirrors by user is the next step when it binds.

### What the directory keeps

- **Registry**: every repository the app can see (`repo:<id>`: owner, name, visibility, default branch, installation, removed, `check`), a name index, and each installation's state (`active`, `suspended`, `deleted`). A name resolves only to an active repository in an active installation.
- **Mirror per user**: the repository IDs `GET /user/installations` and `GET /user/installations/{id}/repositories` list for the user's token, with each page's ETag. A mirror is used for `MIRROR_TTL_MS` (five minutes), then refreshed with conditional requests (a 304 costs no primary quota). A listing stops after 20 pages of 100; an installation listed only in part falls back to `GET /repos/{o}/{r}/collaborators/{login}/permission` (installation token) for the one repository asked about, cached like a mirror. GraphQL `viewerPermission` would only help batch many single checks, which the listing already avoids, so it is not used.
- **Who holds what**: `holder:<repo>:<user>` and `member:<installation>:<user>`, written before the mirror they come from, so every user a mirror lets read a repository can be found when it must be revoked.
- **Tokens**: sealed (below), with a version that changes whenever they are replaced or dropped.
- **Delivery dedupe** (#229's, `DeliveryDedupe`) and the **epoch outbox**. Where comments are configured, the outbox also holds `notify:<user>` (an epoch Convex has not heard yet), `removed:<repo>` (a repository that left the app) and `restore:<repo>` (one GitHub says the app still has), so comment grants end with page access ([Comments on Repository Docs](#comments-on-repository-docs-github-pivot-p6)). Of a removal and a restore for one repository only the newer stays queued.
- **Purge ledger** (#258): `purge:<due time>:<repo>`, earliest first, with `purging:<repo>` naming each repository's one entry ([below](#purging-removed-repositories)).

`authorize(viewer, owner, name)`: resolve the name in the registry; a public repository is granted to anyone, as long as GitHub stated it public recently (below). Otherwise an anonymous reader, an unknown user or a user without tokens is denied. A linked user's mirror is refreshed if stale (single flight per user), the name is resolved again (a listing may have taught the registry a repository no webhook announced), and the repository is granted only if the mirror lists it, or the single-repository check says so.

### Public visibility is re-confirmed

A `repository.privatized` delivery can be missed (GitHub does not retry, and redelivery needs P1), and then nothing else would turn the record private: anonymous readers would keep reading. So public visibility is only as current as GitHub's last word on it (#295). Each registry record keeps `confirmedAt`, the time GitHub last stated its visibility: a single-repository read (`GET /repos/{o}/{r}`, installation token), a user's listing that included it, or a purge check that found it still accessible. A public record older than `PUBLIC_CONFIRM_TTL_MS` (five minutes, the mirror's TTL) is read from GitHub again before it grants anyone. The read is conditional on the ETag of the read that set the record's fields (dropped whenever an event or a different listing changes them), so an unchanged repository is a 304 that costs no primary quota. GitHub's answer is applied like a check after an event: private or gone, the record denies and the visibility epoch is written at once, exactly as the missed delivery would have written it, so outstanding shared-cache URLs die too.

While GitHub cannot answer (an outage, a rate limit, the five-second failure cooldown), a public record keeps granting until it is `PUBLIC_CONFIRM_MAX_MS` (an hour) old, decided again from storage, so an event that landed meanwhile still counts. Past that bound nobody is granted on it: the answer is a 503 until GitHub confirms it again. A record stored before `confirmedAt` existed counts as never confirmed.

The cost is bounded by reads, not by the size of the registry: at most one conditional request per public repository that is actually read, per five minutes, on the installation's own budget (`installation:<id>`), and the serving Worker asks the directory about a public repository at most once a minute per isolate. Re-checking every tracked public repository from the reconciliation cron instead would spend a request per repository per run whether anyone reads it or not, and would still leave a window of a whole cron period. A repository nobody reads exposes nobody, so the read path is where the check belongs.

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

**Order.** The plan updates the registry, then reaches users (mirrors are now stale, so `authorize` already asks GitHub and denies), then queues the epochs, remembers the delivery and writes the epochs. Epochs are written from a durable outbox (`pending:<user>`): inline after each delivery, and by the Durable Object's alarm, which also retries failed KV writes every 10 s. Each value is `max(now, previous + 1)` in milliseconds, written by one serialized pass at a time, so a user's epoch only grows. KV keys expire after an hour (`EPOCH_TTL_SECONDS`): an epoch outlives every capability minted before it (cookies and tickets five minutes), and KV holds only recently bumped users, which is what KV Instant needs.

**Races.** The Durable Object's input gates open while it awaits GitHub, so a webhook can land mid-refresh or mid-check. Two rules keep a stale grant out:

- Every answer is decided from storage alone, with no other await in between, so it reflects every webhook applied so far. When the decision needs GitHub first (an installation or repository check, a stale mirror, a single-repository check), that work runs and the decision is taken again from storage afterwards. After six rounds (webhooks kept changing the answer) it is a 503.
- GitHub work never commits a result an event overtook. A refresh records the user's generation and the registry's event sequence when it starts. It commits nothing if the user's generation changed, and it never overwrites a registry record an event changed after it started (tombstones included). A repository or installation check, or a single-repository check, is dropped the same way. So a listing GitHub sent before a revocation is never committed after it, and an uninstall that lands while a repository is being confirmed decides that very request.

### Failing closed

| Situation | Answer |
|---|---|
| GitHub error, timeout or rate limit while a mirror is fresh | The mirror answers (within `MIRROR_TTL_MS`) |
| The same once the mirror is stale | 503; for 5 s (`FAILURE_COOLDOWN_MS`) the same work answers 503 without calling GitHub again |
| Token near expiry | Renewed first (one renewal per user at a time: GitHub rotates the refresh token on use; a renewal decided from a stale token snapshot serves the tokens a just-finished renewal stored instead of renewing again) |
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
| If the epoch never arrives (KV outage) | The cookie's five minutes for pages and branch views; five minutes for frame images through a ticket already issued |
| No webhook (enterprise policy, a lost delivery the reconciler has not redelivered) | Mirror TTL + cookie lifetime: at most ten minutes for pages (tested: `tests/repo-access-revocation.test.ts`); a ticket issued just before can add its five minutes for frame images of that commit |
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
| `REPO_INGEST` | Durable Object binding, optional | The ingest Worker's `RepoIngestCoordinator` (`script_name` the ingest Worker): a confirmed removal purges the repository's cached R2 content and search rows (#263) |

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

A single-repository check that finds the repository accessible during the window (a reinstall: the `added` event marks it for a check, and the next read asks GitHub) cancels the purge and restores the comments at once; a later removal starts a new window. The alarm is re-armed for the earliest entry after every pass, never later than a retry the outbox needs sooner. Logs carry counts only (`access.purge`, `access.removal-reverted`); the audit trail is Convex's `auditEvents` (`repository.removal_reverted`, `repository.comments_purged`). The same confirmation purges the repository's cached content in R2 and its search rows (#263): where the control Worker binds the ingest Worker's coordinators (`REPO_INGEST`), each confirmed repository's coordinator is asked to purge, and the entry is done only when every purge it asked for was accepted and Convex answered; a failure of either postpones the entry, which is confirmed with GitHub again (both purges are idempotent). Without `REPO_INGEST`, removed repositories' content stays until idle expiry deletes it, which nobody can stop, since a removed repository is never authorized. See [Purge of a confirmed removal](#purge-of-a-confirmed-removal).

### Open points

- One GitHub App has one webhook URL, but push events go to the ingest Worker (#229) and permission events here. P1 decides on a single ingress; the recommendation is the control Worker verifying once and forwarding `push` to the ingest queue.
- The account hand-over is a service-binding call; if P1's sign-in runs in Convex rather than a Worker, it needs an authenticated public path instead.
- Asset tickets are only epoch-checked, so a missed webhook can leave an open commit's frame images readable for a ticket's five minutes (the cookie's lifetime since #293).
- With KV Instant, the serving Worker's `cacheTtl: 60` becomes the dominant term.
- Commit-pinned frames of public repositories are cached `public, immutable`; a repository made private stays readable from browser caches that already hold a page.

## Repository Content Lifecycle (GitHub pivot, P9b)

R2 is a disposable cache of GitHub, but it holds copies of private docs (#263, part of epic #214). As defence in depth against a leaked bucket, cache entry or misrouted object, private-repository content is sealed per repository; content nobody reads expires; and a removal GitHub confirmed purges the repository's content, never on doubt.

| Module | Role |
|---|---|
| `src/ingest/orchestrator/sealing.ts` | The envelope: per-repository AES-256-GCM keys from `REPO_CONTENT_KEY`, key IDs, `SealedContentError` |
| `src/ingest/orchestrator/wipe.ts` | One bounded, idempotent step of deleting a repository's content and search rows |
| `src/ingest/orchestrator/coordinator.ts` | Per repository: what the content is sealed with, last access and idle expiry, purges; all serialized with ingests |
| `src/repo-read/snapshot.ts`, `first-view.ts` | Opening after authorization, what the edge cache may hold, and reporting views |
| `src/repo-access/content.ts`, `directory.ts` | The control Worker's purge, after `confirmRemoval` |

### Sealing

- **Keys.** Each repository's data key is HKDF-SHA256 of `REPO_CONTENT_KEY` (salt `rendro-repo-content:v1`, info `repo:<GitHub repository ID>`), imported once per isolate as a non-extractable AES-256-GCM key (at most 1,024 kept; the rest are derived again, one HKDF). Nothing per repository is stored. The **key ID** is 8 bytes of HKDF from the same secret (info `key-id`): it names a key without revealing it.
- **Envelope.** `00 52 43 53` (`\0RCS`), version `01`, the key ID (8 bytes), a fresh random IV (12 bytes), then the ciphertext with its 16-byte tag: 41 bytes over the plaintext. Anything else is not sealed content.
- **Additional data.** The 13-byte header, then `\nrendro-repo-content:v1\n<repository ID>\n<storage key>`. The storage key names the object (the blob SHA, the render key with its directory, the commit and renderer version of a snapshot), so a blob copied to another repository or swapped for another object of the same repository does not open, and neither does a rewritten header. The sealer refuses a key outside the repository's own prefix.
- **What is sealed.** Everything under a private repository's `gh/v1/repo/<id>/` prefix except its `ref/` pointers: blobs, renders, tree listings, sidebars and manifests. The pointers, the reconciliation registry, the audit records and the redelivery checkpoint hold only IDs, names and counts.
- **Public repositories stay plaintext**, so a shared cache tier can hold their objects as they are (#242).
- **Without a valid key** (`contentSealer`: missing, under 32 characters, or equal to the previous key) private content is neither written nor read: ingest fails with the transient `content-unconfigured`, and the read path answers 503. Public repositories are unaffected.

### Opening after authorization, and what each tier holds

Every snapshot read takes a `RepoGrant`, so content is opened strictly after authorization. A private repository's bytes must open; anything else (not an envelope, a tampered or truncated one, another repository's or another object's, a key this Worker does not hold) is logged with the repository ID and the reason only, and answered with #225's retryable 503. It is never served and never cached. A public repository's bytes are opened only when they are sealed (a repository once private stays sealed, below).

| Tier | Private repository | Public repository |
|---|---|---|
| R2 | Sealed | As stored |
| Colo cache (`caches.default`) | Sealed bytes only, and only those that opened under the current key, at `/__repo-cache/v1/sealed/{current key ID}/{storage key}`: an entry is never looked up under another key, so a retired key cannot leave unreadable entries behind | Plaintext at `/__repo-cache/v1/{storage key}`; sealed bytes (a repository made public) are not cached |
| Shared tier (Tiered Cache and Cache Reserve, through the signed subrequest, #242) | Never: private repositories skip the subrequest | Plaintext; the route answers sealed bytes with the plain 404, and the reader opens them from R2 instead |
| Isolate memory | Opened and parsed (16 MiB per isolate, never persisted): the process that serves the bytes holds them | Same |
| Browser | `private` responses only (unchanged) | `public` (unchanged) |

### Visibility, and content that does not open

The coordinator records what the stored content is sealed with (`content`: a key ID, `plaintext`, `none` after a wipe, or `unreadable`) and whether the repository was ever private (`private`). Before every job, and when a view reports the visibility it granted, it compares them:

- **Private once, sealed for good.** A message may carry a stale visibility (the reconciliation registry, a redelivered push from before the change), so a repository once private is always ingested sealed. Only a purge of a confirmed removal forgets it.
- **Made private.** The first private signal (a view's touch carries the visibility the reader was granted, a push, a first view) finds content stored as plaintext: the coordinator wipes it (`reseal`), and the next view ingests it sealed through the first-view path. Until the wipe, private readers get the retryable 503, since unsealed bytes are refused.
- **Made public.** The content stays sealed and is opened per read; it is not cached at the edge.
- **Content that does not open during an ingest** (the previous snapshot's manifest tampered with, a key that was dropped too early) fails the attempt with `content-tampered`, `content-unsealed` or `content-unknown-key`, which the queue retries; the coordinator marks the content `unreadable`, so the retry wipes it and builds from GitHub.

### Key rotation

1. Generate a new key (`openssl rand -hex 32`). On the serving Worker, then on the ingest Worker, move the old value to `REPO_CONTENT_KEY_PREVIOUS` and set the new one as `REPO_CONTENT_KEY`. The serving Worker goes first, so it can open new-key content before anything writes it.
2. New content is sealed under the new key; content sealed under the previous key keeps opening, but is not cached at the edge.
3. Each private repository's coordinator finds its content sealed under another key on its next touch (within an hour of a view), push or first view, wipes it and ingests it again (a first import: about 3 GitHub requests). Repositories nobody views expire within the idle window anyway.
4. After the idle window plus a margin, and once the logs show no `unknown-key`, remove `REPO_CONTENT_KEY_PREVIOUS` from both Workers.

A lost key costs a re-ingest, not data: content under an unknown key is a 503 until its coordinator, holding the new key, wipes and rebuilds it the same way.

### Idle expiry

- **Last access, not a write per view.** After authorization and a resolved snapshot, the read path tells the repository's coordinator (`POST /touch`, `{ id, private }`, in `waitUntil`) at most once an hour per isolate, repository and visibility (`TOUCH_INTERVAL_MS`, at most 4,096 remembered). The coordinator keeps last access to a thirtieth of the idle window (a day): at most one storage write a day per repository. A first view records it too, once the reader's build is done.
- **Expiry.** The coordinator's alarm is set for the end of the window, 30 days after last access (`IDLE_EXPIRY_MS`). When it fires with nothing newer recorded, the content is wiped (`idle`) and the repository is marked expired. Content nobody ever viewed expires 30 days after its first flip.
- **While expired.** Pushes and reconciliation answer `idle` (acknowledged, the delivery remembered, no GitHub request), and the reconciliation entry is gone, so the cron no longer checks it. An installation event ingests it.
- **The next view** finds no pointer, so the read path's first-view path (#249) asks the coordinator to `ensure` the branch: expiry is cleared and the branch is built. Commit-pinned URLs of older commits are plain 404s until something ingests them, as for any commit never ingested.

### Purge of a confirmed removal

The control Worker's purge ledger ([Purging removed repositories](#purging-removed-repositories)) asks each confirmed repository's coordinator to purge (`POST /purge`, `{ repoId }`, through `REPO_INGEST`). Only `confirmRemoval`'s `removed` reaches it: a replayed removal of a repository still installed is restored there, and nothing is deleted.

1. The coordinator records the wipe durably (`wipe`: reason, start time, counts) before deleting anything, in the same serialized chain as ingests: a running ingest finishes first, and any job queued after a pending wipe finishes the wipe before it builds, so nothing is ever written into a half-deleted prefix.
2. It deletes in bounded steps: the reconciliation entry and the pointers first (readers then see "never ingested", never a half-deleted snapshot, and the cron stops), then every object under the prefix (1,000 per call, at most 20,000 per step), then the search rows (500 per statement, at most 20 statements per step). Each step first moves the alarm a second ahead, so an evicted instance resumes. The answer is `done`, or `accepted` while steps continue from the alarm; anything else makes the ledger confirm with GitHub again later.
3. When nothing is left it writes the audit record `gh/v1/audit/purge/{repoId}/{startedAt}.json` (`{ schema, event: "repository.content-purged", repoId, startedAt, finishedAt, objects, searchRows }`), logs `ingest.wipe` with the same counts, and forgets everything it knew about the repository. A repeated purge finds nothing more to delete.

Idle expiry and resealing use the same steps; a removal outranks either while it runs.

### Measurements

Measured with `tests/repo-lifecycle-workerd.test.ts` on 2026-10-19: a benchmark Worker seals or opens one object `n` times inside local workerd, timed over HTTP and diffed against `n = 0` (workerd's clocks do not advance during computation), median of 7, on the shared i5-8300H; run 1 at load 5–7, run 2 at load 12–17. Target: microseconds per object.

| Object | Seal (run 1 / run 2) | Open (run 1 / run 2) |
|---|---|---|
| 1 KiB | 19 µs / 23 µs | 27 µs / 30 µs |
| 64 KiB | 47 µs / 70 µs | 64 µs / 81 µs |
| 1 MiB | 0.76 ms / 1.27 ms | 0.69 ms / 1.41 ms |

Rendered pages and manifests are a few KiB, so a sealed object costs tens of microseconds to open, once per isolate (memory then serves it). Through the whole read path (`tests/repo-read-workerd.test.ts`, the "Measurements" table of the read path), an R2 miss of a private page measured 9.4 ms p50 against 7.9 ms for a public one; the difference also includes the private frame's ticket and is within the run-to-run noise of that table.

### Open points

- The search index (#251) holds the section text of private repositories in plaintext in D1: full-text search needs it. Purges and expiry delete it with the content.
- Cache API entries of a purged or expired repository are not deleted (there is no per-prefix purge); they are sealed, reachable only after authorization, and age out of the colo cache.
- Production wiring of `REPO_INGEST` in the control and serving Workers ([SETUP.md](SETUP.md#github-repository-reads-not-configured-yet)).

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

**Public repositories.** Anyone may read. Writing needs a signed-in session (the shell's Convex JWT) and the public grant, and is rate limited ([Write quotas](#write-quotas)): 30 writes a minute per user and 300 per repository (`consumeWriteQuota(ctx, "comments", user, "repo:<id>")`). Author names are shown, email addresses never (a public repository's comments are public).

### Data model and retention

| Table | Indexes | Holds |
|---|---|---|
| `repoCommentGrants` | `by_repo_user`, `by_user` | Live grants |
| `repoCommentEpochs` | `by_user` | The latest epoch P5 reported per user |
| `repoCommentRepos` | `by_repo` | A repository readers have seen, and `removedAt` once GitHub reported it gone |
| `repoThreads` | `by_repo_path` (with `deletedAt`, `createdAt`), `by_repo_blob`, `by_operation` | Threads: anchor, body, author, resolved, archived, and the last edit (`editedAt`, `editOperationId`) |
| `repoReplies` | `by_thread` (with `deletedAt`, `createdAt`), `by_operation` | Replies, with their last edit |

Pages are bounded: 20 threads (24 rows, 1 MB read) with the newest 10 replies each, and 20 replies per reply page. Creates and replies are deduplicated by `clientOperationId`; resolve and archive take an explicit target, so a retry is a no-op. Anyone who may write may resolve; archive, delete and edit belong to the author ([Editing](#editing-ones-own-comments-287)). Deleting a thread leaves a scrubbed tombstone and scrubs its replies in batches of 100.

**Uninstalled repositories.** When GitHub reports a repository removed from the installation or deleted, or the installation or organization deleted, the control Worker's outbox (`removed:<repo>`) calls `repoCommentAccess:removeRepos`. Its comments are **hidden at once** (`removedAt`; every grant deleted). Convex never purges on its own: after 30 days the control Worker confirms the removal with GitHub ([Purging removed repositories](#purging-removed-repositories)) and only then calls `repoCommentAccess:purgeRepos`, which checks the window again against its own `removedAt` (`REMOVED_REPO_RETENTION_MS`; one not due yet is named in the answer), records `purgeConfirmedAt` and an audit event, and deletes in batches of 20 threads and 100 replies. A batch job runs only for a confirmed purge. If GitHub still grants the repository (a replayed removal, a reinstall), `repoCommentAccess:restoreRepos` clears `removedAt` and any confirmation, with an audit event, and a running purge stops at its next batch. A grant recorded more than a minute after the removal (`REMOVAL_SETTLE_MS`; anything sooner may have been decided before it) also means the repository is back. A suspended installation hides comments through access alone and purges nothing.

### Commentor integration

The frame adds `<script defer src="/commentor.js?v=…" data-commentor-config="…">`. Its policy allows exactly that script and the widget's one shadow-root stylesheet by hash (`COMMENTOR_STYLE_HASH`, checked against `src/commentor/styles.ts` by a test), never `'unsafe-inline'`, and still has no `connect-src`: the widget cannot open a connection, so the shell's client is the only one. The parent host derives the scope from the frame's URL (`parseRepoPath`, the shell's own repository at any ref) and the shell's repository ID, ignoring anything the frame claims. Click-to-comment anchors to the clicked element's text; an element without text asks for a selection. Sign-out in another tab ends comments like everywhere else; a reader who was never signed in stays an anonymous reader.

Tests: `tests/repo-comments-convex.test.ts` (access, revocation, removal and purge, forged anchors, cross-repository IDs, oversized text, rate limits, the first-page snapshot), `tests/repo-comments-routes.test.ts` (the access route, its first page and frame policy), `tests/repo-comments-latency-browser.test.ts` (snapshot then live, a denied reader, the measurements above), `tests/repo-access-comments.test.ts` (the outbox), `tests/repo-access-purge.test.ts` (the purge ledger with the directory and Convex together: a replayed removal never purges, a real one purges after the window, an outage postpones, a reinstall restores), `tests/repo-access-removal.test.ts` (`confirmRemoval`), `tests/repo-anchor.test.ts`, `tests/repo-comments-host.test.ts`, `tests/repo-comments-browser.test.ts` (the real frame and widget in Chromium) `e2e/repo-comments.spec.ts` (create, reply and resolve; an unrelated commit; an orphan; a revoked reader; an anonymous reader; the author's actions in the first comments, before the live page), `e2e/repo-comment-journeys.spec.ts` (delete with Undo; the Active, Resolved and History views; older threads and replies, and arrivals while scrolled away), `e2e/repo-comment-recovery.spec.ts` (a draft across sign-out in another tab, a revoked session and another account) and `e2e/repo-comment-permissions.spec.ts` (an outsider on a private repository, anonymous and non-author readers, and the rate limit with the optimistic "Sending…" rollback).

### First comments and the reader's own writes (#284)

Convex runs in one region, so a distant reader pays a round trip for every query, and a cold socket adds its handshake and authentication before the first one. Two changes keep comments from waiting on that.

**First comments come with the first access answer.** The shell asks for comment access at once, when its script runs, in parallel with the frame and its own session check (comment access is cookie-authorized, so it needs neither). The first request names the page the shell opens with (`RENDRO_REPO_COMMENT_CONFIG.documentPath`, or after a back/forward-cache restore the page the frame shows): `POST …/comment-access?path=<repository path>`. The Worker authorizes it exactly as before (`authorizeRepo`; a denial is the plain 404 and reads nothing), then records the grant and reads the page's first thread page in parallel: `repoComments:threadSnapshot`, an internal-secret query that returns the page `listThreads` would give the same reader. Access is decided by `userId`, whom the grant names: the reader for a private repository, null (anyone) for a public one. A public page is the same for everyone except which threads and replies the reader may delete (`canDelete`), so the Worker names its signed-in reader, from the session as the read path checks it, as `viewerId` (#303), and the page is read for them: an author sees their Archive and Delete from the first paint instead of once the live page arrives. A reader the session does not name (anonymous, an unknown session, or the session check unavailable) gets the anonymous page. `viewerId` never accompanies a non-null `userId`: a private page is always its grant's reader's. It refuses what `repoCommentAccess:grant` refuses, a removed repository and a decision older than a revocation Convex holds, because it runs before any grant for this reader may exist; a public page read for a reader is decided as the public grant is, so a revocation of that reader elsewhere does not hide it. The page goes back only if the grant was recorded, in the same `private, no-store` JSON answer; a page Convex could not read is left out, and live delivers it. Only the shell's same-origin POST reaches it; the opaque frame still talks to nobody but its shell.

The host holds its live thread subscription until that first answer: before it, Convex has no grant for the reader and would answer with an empty page. A widget subscribing in the meantime is answered at once; when the answer arrives the host shows its page (when it is for the page in the frame) and starts the live subscription, whose first real page replaces it, adding, removing and editing threads as it says. A snapshot of another page is dropped, and one superseded by live data is never shown again. Writes may target the snapshot's threads at once; Convex decides them as always. A fast in-shell switch never surfaces the page being left: the shell decides a request's page from the frame's URL, which already names the next page while the old one is still loaded, so a read (`subscribe`, older threads or replies) from the old page gets no answer at all instead of "Comment scope is unavailable"; a write from it is still refused, keeping its draft. A held subscription of the old page is cancelled when the next page loads, and the first answer's snapshot of it is dropped by page.

**The reader's own thread or reply shows at once.** Posting closes the composer and lays the new thread over the live page, marked "Sending…" (`aria-busy`, a dashed outline, no actions until it has an ID); a reply shows in its thread the same way, with the reply input locked and empty. The write keeps its `clientOperationId`, and the optimistic copy is matched to the live echo by it, so the echo replaces it without a duplicate. Convex updates subscriptions before it acknowledges a write, so the echo normally arrives first; an acknowledgement that wins anyway leaves the copy shown, no longer "Sending…", until the next live page. A failure takes the copy back: a reply's text returns to its input, and a thread's composer reopens with the draft, with the existing error, quota countdown or unknown-outcome notice, and Post retries the same operation when the outcome is unknown. A second composer still waits for the first post's outcome, and a double submit sends once. A reader change or an incompatible parent drops every optimistic copy.

Measured in Chromium with the real host, transport and widget, Convex modelled at a 200 ms round trip from the reader and the Worker 30 ms away (`tests/repo-comments-latency-browser.test.ts`, medians of three runs on a loaded shared host, 2026-10-20):

| | Before | After |
|---|---|---|
| Comments visible after the frame loads | 423 ms | 45 ms |
| Comments visible after the shell boots | 691 ms | 365 ms |
| The reader's own comment visible after Post | 223 ms (the echo) | 7 ms |

### Editing one's own comments (#287)

An author can edit their own thread or reply: `repoComments:editThread` and `repoComments:editReply`. Each is decided like every other write, first by `requireRepoCommentWriter` (no grant, a revoked reader, a removed repository or an expired grant: "not found"; anonymous: "unauthenticated"), then by the target (a thread of this page, a reply of that thread, neither deleted: else "not found"), then by authorship (anyone else: "forbidden", as for archive and delete). The body is validated exactly as a create's (trimmed, 1–10,000 characters). Status does not matter: an author may correct a resolved or archived thread, as anyone may still reply to one and resolve it. An edit stores the text, `editedAt`, and the edit's `clientOperationId` as `editOperationId`; a thread's `updatedAt` moves with it. A retry of the operation that made the last edit, and an edit that changes nothing, write nothing and spend no quota; any other edit spends one `comments` write (30 a minute per user, 300 per repository, shared with creates and replies). A retry is recognised only as the last edit: the widget never sends a second edit of one comment while the first's outcome is unknown (the durable operation keeps it pending, and changed text is refused until the first is resubmitted unchanged), so an older edit cannot come back over a newer one.

Every page (`listThreads`, `listReplies` and the Worker's first page, `threadSnapshot`) carries `editedAt`, `editOperationId` and `canEdit`, computed for its reader or named viewer exactly as `canDelete` is. Like `canDelete`, `canEdit` is a presentation hint; the mutation decides.

In the widget, the author's Edit (thread head, or beside their reply) turns the text into the reply box's input in place, in the drawer card or the open bubble, with focus in it and the caret at the end, and "Editing your comment." in the widget's polite live region. Enter or Ctrl/Cmd+Enter saves, Shift+Enter adds a line, Escape (or Cancel) ends the edit without closing the bubble; focus returns to the comment's Edit either way. The unsaved text is a draft in the parent's recovery state under `edit:<thread>` or `edit:<thread>:<reply>` (the host accepts it only for a thread on the page), so it survives live updates (focus and caret are restored when the list is rebuilt) and a reload, and Cancel discards it. Saving is optimistic, like a new comment (#284): the editor closes, the new text shows at once marked "Saving…" (`aria-busy`, dashed outline), and Edit stays focusable but `aria-disabled`. The live row whose `editOperationId` is the edit's replaces it; an acknowledgement that comes first keeps the text shown until the next live page. A failure takes the text back and reopens the editor with what the reader wrote, with the error toast, the shared quota countdown or the unknown-outcome notice; Save then retries the same operation. A double submit sends once. Unchanged text closes the editor without a write. An edited comment shows "edited" (`role="note"`, named "Edited <date, time>" in the reader's locale, the same as its tooltip). Other readers' open pages get the new text and the marker from their live subscription. The parent announces `edits: true` in its ready message; a shell loaded before edits does not, and the widget then offers none rather than send requests it would ignore.

Tests: `tests/repo-comments-convex.test.ts` ("editing repository comments (#287)": authorship, status, validation, retries and quota, revocation, expiry and removal), `tests/convex-public-errors.test.ts` (error kinds and IDs), `tests/commentor-parent-recovery.test.ts` (a retried edit across a replaced host or reloaded frame writes once), `tests/repo-comments-host.test.ts` (drafts, the flag, the mapping), `tests/commentor-edit-browser.test.ts` (the widget) and `e2e/repo-comment-journeys.spec.ts` (an author edits; another reader's page follows; a non-author has no Edit and a forged edit is refused).

---

## Key Technical Decisions

| Decision | Reason |
|---|---|
| Access follows GitHub; Rendro keeps no tenancy of its own | Who may read a repository's docs and comments is exactly who may read the repository, so there is no second permission model to keep in sync (#286) |
| Convex for identity and comments, R2 for rendered bytes | Indexed relationships and authorization remain separate from cheap blob storage |
| Server HTML and vanilla TypeScript bundles | Small, versioned bundles and nonced inline controllers, with no client framework |
| iframe document rendering | Rendered repository HTML stays isolated from the application chrome, in an opaque sandbox |
| Repo docs rendered and sanitized once at ingest | comrak (cmark-gfm lineage) is linear on hostile Markdown; a parse5 allowlist with a fixed-point re-parse check is the XSS boundary, and readers never pay render cost |
| Stateless repository capability cookie plus revocation epoch | A cached repository page view verifies one HMAC and reads one epoch; GitHub and the database are reached only on a cookie miss, and revocation reaches every colo with the epoch store |
| One Durable Object for the permission registry and mirrors; webhook payloads may only deny | Registry and mirrors change consistently and races with webhooks are detectable; a replayed body cannot grant, because permissive changes are confirmed with GitHub first |
| Comment access as Convex grants written by the read path, deleted by expiry jobs and P5's epochs | Convex cannot ask GitHub or read KV; grants make every comment read and write follow the page view's decision, keep queries free of clock reads, and end with page access |
| Repository comment anchors re-found in the frame, never re-anchored on the server | Heading slug plus quote with strict uniqueness rules cannot jump to other text, and an untrusted anchor stays data |
| Private repository content sealed per repository (HKDF from one secret, AES-256-GCM, storage key in the additional data), opened only after authorization | A leaked bucket or cache entry reveals nothing, a blob moved between repositories or objects does not open, and no per-repository key needs storing; the key ID in each envelope lets a key rotate without downtime |
| Repository content lifecycle owned by the per-repository ingest coordinator | Wipes (purge, idle expiry, reseal) run in the same serialized chain as ingests, so nothing is written into a half-deleted prefix; its alarm resumes them and expires idle content from a once-a-day last access |

## Known Limitations

1. Sign-in is email and password only until GitHub sign-in (P1); the signed-in home cannot list a reader's repositories yet.
2. The read path's bindings are not in `wrangler.toml` yet, and the ingest and control Workers exist for development and tests only, until the GitHub App exists ([SETUP.md](SETUP.md#github-repository-reads-not-configured-yet)). Until the owner wires them, every `/r/` URL is a 404.
3. The first Convex HTTP action after a cold start can add latency.
