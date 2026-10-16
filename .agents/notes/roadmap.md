# Production-readiness roadmap (October 2026)

_Started 2026-10-15 from `main` at `6e22d7f`. Update the status column as work lands._

Four read-only audits produced this plan: security, performance, technology
modernization, and test coverage with a UI-transition inventory. The full
reports were scratch artifacts outside the repo. Security detail stays out of
this public file.

## Ordering principle

1. Close security findings first, because production is live.
2. Build the regression safety net next: a 100% coverage gate plus E2E tests of every UI transition.
3. Only then migrate technology, in small strangler-pattern steps behind that net.

## Security (audit 2026-10-15: 1 critical, 5 high, 8 medium, 2 low confirmed)

| Issue | Area | Severity | Status |
|---|---|---|---|
| #79 | Isolation policy for every publisher-served file | critical | merged (#125) |
| #80 | Origin checks on cookie-authenticated writes | high | merged (#127) |
| #81 | Public resolver DTOs and provenance sanitization | high | merged (#123) |
| #82 | Share scope limited to the shared document's assets | high | PR #141, round 4 |
| #83 | Organization deletion revokes keys, publications and shares | high | merged (#124) |
| #84 | Retire legacy self-service and domain-derived auth; fail closed | high | merged (#136) |
| #85 | Convex-authoritative commit and publication validation | medium | merged (#130) |
| #86 | Admission budgets and body limits | medium | PR #142, round 2 |
| #87 | Retention pagination, staging expiry, pin/purge race | medium | merged (#129) |
| #88 | no-store on sensitive responses; log redaction | low | open |
| #128 | Flaky viewer-fragments test | test | in progress |
| #132 | CLI charset + sensitive-file skipping | bug | merged (#137) |
| #133 | Invite dialog busy state + dialog audit | bug | merged (#135) |
| #145 | Unchecked remember-me gets 7-day session | security bug | open (found by #111 E2E) |
| #146 | Sign-up success leaves Google controls | bug | open (found by #111 E2E) |
| #89 | Hardening: `__Host-` cookies, pinned Actions, strict CSP, CLI safeguards | hardening | open |

Controls that held up in the audit: viewer tickets (JWE, audience-bound, 15-minute
expiry), postMessage source/origin checks, path decoding, API key/share token
hashing, modern comment authorization, and zero `pnpm audit` advisories.

## Performance (audit 2026-10-15: 23 findings)

Baseline measurements (local, not production):
- Worker bundle: 2,411 KiB raw / 442 KiB gzip. Roughly 661 KiB is AWS SDK/crypto, 615 KiB Zod, 278 KiB parse5.
- Browser bundles: commentor.js 303 KB raw (unminified), management-pages.js 230 KB, commentor-parent.js 95 KB.
  An empty project-list SSR page is about 193 KB, of which about 140 KB is inline script.
- Management API calls: 15 across eight pages on initial SSR load, 23 on first cold client navigation.

| Issue | Area | Status |
|---|---|---|
| #90 | Path/directory index instead of whole-manifest reads per request; paged tree | open |
| #91 | Read-only API-key authorization; debounced lastUsedAt | open |
| #92 | Cursor pagination for management lists; pin by deployment ID | open |
| #93 | Cache immutable public publication bytes behind live resolution | open |
| #94 | Range, ETag/304, streaming public HTML | open |
| #95 | Static assets before session middleware; hashed immutable URLs | open |
| #96 | Hidden-tab viewer renewal pause; comment pin layout batching | open |
| #97 | Isolated custom rate-limit buckets; limiter hotspots | open |
| #98 | CLI streaming, work queue, retries | open |
| #86, #87 | Upload limits and retention (shared with security) | open |

Held until the modernization plan lands, because they depend on the UI/build
choice: native R2 binding (drops the S3 SDK and DOMParser polyfill),
build-time CSS instead of the runtime Tailwind CDN, minification and hashed
shared runtime, self-hosted fonts.

## Modernization (decided 2026-10-15)

Decision: evolve the current stack rather than rewrite it. The audit compared
React Router v7, TanStack Start, a Vite React SPA, Solid, `hono/jsx/dom` and
Preact against this codebase's constraints:
- route-class CSP nonces
- opaque publisher iframes
- request-authenticated SSR shells with 401/404/503 distinctions
- the bespoke navigation contract (blockers, abort ownership, version fallback)
- Query Core cache gating behind fresh authorization

A full framework would replace all of that at once. The incremental path keeps it.

Target:
- **Edge:** Hono on Workers. Public capabilities and static assets are dispatched before session middleware.
- **Trusted rendering:** Hono JSX SSR, with typed external modules instead of template-literal scripts and an explicit page registry instead of regex extraction (`scripts/management-pages-source.ts`).
- **Client components:** Preact islands, only for complex management page roots and only after a measured pilot. One root, one renderer, one disposal owner.
- **Viewer, tree, comment anchoring:** stay typed DOM modules.
- **Styling:** CSS custom-property design tokens plus CSS Modules. Compiled viewer CSS replaces the runtime Tailwind CDN.
- **Server state:** Query Core stays the only management cache. Comments keep the parent-owned Convex realtime connection. No blanket switch to browser→Convex for management, because the Worker hop carries limiter, commit-proof and error contracts.
- **Storage:** a `Storage` interface with native R2 bindings. The S3 copy adapter stays until native copy matches delta-push throughput and cost.
- **Tooling:** Vite with the Cloudflare plugin (workerd) for dev and build, with hashed asset manifests that keep old chunks reachable. Type-aware ESLint stays; one formatter is introduced without a mass reformat. Zod stays at HTTP/config boundaries.
- **Testing:** Vitest and convex-test remain. Playwright Test runs Chromium, Firefox and WebKit. A transition registry and per-file 100% coverage gates are added.

| Epic | Scope | Status |
|---|---|---|
| #99 | Regression safety net: 100% coverage and every UI transition under test | open (first) |
| #100 | Platform: CI provenance, telemetry, typed config, native R2, workerd, Vite | gated on #99 |
| #101 | UI: typed controllers, Hono JSX, tokens/CSS Modules, Preact islands | gated on #99 |

Gate: no runtime, build, storage or framework change from #100/#101 starts
before the #99 enforcement slice is green. Security fixes are exempt; they
ship as soon as they are reviewed.

## Test coverage and UI transitions (baseline 2026-10-15)

| Scope | Statements | Branches | Functions | Lines | Files < 100% |
|---|---:|---:|---:|---:|---:|
| Configured include (`src/**`) | 65.50% | 64.76% | 69.47% | 67.42% | 60/101 |
| Widened (src, convex, cli, shared, scripts) | 66.25% | 65.44% | 70.93% | 68.45% | 107/171 |

The suite is 2,188 tests passing, 12 skipped (`convex-public-rpc` needs `CONVEX_TEST_BACKEND`).
A full run takes about 6.5 minutes with 2 workers. `viewer-fragments-browser` alone takes about 290 s.

UI transitions: 152 families. 64 are untested, 62 have only unit evidence, 26 have browser evidence.

Why the numbers understate risk:
- Node V8 coverage cannot see code running in Chromium.
- Inline controllers are template strings, so executing the renderer covers the string but not its logic.
- Spawned CLI/server processes aren't collected.

That is why several 0% files are exercised by browser tests but still unmeasured.

Slices under #99, in order:
1. **Infrastructure:** #102 registry → #103 merger/debt ledger → #104 Chromium coverage; #105/#106 controller extraction; #107 subprocess coverage; #108 workerd Playwright harness → #109 local Convex/storage/mail.
2. **Journeys:** #110–#115.
3. **Per-file gap batches:** #116–#119.
4. **Visual/a11y:** #120.
5. **Enforcement:** #121. Done means 100% per file on all four metrics and zero untested transitions.

Note: Vitest's coverage `include` matching uses picomatch with `contains: true`, so
relative globs match more than expected (`src/**/*.ts` also picked up `cli/src`).
Use root-anchored patterns.

## Progress log

- **2026-10-16:**
  - Widened coverage reached about 76% statements, 76% branches, 79% functions and 76% lines (from 66/65/71/68 at baseline), measured on PR #144's head.
  - Merged on `main`: #102 registry, #103 coverage gate, #108 workerd harness and #109 local Convex E2E.
  - In progress: #104 Chromium coverage (determinism round) and #111 auth journeys.
