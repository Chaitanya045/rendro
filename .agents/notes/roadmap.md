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
| #82 | Share scope limited to the shared document's assets | high | merged (#141) |
| #83 | Organization deletion revokes keys, publications and shares | high | merged (#124) |
| #84 | Retire legacy self-service and domain-derived auth; fail closed | high | merged (#136) |
| #85 | Convex-authoritative commit and publication validation | medium | merged (#130) |
| #86 | Admission budgets and body limits | medium | merged (#142) |
| #87 | Retention pagination, staging expiry, pin/purge race | medium | merged (#129) |
| #88 | no-store on sensitive responses; log redaction | low | merged (#150) |
| #128 | Flaky viewer-fragments test | test | in progress |
| #132 | CLI charset + sensitive-file skipping | bug | merged (#137) |
| #133 | Invite dialog busy state + dialog audit | bug | merged (#135) |
| #145 | Unchecked remember-me gets 7-day session | security bug | merged (#152), on dev |
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

UI transitions: **0 untested** (enforced by #228); 915+ edges after the pivot phases P4–P7 (2026-10-19).

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
  - Also merged: #111 auth journeys (#144), #145 session lifetime (#152), #154 share/comment error UX (#155), #104 Chromium coverage (#143), #117 Convex coverage gaps (#156; all convex/ files at 100%), #91 read-only API-key auth (#158), #116 Worker coverage gaps (#163), #159 no clock in cached queries (#164), #110 shell/nav E2E (#160), #151 stability + per-engine E2E + nightly stability job (#166), #118 batch A coverage (#168), #165 self-hosted fonts (#171), #107+#119 subprocess coverage (#172), #90 deployment path index (#173), #112 org/people/teams E2E (#175), #170 load flakes (#178), #176 invitation-list privacy + slug validation (#180), #118 batch B commentor coverage (#174; coverage ledger now EMPTY), #177 org/team UX (#181), #161+#182 shell scroll restore + active team (#183), #179 select scroll-close bug (#184), #113 projects/deployments/keys/shares/publications E2E (#186), #185+#162 flakes + select reset (#188), #187 API input validation (#189), #89 part B Actions pinning + CLI safeguards + constant-time (#192), #114 viewer/tree E2E (#190), #115 comments E2E (#196), #95 static assets before session (#195), #191 viewer/tree bugs (#194), #198 management transition sweep (#204), #197 auth transition sweep (#203), #205 verify-email + onboarding commit (#207), #89 part A __Host- cookies + strict CSP + self-hosted viewer CSS (#201), #94 Range/ETag/streaming (#209). With browser coverage merged, the CI coverage job measures 88.3% statements, 86.8% branches, 90.9% functions and 89.4% lines (head `9b902a9`).
  - In progress: #185+#200 stability. Filed: #157, #161, #162, #169, #170, #176, #177.

## Pivot under discussion: GitHub-only (owner direction, 2026-10-18)
- Sign-in is GitHub only. Google and email/password sign-in go away. Orgs, projects, API keys and the CLI upload pipeline are expected to go too.
- Integration: a GitHub App with user authorization during install. That gives a single click with read-only access to chosen repos, short-lived tokens and push webhooks. A plain OAuth App would need the full `repo` scope.
- Repos hold **both** HTML and Markdown. Markdown is rendered once, when a push is processed, and sanitized.
- Docs location: **auto-detected**. Rendro finds the docs in the repo itself, with no per-repo configuration.
- Viewing: **anyone with read access to the repo** (GitHub is the permission source). Public repos are readable by anyone.
- No production launch yet (owner, 2026-10-18), so there are no accounts to migrate. Google/email auth is deleted outright.
- R2 stays as a **disposable cache**; GitHub is the source of truth. Storage security, required:
  - Use the native R2 binding instead of S3 access keys (`MINIO_*` in `src/minio.ts`; a leaked key reads the whole bucket), then revoke the keys.
  - Public bucket access off, with a deploy-time check.
  - Purge on uninstall or lost access, plus an idle-repo lifecycle (~30 days).
  - Recommended: per-repo envelope encryption (AES-GCM) for private-repo content.
- Performance design:
  - Never call GitHub on a page view.
  - Fetch one tarball per commit.
  - Key files by blob SHA in R2, which also gives free strong ETags and lets unchanged files be reused across commits.
  - A push webhook feeds a Cloudflare Queue that prepares the commit ahead of any reader.
  - A single fetch per repo when several readers arrive together.
  - The permission check is cached per user and repo with a short TTL, and webhooks invalidate it.
  - The branch head and repo list are cached and updated by webhooks.
- Hold epics #100/#101 and the email-verification work (UI-134-E03) until the pivot is scoped; much of that surface would be deleted.
