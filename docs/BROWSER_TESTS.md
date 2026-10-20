# Browser tests

There are two independent layers. The **Vitest browser project** below runs
focused Chromium tests against Node HTTP fixtures, including real Worker route
handlers where useful. **Playwright Test E2E** runs the actual `src/worker.ts` in
workerd with Chromium, Firefox, and WebKit. It exercises Worker bundling,
compatibility flags, HTTP, the ASSETS and R2 bindings, and browser CSP enforcement
together. Neither layer replaces the other.

## Playwright Test E2E (#108, #109)

```sh
# Prerequisites: Node 22+, pnpm, Docker, curl, unzip, OpenSSL, ps.
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
# Run one engine at a time on shared machines:
VITEST_MAX_WORKERS=2 pnpm e2e --project=chromium
VITEST_MAX_WORKERS=2 pnpm e2e --project=firefox
VITEST_MAX_WORKERS=2 pnpm e2e --project=webkit
# All three, still sequential (one Playwright worker):
VITEST_MAX_WORKERS=2 pnpm e2e
# Half of an engine, as CI runs it (i/2; each run starts its own harness and seed):
VITEST_MAX_WORKERS=2 pnpm e2e --project=webkit --shard=1/2
```

`e2e/playwright.config.ts` owns the projects and global setup. Setup rebuilds
browser assets every run so ignored bundles cannot silently be stale, then uses
Wrangler **4.149.0**'s `createTestHarness().listen()` to start the real Worker.
The harness uses the same local workerd development runtime as `wrangler dev`;
it does not import the Worker into Node or replace its route handlers. A temporary
copy of `wrangler.toml` relocates only the entry point and asset directory to
absolute paths, preserving the production compatibility date, `nodejs_compat`,
ASSETS binding and `run_worker_first`. `NODE_ENV` remains `production`. The copy
also binds the repository read path (#234), which production leaves unbound until
P5: a local R2 bucket, KV namespace and D1 database, and a second Worker, the real
control Worker (`wrangler.control.toml`) over a fake GitHub served in this process.
After seeding, setup ingests the fixture repositories (public, private, and the
viewer and comment ones) with the P3b pipeline from the fake GitHub straight into
that bucket (`e2e/repo-fixtures.ts`), and grants private ones to their readers.

We evaluated both APIs exposed by the locked Wrangler version.
[`createTestHarness`](https://developers.cloudflare.com/workers/wrangler/api/)
already supplies a reachable ephemeral loopback URL, disables watching and
persistent state, and owns runtime teardown. `unstable_startWorker` exposes
more development-server internals; spawning `wrangler dev` would require
additional subprocess, port and readiness management. The test-specific API
therefore fits this slice. Its outbound transport delegates to
`globalThis.fetch` in this locked version; setup guards that transport to permit
only the fixture and Worker origins, forwards redirects without following them, and fails teardown on
unexpected destinations. Recheck this behavior when upgrading Wrangler.

All application listeners bind to loopback on allocated ports. The Convex backend
is pinned to `precompiled-2026-10-06-a3538c6`, and the CLI/SDK is locked at 1.42.0.
The installer verifies the platform ZIP's pinned SHA-256 on downloads and every
cache hit under `~/.cache/rendro-e2e/`. Unique staging paths and atomic rename
prevent partial publication. Each run extracts verified bytes into its own
private directory; shared cached executables are never executed. First use needs GitHub release access; cached runs do not
need a deployed Convex account. A backend download/start failure fails the run.

Cleanup is registered before acquiring resources, with an incremental journal
under the system temp directory's `rendro-e2e-runs/`. Playwright global teardown,
process exit and SIGINT/SIGTERM handlers remove tracked children, containers and
the run directory even if setup never returns. The next invocation sweeps dead
owners, checking PID start times to avoid killing reused PIDs or concurrent runs.
Cleanup errors preserve the journal for recovery. SIGKILL cannot run an exit
handler, so its recovery takes place on that next invocation.

`tests/e2e-verified-cache.test.ts` covers corrupt/partial entries and concurrent
publication without network access. `tests/e2e-setup-interruption.test.ts` runs a
real Playwright child with a stalled setup, a real child process and a simulated
Docker executable; it verifies timeout, signals and subsequent crash recovery
without adding a Docker dependency to the unit suite.

The harness generates an instance name, secret and admin key and starts its own
temporary SQLite database and blob directory. It copies application sources and
the existing generated modules into a temporary directory, without dotenv files,
then runs `convex dev --once --url http://127.0.0.1:<port> --admin-key <generated>`.
A loopback assertion runs before the push. Inherited `CONVEX_*` deployment
selectors/keys and external proxy settings are removed. The push directory must
have no `.env.local`; CLI writes and generated files stay in that disposable copy.
The real schema, HTTP actions, Better Auth/rate-limiter components, authorization,
and WebSocket subscriptions execute unchanged. Never supply a shared deployment
or copy `.env.local` into this workflow.

Storage is Miniflare's local R2, KV and D1 (an empty set per run), so no storage container, port, endpoint or
credential exists. Specs make the Worker's Convex requests fail through `e2e/faults.ts`: the Worker's outbound
transport asks the fault service whether a rule matches the request, and a matching rule answers like a real outage,
for one spec's own data only. Production code has no test hook.

Convex's outbound proxy terminates mail requests locally, with a fresh CA and
server certificate trusted only by the child backend process. The Resend wire
endpoint captures verification and reset messages in memory. No email reaches an
external provider. Only the exact local Worker/Convex origins can pass through
the backend proxy; other destinations fail teardown.

Seed helpers use real signup, verification and sign-in APIs to provision four
verified users (`owner`, `admin`, `member`, `outsider`: labels only, since
repository access is granted per test).
Their generated sessions live only in a mode-0600 temporary fixture file. Each
browser context gets its own cookies; test artifacts contain disposable fixture
identities only. Distinct synthetic ingress IPs keep engine auth rate-limit windows
independent while leaving the application's limits enabled.

The Worker outbound guard allows only the exact local services. Redirect responses
are returned to the browser without following them. The browser guard permits
Worker and local Convex HTTP/WebSocket traffic. Fonts and the viewer base stylesheet
are self-hosted, so no CDN is stubbed. Any other destination fails. Teardown closes workerd, Convex, the proxy,
mail sink and removes temporary data, including on setup/test failure.
An empty temporary `.dev.vars` and disabled dotenv loading isolate Worker secrets.

Trusted pages send `Cross-Origin-Opener-Policy: same-origin` (#89). In Firefox, Playwright drops emulated media
(`emulateMedia`, and the context's `colorScheme`) when a navigation enters a new browsing context group, as the
first navigation from `about:blank` to a trusted page does. A spec that needs a non-default preference on its first
load navigates to the origin first, then emulates, then makes the load it measures (see `shell-theme.spec.ts`).

The three engines run the nonce/CSP, opaque frame/SVG and 404 MIME smokes, and one
full UI signup → mail verification → home → repository document → comment journey.
The comment must arrive in a second open viewer via a real subscription and remain
after reload. These are
functional checks, not visual fidelity assertions or coverage of every epic #99 edge.

Local retries are zero. CI permits one diagnostic retry, prints each attempt,
and uses `failOnFlakyTests` so a passing retry cannot hide a first failure.
`E2E_RETRIES` overrides the count; the nightly stability workflow sets it to `0`.
[`retain-on-failure`](https://playwright.dev/docs/trace-viewer) records the
original failed attempt even without retries. In `quality.yml` each engine runs as
two shards, each its own `e2e (<engine> <i>/2)` job
(`pnpm e2e --project=<engine> --shard=<i>/2`), so wall time is roughly half of the
slowest engine (WebKit took 21–29 minutes unsharded, against a 30-minute job
timeout). A shard is independent: its runner starts its own workerd, Convex and
storage and seeds its own data, and no spec depends on another file's state
(there are no serial groups, so `fullyParallel: true` makes every test its own group and a shard boundary can fall inside a file; the single worker still runs them in file order). A final
`e2e` job depends on all six legs and fails unless every one succeeded, so a
failed, cancelled or skipped shard fails it and it stays the single required check
name. Each shard uploads its traces, failure screenshots and HTML report for seven
days as `workerd-e2e-failures-<engine>-<i>` when it fails. Shards also upload a
blob report; when any shard failed, the optional `e2e report (<engine>)` job merges
them into one HTML report per engine, `e2e-report-<engine>`. Nothing depends on
that job. Each shard ends with a duration guard: it adds the wall time to the job
summary and emits a `::warning::` annotation above 60% of the 30-minute timeout.
It warns instead of failing, because runner speed varies by tens of percent and a
hard failure would block unrelated pull requests while the job still has headroom;
reshard (raise the `/2`, the `shard` list and `PWTEST_SHARD_WEIGHTS` in
`quality.yml` and `stability.yml`) when the warning appears.

Playwright cuts the ordered test list into contiguous ranges, balanced by test
count. The first half (auth and repository comments) is multi-actor and
roughly twice as slow per test as the second (shell, viewer), so an even split gave
shard 1 about twice the wall time of shard 2 (WebKit 20.6 against 10.2 minutes).
`PWTEST_SHARD_WEIGHTS=47:63` (an internal Playwright variable, honoured by 1.64;
`tests/repository-quality-gates.test.ts` fails if an upgrade stops honouring it)
gives shard 1 about 43% of the tests (the second shard also spends about two minutes beyond the sum of its test times, so equal test time is not equal wall time). To retune after adding specs, compare the two
shards' wall times in the job summaries and move a few points of weight toward the
faster shard; the weights must have one entry per shard. Open a trace with
`pnpm exec playwright show-trace test-results/e2e/<test>/trace.zip`.

The local Convex backend's own log is never uploaded: it sits next to the run's
admin key. A failed shard instead uploads redacted timings (#328),
`test-results/e2e-timings/shard-<i>-of-2.jsonl`, in the same artifact, and its job log
prints the 10 slowest Worker calls to the backend (the "Slowest backend calls" step;
locally, `pnpm exec tsx scripts/e2e-timings.ts`). The file holds three kinds of line:
each call the Worker makes to the backend (path, `module:function` name, method, start, duration, status
or abort/timeout, injected faults marked), the backend's own access log (started with
`RUST_LOG=info`, which adds it), and about one sample per second of the backend's
queue gauges from its loopback `/metrics` endpoint (in-flight HTTP and site-proxy requests
against the site proxy's limit of 4, the codel and commit queues, scheduler backlog,
and cumulative function-queue, commit-queue and permit waits). A Worker call that is slow
while the backend's access log shows the same request as fast points at the client or
workerd. A slow request on both sides with empty queues points at the function itself or
host CPU. Full queues point at backend contention. Every line passes the allowlist
in `scripts/e2e-timings.ts`: fields are rebuilt from known keys, query strings are dropped, and a path segment
that is not a plain route word becomes `:param`. Of a request body only the
function call's `path` field is read, and it is kept only if it is a `module:function`
name. Nothing from a header, cookie or log message is copied, and `tests/e2e-timings.test.ts` checks this
with a fake admin key, cookie, email and token.
`pnpm verify` continues to run the existing Vitest layers independently.
`e2e/` is typechecked/linted test infrastructure, outside the production
coverage denominator. The loopback/environment guards have a separate 100% coverage
regression.

`tests/convex-public-rpc.test.ts` now always starts its own pinned backend: all 12
RPC envelope/cursor tests execute in `pnpm verify` and in an explicit mandatory
step of the E2E job. There is no opt-in skip or shared deployment credential.
CI caches the verified backend archive as well as pnpm dependencies.
The workflow jobs have no conditional opt-out or allowed failure. Repository
branch protection must require the existing `verify`, `coverage`, and `e2e` checks.

The journeys below extend this foundation. The transition registry's `e2e` status still requires edge-specific
assertions.

## Authentication journeys (#111)

`e2e/auth.spec.ts` extends the real-stack suite with signup and verification mail,
neutral duplicate/recovery responses, browser validation/focus/reveal, pending
submission exclusion, the production sign-in limiter, remember-me session/cookie
lifetimes, safe return destinations, password reset and change, initial-password
freshness for an account without a password (as the retired Google sign-in left
them), method-load retry, and sign-out across contexts, tabs and history. Tests
project session reads to non-secret identity and lifetime metadata, and check
backend record removal after revocation. The original signup mail is captured
before any later verification message and followed through explicit sign-in to
its query-bearing return destination. A separate account tests resend delivery
and neutral eligible/ineligible responses. Reset mismatch asserts zero reset
requests, with one request after correction. Sign-out checks that the retained
protected containers are hidden and their shell is inert in both tabs before
navigation; protected inputs cannot regain focus. The shared sign-out helper
waits for the security method list's `aria-busy=false` before clicking Sign out
in every journey. Method loading expands the card and moves that control; WebKit
can otherwise finish its actionability check just before the response arrives and
click the old position. Waiting for this explicit ready state also covers the
method-load failure UI, without sleeps or retries.

Each test/context has a deterministic synthetic ingress address. The limiter
case actually exhausts the configured five-attempt window; production limits
remain enabled. Transport-failure tests hold individual browser requests and
return a deliberate 503. Method-load cases then retry against the real backend.

A mode-0600 file in the run's private directory gives the test helper access to
that exact loopback backend's component adapter. It changes only disposable
records: session creation/expiry and reset-token expiry timestamps, and the one
account row the initial-password journey turns into a passwordless legacy account.
It is never copied into the worktree, exposed to browser JavaScript or supplied to
a shared backend. No production auth option or Convex source changes are needed
for these cases.

Real back/forward traversal checks that signed-out pages do not expose account
content. Since browser routing can prevent native BFCache eligibility, an
additional test explicitly dispatches a persisted `pageshow` event after backend
revocation; it checks the restoration handler, not native cache admission.

The #146 signup visibility regression passes in all engines: the credential form
disappears, focus moves to the confirmation, and returning through sign-in
restores the signup controls. `tests/auth-hidden-browser.test.ts` checks computed
display, keyboard focus, retry and restored forms at desktop/mobile sizes, plus
reset and security states. The inactive security password sections keep their space
(#312), so the test checks that they are invisible, unfocusable and absent from the
accessibility tree rather than `display: none`.

Expected failures, when present, name follow-up issues. Their broken assertions
receive no `e2e` registry credit; an unexpected pass fails the suite so the marker
must be removed when the product is fixed. None are currently open.

The #145 regression (AUTH-111-02) passes in all three engines. It asserts the
one-day backend lifetime after home, account and repository reads, reloads and
the expiry boundary, alongside the session-only browser cookie. The same reads
run with absent and altered client preference markers. Password rotation
regressions check both stored lifetime choices and replacement-cookie persistence
after removing the marker. A remembered-session control ages the disposable record
past its update age and verifies protected entry refreshes it to seven days. A
bearer-token check sends the session token as `Authorization`, alone and with the
cookie, directly to Convex and through the Worker. It asserts that bearer tokens
never authenticate, that no persistent session cookie is set, and that the stored
expiry is unchanged.

## Entry, home, theme and shared controls (#110)

These specs cover the pages around the documentation, in all three engines at 1440px and 375px. They use
`tests/ui-transitions.json` as the checklist: an edge is credited `e2e` only when a named test asserts its final state
(URL and history entries, focus location, ARIA state, visible content and request counts); the registry names those tests.

| Spec | Covers |
|---|---|
| `shell-entry.spec.ts` | The signed-in root redirecting to `/home`, an anonymous home redirecting to sign-in with its destination, the home itself (identity, the `/r/` explainer, Account security and back, sign-out in place), and the 404 pages (standalone and inside the viewer frame, Go back, plain asset errors, never cached) |
| `shell-theme.spec.ts` | Initial theme before first paint, cycle and persistence across the home, account and repository shells, OS/storage synchronization, rapid and failing transitions, reduced motion, unavailable storage |
| `auth-controls.spec.ts` | The shared field and button states on the sign-up form: hover, focus ring, required and invalid fields in the alert region, 36px icon and 44px field/button targets, long values contained |
| `fonts.spec.ts` | Self-hosted fonts and icons on public and signed-in pages and the repository shell, ligature glyphs, and no overflow with every font blocked (with a self-test that removes the icon safety and must find overflow) |
| `static-assets.spec.ts` | Every bundle a signed-in page and a private repository load is immutable for its version and bypasses the session stack; stale or unknown versions are uncached; unlisted paths 404 |
| `smoke.spec.ts`, `image-proxy.spec.ts`, `retired-cookies.spec.ts` | CSP nonce and opaque frame/SVG smokes, external images only through the proxy, and the retired `__Secure-` auth cookie names never signing anyone in while sign-out still expires them |

Tests that sign out or mutate use a verified disposable user (`provision` in `e2e/shell-helpers.ts`); the seeded users
are used read-only.

## Repository docs and the viewer (#114)

The repository specs run the real read path on the real Worker: the fixture repositories are ingested from the fake
GitHub by the production pipeline (`e2e/repo-fixtures.ts`), and access goes through the real control Worker. Final state
is asserted in the DOM, ARIA, focus, the URL, history length, `localStorage`, and the iframe's own location; the
document is opaque, so only Playwright can read where it is.

| Spec | Covers |
|---|---|
| `repo-docs.spec.ts` | Anonymous browsing of a public repository (entry page, sidebar titles, links, images); a granted reader on a private repository (capability cookie, ticketed images); in-shell search; a membership webhook revoking a team reader (the next view is a plain 404) |
| `viewer-links.spec.ts` | Fragments within and across documents (named anchors, bare and unmatched hashes, replace vs push, reload), and the parent-owned link confirmation: a reader's click opens at once; a link followed with no reader action is offered (confirm, dismiss, review) |
| `viewer-chrome.spec.ts` | Theme (cycle, persistence, what the document is told), reading mode (control, shortcut, hot zones, Escape, persistence), sidebar resize (keyboard, drag, limits), the mobile tree drawer and More menu (closed by a tap in the document) at 320/375/430px, document loading (slow, never arriving, replaced, reduced motion), copy-link feedback and its refusal |
| `viewer-comment-links.spec.ts` | A same-document link keeps the document, its scroll and the comment being written; a waiting or dismissed link confirmation leaves theme, tree and comment actions working |
| `viewer-styles.spec.ts` | A private and a public repository render without a CSS runtime under a strict CSP: every stylesheet is a hashed, immutable same-origin file |

Timing-sensitive steps never sleep. The loading cases install Playwright's fake clock and pause it where the page is
idle, hold the document request at the browser boundary, and advance time by exact amounts across the 15-second
deadline and the 520 ms minimum row feedback. The link-confirmation specs use `trackActivation()`: it waits until the
shell's user activation has lapsed and then posts to the content frame from inside the shell, so the request carries
no reader authorization. `viewer-chrome.spec.ts` and `viewer-links.spec.ts` fail any test that records a CSP
violation (#89).

## Comments and recovery (#115, #302)

The comment specs run on the real Worker, local Convex and the sandboxed document frame in all three engines. Each
person is an `actor` context (`e2e/actor-fixtures.ts`: its own cookies and ingress address, provisioned through real
signup and verification) or a seeded reader. `e2e/comment-helpers.ts` re-reads server state with a person's *own*
Convex JWT (never an ambient cookie), so "the server holds it" is asserted with the same functions the widget
subscribes to, and a forged request is the same call the UI would have made.

| Spec | Covers |
|---|---|
| `repo-comments.spec.ts` | Create, reply and resolve on a repository doc; an anchor that survives an unrelated commit and a nearby edit; an orphan whose text was deleted; losing comment access with repository access; an anonymous reader of a public repository; the first comments with the author's actions before the live page |
| `repo-comment-journeys.spec.ts` | Delete with Undo inside its window; the Active, Resolved and History views; older threads and replies on demand, and a comment arriving while scrolled away |
| `repo-comment-permissions.spec.ts` | An outsider refused a private repository's comments, anonymous readers of a public one; a writer over the comment limit (the post shows as sending, then returns with its draft) |
| `repo-comment-recovery.spec.ts` | A draft that survives signing out in another tab and returns after signing back in, never to another account; a revoked session noticed on focus |

Timing. The widget's undo window, quota countdown and toast exits run on the page clock, which the tests install and
pause once the widget is ready, advancing it explicitly (#174). The server's rate-limit bucket refills in **real** time
and the widget's request is the thing being refused, so the test holds the page's outgoing WebSocket messages while it
empties the bucket through the API and releases them when the next token is more than a second away. Nothing sleeps for
a fixed time; every wait is on a readiness signal (`aria-busy`, subscribed pins, a server read).

## Authentication, account, landing and sign-out transitions (#197)

These edges are asserted at the cheapest level that can see them.

| Test | Covers |
|---|---|
| `tests/landing-browser.test.ts` | The production landing page and inline controller with the production security headers, in Chromium: header/logo/footer links, the three sign-up calls to action, Product/Workflow/Security anchors (sticky-header clearance, no fragment or history entry, legacy fragments removed on load), the screenshot at every width, reveals, reduced motion, print and no-JavaScript rendering |
| `tests/auth-pages-browser.test.ts` | The production authentication pages in Chromium: a safe `returnTo` carried through every related link (unsafe targets dropped), OAuth callback failure copy per error code, email sign-in callbacks confined to this origin, the "Add below" reveal and scroll, duplicate reset exclusion, and a stable layout (#312): `/account/security` keeps its footer links where they were first painted whatever the method lookup returns, and `/home`, `/sign-in` and `/sign-up` insert nothing above their links after first paint (layout shifts are counted once the web fonts have settled) |
| `tests/sign-out-browser.test.ts` | GET sign-out confirmation without revocation, native POST, the complete page's working Sign in, a failed native sign-out (Try again, cookies kept), restored pages whose live identity changed or ended (drafts stay in the original account's storage), failed identity checks |
| `tests/session-outage-browser.test.ts` | The real session middleware: an upstream outage is a 503 page (cookie kept, no redirect) that recovers through Try again; a missing session redirects to sign-in |
| `e2e/auth-transitions.spec.ts` | An invalid verification link offers recovery; changing a password with "Sign out other sessions" off keeps the other browser signed in, and Back to home; a restored page for a different account; a sign-out whose cookie cleanup is lost |

Timing: no fixed sleeps. Smooth scrolling is awaited by polling where the section landed (or the page bottom when the
page is too short to reach it); CSS transitions are polled to their final value; negative assertions after a failed
identity check synchronize on the request finishing and two animation frames.

## Visual baselines and accessibility scans (#120)

`e2e/visual.config.ts` owns two independent checks over the same seeded states (`e2e/visual/render-states.ts`):

| Check | Command | Engines | What it asserts |
|---|---|---|---|
| Visual baselines | `pnpm visual` | Chromium, in the pinned container | `toHaveScreenshot` with zero tolerated pixels at a zero colour threshold, per state, at 375/768/1440px, light and dark |
| Accessibility | `pnpm a11y` | Chromium, Firefox, WebKit | axe (WCAG 2.1 A/AA) finds no violation in the interactive states |

Both run the real Worker and local Convex backend of the functional E2E layer, with a separate global provisioning
(`e2e/visual/seed-visual.ts`, only when `RENDRO_E2E_VISUAL=1`) so the functional shards never pay for it. The functional
`e2e/playwright.config.ts` ignores `e2e/visual/`.

**One pinned environment.** A screenshot depends on the Chromium build, system libraries and fonts that rasterise it, so
no baseline is ever produced by a host browser. `scripts/visual-baselines.sh` starts the official Playwright image, pinned
by digest at the repo's Playwright version (`mcr.microsoft.com/playwright@sha256:06a9939e…`, v1.64.0-noble, linux/amd64),
as a browser server (`launchServer`) with the host network; the Worker, backend and test client keep running on the host and
connect to that browser (`RENDRO_VISUAL_WS`). The browser's flags are set by the script, never by a client: Playwright's
defaults plus `--disable-partial-raster` (see Determinism). The same script runs in CI. The spec and the script refuse a run
whose Playwright version does not match the image, and the spec throws without the container's endpoint. Bump
`@playwright/test` and the digest together (`docker buildx imagetools inspect mcr.microsoft.com/playwright:v<version>-noble`).
Docker is required (the E2E harness already needs it).

**Determinism.** Each cell emulates the theme and reduced motion, fixes the page clock (`page.clock.setFixedTime`) to five
minutes past the seeded comments so every relative age is identical, and settles through `settleVisual` before the shot:
`document.fonts.ready`, every finite animation awaited through `getAnimations()` (#262), two painted frames, then the
remaining (looping) animations paused. Data is seeded with fixed text, so no cell needs a mask or a rewritten string; a run-specific value in a new state must
be seeded as fixed text too.
A cell waits for the state it shows, not for time:
- the shell's document-loading shimmer (held for a minimum time after a document arrives) has cleared;
- a link inside the page is only clicked once the shell has selected the page's row (a click during the first reveal
  supersedes it);
- the held document load only starts after the previous document's comment subscription has answered (the shell
  refuses a subscribe that arrives after the switch, with a toast);
- the deletion state closes and reopens the drawer, so it is measured without the deleted thread (the open drawer keeps
  its old height until a later thread snapshot, which may or may not arrive before the shot).
- the comment widget's toast region is put on its own layer before the shot. Chromium otherwise draws it into the page
  first and moves it onto a layer some seconds later, and the two paths blend the pill's antialiased outline one level
  apart, so a fast run and a slow run shot different pixels.

Chromium's partial raster is off: re-rasterising only an invalidated part of a tile rounded antialiased edges and
translucent fills one level apart from a full raster, depending on paint timing. Before baselines are committed the
whole suite is rendered three times in the pinned container (`pnpm visual:repeat`), and every cell must match across
the runs at the configured threshold (#276).

**Comparison threshold (#276).** `toHaveScreenshot` compares with pixelmatch, which first ignores every pixel whose YIQ
colour distance is below `threshold` and only then counts the rest against `maxDiffPixels` (it also skips pixels it
classifies as antialiasing). Playwright's default `threshold: 0.2` absorbed a whole muted-text token change: `#71717a` →
`#52525b` is a distance of 0.117 even on a fully covered glyph pixel, so #274 changed the comment widget's muted
foreground without failing a single cell, and the dock handle of every light `/r/` cell kept the old colour in its
baseline until #276. `e2e/visual.config.ts` now sets `threshold: 0` with `maxDiffPixels: 0`: any colour change fails.
That is only sound because the renders are bit-identical. Measured in the pinned container before the fixes above,
72 of the 256 images (35 of the 130 landing, sign-in and `/r/` ones) differed between two runs (state races up to 0.76,
partial-raster noise up to 0.04); after them, the whole suite matched across three runs at threshold 0 (the 130 surviving
images bit-identical, the rest identical apart from pixels pixelmatch classifies as antialiasing). `pnpm visual:repeat` repeats that measurement: it
renders every cell into a scratch directory, then compares two more runs against it at the configured threshold.
Never raise the threshold to absorb a flaky cell; run `pnpm visual:repeat`, find the nondeterminism (a state the cell
does not wait for, an animation, a caret, a clock-dependent string, a raster path) and remove it.
`e2e/visual/threshold-self-test.spec.ts` keeps the threshold honest: it renders the light 1440px landing with
`--text-muted` set one step lighter (`#52525b` → `#71717a`, #274 in reverse) and asserts that the shot passes against
the committed baseline at the old 0.2 but fails at the configured threshold. It is skipped in update mode, where a
failed comparison would rewrite the baseline.

**Baseline families.** First slice (#120): landing, sign-in, sign-up, viewer (tree, document loading, menu), comments
drawer, and `/r/` (home, search, not found) at 375/768/1440px, and the signed-in home at 375/1440 (#286; the organization,
project, team, API-key and account-menu cells left with those pages). Second slice (#268), chosen from the
surfaces that survive the GitHub-only pivot (#214):

| Family | States added |
|---|---|
| landing | scrolled to the Workflow, Product and Security sections; every cell also asserts the reduced-motion render holds nothing back for a reveal (`html.motion-ready` absent, no hidden `[data-reveal]`) |
| repo (viewer shell and `/r/`) | private repository (signed-in collaborator), nested Markdown with highlighted code and a table, a long page title, a large document opened at a deep link, an expanded three-level tree, a document-not-found error inside the shell, the external-link confirmation dialog, access denied (signed-in outsider), the retryable 503 when the reader cannot be checked, the "Preparing these docs…" first view (#249) and its retry page |
| repo search | no results, server error, rate limited (the shell renders any failed search as one message with Retry) |
| comments | resolved tab, reply composer with a draft, the deletion toast with Undo, a send that stays pending while offline, and a write the server refuses |

The shell states are also baselined at 320px (the narrowest supported layout), and the card pages (denied, unavailable,
preparing, retry, rate limited) at 375 and 1440 only: their centred card is the same at 768. Below the desktop breakpoint
the cell opens the tree drawer first (the `/r/` search panel and the viewer's document tree live in it).

Third slice (#319): the account and auth pages.

| Family | States added |
|---|---|
| sign-in | field validation (an invalid address), bad credentials, rate limited, and each fixed message of the OAuth `?error=` codes (canceled, expired state, account not linked, unknown) |
| sign-up | field validation (a password under 15 characters), rate limited |
| forgot-password | the form, the acknowledgement after a request, a server error |
| reset-password | the form opened with a token, the invalid or expired link |
| verify-email | verified, the invalid or expired link with its resend form |
| security (`/account/security`) | methods loading, password configured, no password (an account from the retired Google sign-in), lookup failure with Try again, a refused password change, and mismatched passwords in the add-password form |
| not-found | the generic 404 outside `/r/` |

The forms are baselined at 320/375/768/1440 (the auth card changes at the 520px phone padding and the 820px single
column), the rest at 375/1440. Every form is submitted from its last field with Enter, so no pointer rests on a button in
the shot. The text a cell types is fixed (`reader@example.test` and fixed passwords), and every request that would reach
an auth limiter or change an account is answered at the browser boundary with Better Auth's own public response
(`Invalid email or password`, `Too many requests. Please try again later.`, `Invalid password`). The no-password account
is the method lookup answered with a Google account; the loading state holds the lookup until the cell closes. Account
security renders the visual owner's own fixed address. The cells live in `e2e/visual/cells.ts`, which
`tests/ui-transitions.test.ts` also reads, so `tests/ui-transitions.json` cites each baseline and axe cell by its title.

Data for the second slice is deterministic as well: the public repository `e2e-org/visual-docs`
(`e2e/visual/visual-repo-docs.ts`) is ingested by the global setup only when `RENDRO_E2E_VISUAL=1`, and the comment states
use threads seeded on two reference pages (`docs/reference/errors.md` and `docs/reference/config.md`), created inside the
seeding's 25 second window so every age rounds to the same "5m". Two states cannot come from the e2e Worker alone and are produced at a boundary the product owns:
the "Preparing…" page is the product's own renderer (`renderPreparingPage`) fulfilled at the browser, because the e2e Worker
has no ingest coordinator (the Worker route and its polling are covered by `tests/repo-read-first-view-workerd.test.ts`), and
the comment states go through a routed Convex socket that never forwards a write: an offline send is simply not sent, and a
refused write is answered locally with the server's public `forbidden` error, so no cell changes seeded data. The deletion
state also stretches the widget's long timers (the five second undo window and toast lifetime) so it cannot lapse between
settling and the shot, and its close clicks Undo.

### Updating a baseline

```sh
pnpm visual:update            # rewrites only baselines that changed (or are new), in the pinned container
pnpm visual:update -g "home — default"   # extra arguments go to `playwright test`
```

1. Make the intended UI change first. `pnpm visual` (check mode) fails and writes expected, actual and diff images
   under `test-results/e2e-visual/`; open the diff before deciding anything.
2. Run `pnpm visual:update` only after you have confirmed that every difference is intended. A baseline is never
   regenerated to get a failing check green, and never from a host browser or a different image.
3. Commit the changed PNGs in the same pull request as the UI change, and list the affected states in its description.
4. Reviewers **inspect the images**: GitHub's image diff (2-up, swipe, onion skin) on every changed
   `e2e/visual/__screenshots__/*.png`. A baseline change that nobody looked at is not approved. There is no bot or
   workflow that accepts new baselines, and `--update-snapshots` appears nowhere in CI.
5. On a CI failure, the `visual-diffs` artifact (7 days) carries the expected, actual and diff image of every failing cell
   and the traces. Download it, decide whether it is a regression (fix the code) or an intended change (step 2).

An axe violation fails the run; there is no threshold to adjust. A known violation can only be listed in
`e2e/visual/axe-states.spec.ts` with a written reason and an open issue, scoped to one rule, one state and one element,
reviewed like any baseline change. An entry that no longer matches fails the run, so fixing the issue deletes the entry.
`known` is empty today: the contrast findings of #267 and the search-panel, task-list, highlight and
scroll-region findings of #270 are fixed. Every axe state is
scanned in light and in dark. Firefox's automation drops emulated media when the first navigation of a fresh page enters
a trusted page's browsing context group (COOP, #89), which once made every Firefox "dark" scan render light: `applyTheme`
enters the group first, and each scan asserts that the page really is in the appearance of its cell (`expectTheme`).

CI jobs: `visual (chromium baselines)` and `a11y (chromium|firefox|webkit)` in `quality.yml`, each with a 20 minute
timeout (the suites take a few minutes). Both upload their diffs and traces on failure.

### Not yet covered

The organization, project, team, API-key and account-menu pages left the product with #286, and their
baselines with them; the comment widget states are rendered on `/r/`. The comment *edit* state of the issue does not
exist: the widget has no edit action. The landing no-JS variant is not covered (the page's script is its only dynamic
part, and the reduced-motion assertion above covers what it holds back).

## Vitest Chromium project

Run `pnpm exec playwright install chromium`, then `CI=true pnpm test:browser`.
`pnpm test` and `pnpm verify` include both projects. Fragment-navigation checks
wait for exact target alignment across consecutive frames before another history
action, so a transient position during native restoration is not treated as readiness. On Linux, use
`CI=true taskset -c 0,1 pnpm test:browser` to reproduce a two-CPU budget (choose
CPUs from `taskset -pc $$` if your container has a different allowed set).

Activation-sensitive viewer checks send the unsolicited frame message and wait
for its confirmation notice inside one passive CDP evaluation (`userGesture: false`).
This prevents an intervening Playwright locator evaluation from granting a new
activation before the message reaches the shell.

Vitest discovers `tests/**/*-browser.test.ts` in the `browser` project and
excludes those files from `unit`. Unit files retain their normal parallelism.
The browser project has `sequence.groupOrder: 1` and `fileParallelism: false`:
it starts after the unit project finishes, and launches one browser file at a
time. See [Vitest's project ordering](https://vitest.dev/config/sequence#sequence-grouporder).
Browser tests have 30s budgets and hooks 60s; cold Chromium startup on a small
runner cannot reliably fit a unit test's budget (unit tests have 30s, see the
stability rules below). Operations normally fail
after 10s with a step label; Chromium launch has its own 45s deadline. These
are failure bounds, not sleeps or retries. Assertions are not retried at the
test level.

### Test stability rules (#151)

Intermittent failures under coverage or CPU contention were all timing
assumptions, not product defects. The suites now follow these rules:

- **Wait for an explicit ready signal, not a delay.** A URL assertion only proves
  a navigation committed, not that the document's inline scripts have run;
  e2e helpers wait for `load` plus the page's own ready state (`securityReady`).
  Component tests that start a controller track its in-flight requests and await
  them instead of sleeping a fixed interval, and drain them before closing the DOM
  window.
- **Do not depend on pointer delivery right after a navigation** when the click is
  incidental to the test: Firefox can drop it under load. Submit with the keyboard
  and wait for the visible confirmation (`requestPasswordReset`).
- **Collect network evidence by polling, not by one read (#277).** A list built from
  `page.on("response")` is complete only once each response arrived: the viewer's
  `defer` scripts are requested after the heading renders. Assert with
  `expect.poll(() => paths).toContain(path)` per bundle (`static-assets.spec.ts`).
- **Await the host's own first renewal before changing the fixture (#277).** The
  comment host renews its token on load (identity check, then token), and a renewal
  asked for while one is in flight joins it. A test that flips the identity must
  wait for that first `/api/auth/convex/token` response, or the join returns the
  token the earlier check was granted (`sign-out-browser.test.ts`). Making the
  window deterministic is a one-line route that fetches `get-session` and delays
  its delivery.
- **A browser's cookie list can include a cookie that was just expired (#277).**
  Firefox lists the entry a sign-out expired for a moment, so `sessionCookieExpiry`
  ignores cookies whose expiry has passed and is polled until the live one shows.
- **Keep-alive resets are transport, not behavior (#277).** The Worker is served by
  workerd, which closes an idle keep-alive socket after five seconds and has no
  setting for it (`workerd.capnp` has no HTTP timeout; a Node client reusing the
  socket at exactly 5000 ms idle reproduces `ECONNRESET` against
  `createTestHarness`). An `APIRequestContext` call that reuses it at that moment
  fails before any byte is sent, so a spec that issues such calls with long pauses
  between them sends `Connection: close` instead of retrying.
- **Measure CPU, not wall time, and reduce noise structurally.** A timing assertion
  reports process CPU time, takes the median of identical samples for a scaling
  comparison, and keeps an absolute ceiling on the slowest sample.
- **Race-free lifecycle checks.** The comment recovery lifecycle re-checks the
  session when focus/pageshow fire. A trigger arriving while a check is in flight is
  never absorbed: one more check runs after it, because the in-flight request may
  have read the server before a revocation.
- **Budgets bound hangs, never behavior.** Unit tests have 30s test/hook budgets
  (in-process Convex under V8 coverage is several times slower than the 5s default);
  the real-server stack test uses 30s steps. No assertion depends on elapsed time.

The scheduled `.github/workflows/stability.yml` (nightly, and on changes to the
workflow itself) runs `pnpm coverage` twice under `taskset -c 0,1`. Each run
writes Vitest's JSON report (`RENDRO_TEST_OUTCOMES=<file>`) and keeps its
`merged/coverage-final.json`; `tests/helpers/diff-outcomes.ts` fails on any
per-test outcome difference and `tests/helpers/diff-coverage.ts` on any counter
difference. The second run and both comparisons always execute, so a failure in
only one of the two runs is reported with the exact tests. It also runs the e2e
suite once per engine and shard (`e2e-no-retries (<engine> <i>/2)`) with retries disabled (`E2E_RETRIES=0`).

## Comment widget lab (#118)

`tests/commentor-{widget,drawer,protocol,edges}-browser.test.ts` run the real
`commentor.js` in a publisher document inside a full-viewport iframe, with the real
`CommentorParentHost` and `ParentCommentTransport` in the parent shell. Only Convex is
replaced by the in-memory backend in `tests/fixtures/comment-lab-browser.ts`, which tests
script through `window.lab` (`tests/helpers/comment-lab.ts`): seed or publish threads,
hold a mutation open and settle it later, fail a method with a plain, public-code or
quota error, serve older pages, and publish snapshots before or after an acknowledgement
(`publishOnMutate`). Assertions read the final DOM, ARIA state, focus and announcements;
protocol hardening cases speak to the parent from inside the publisher document.

Ordering is controlled, not slept on. A Playwright clock (`install`/`runFor`/`setSystemTime`)
drives the five-second delete window, the 60-second slow-write notice, quota countdowns and
tooltip delays; `Lab.tick()` waits one real task so queued `selectionchange` events are
delivered under a fake clock; a test that needs a live update to overtake a pending reveal
holds `requestAnimationFrame` in the document and releases it explicitly. The fixture lays
the iframe out over the whole viewport because the pinned Chromium stops running animation
frames for off-screen frames under `CI=true`.

Pure logic stays in Node: `commentor-protocol-units.test.ts` (message guards, argument
validation, recovery state, pending deletions, transport edge cases),
`commentor-host-units.test.ts` (host scoping, the Convex backends and `bootCommentorParentHost`
with a mocked `ConvexClient`), `commentor-parent-entry.test.ts` and
`commentor-direct-client.test.ts` (the accepted direct-Convex legacy configuration of the
widget, with a mocked client).

## Shared fixture

Call `createBrowserHarness()` from `tests/helpers/browser.ts` once at file
scope, before registering the suite's hooks. Build fixture bundles in
`beforeAll`, using `browserStep("bundle …", () => build(...))`, and call
`await harness.start(requestListener)`. Use `harness.origin` in the handler
and navigation URLs; the server binds to port 0 on loopback, awaits listening,
and checks an actual HTTP health response before launching Chromium.
The health request bypasses the global fetch mock in `tests/setup.ts`.

Use `await harness.newPage(options)` instead of `browser.newPage()`. Every
page gets a new browser context. The harness closes contexts after each test
and closes Chromium and the server after the file, including failed tests and
held HTTP responses. Release deliberately held fixture promises in a test's
`finally` as well. Wrap navigation, rendering, and protocol waits in
`browserStep("describe the expected transition", async () => { ... })`;
pass a `message` to `expect.poll` for server-side request assertions.

The context blocks service workers, WebSockets, and HTTP requests outside the
fixture origin, and reports unexpected origins after each test. The app needs no
CDN or font service; fulfill any other intentional fixture with `page.route` before
navigation (page routes take precedence over the context guard). Do not use `route.continue()` for
external resources. Node/backend requests must also use mocks; the context
route guard does not intercept Node fetch or Playwright's APIRequestContext.
Default CI must never require a live account, CDN, font service, or backend.
CI uses the installed Playwright Chromium; a local executable can be supplied
with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

Playwright launches Chromium with `--disable-back-forward-cache`. A suite that
exercises a real back/forward-cache restore passes
`createBrowserHarness({ ignoreDefaultArgs: ["--disable-back-forward-cache"] })`
(`tests/rum-browser.test.ts`). The coverage profiler does not follow a restored
document, so cover restore-only code with a dispatched `pageshow`
(`persisted: true`) on a page that never left, beside the real restore. Code
that runs while leaving a page (`pagehide`, the final `visibilitychange`) runs
after the collector's `beforeunload` snapshot; exercise it on a page that stays.

## Ticket expiry

Set `page.clock.setFixedTime(epoch)` **before navigation**, using the same
epoch as the fixture server. Advance both clocks explicitly and dispatch the
focus event that requests renewal. Wait for the renewed prefix to reach the
opaque frame, then for imported/linked styles to apply before advancing the
next round. A server response alone does not prove Chromium applied a sheet.
[Playwright's fixed clock](https://playwright.dev/docs/clock) leaves rendering
and timers running; no wall-clock sleep or Vitest fake timer is needed.
The private-viewer suite still checks that the original ticket returns 404,
all deferred images use the latest ticket, the opaque message origin is null,
and CSS cascade and comment drafts survive renewal.

## Migration for PRs #26 and #27

Their `*-browser.test.ts` filenames automatically select the serialized project.
Remove file-local 20s/30s test/hook overrides to inherit its documented budgets.

- **#26, security headers:** replace `serve`/manual port/Chromium lifecycle with
  `harness.start(getRequestListener(request => worker.fetch(request, env)))`
  using `getRequestListener` from `@hono/node-server`. Keep the real app `/health`
  and bundled-asset status/MIME checks in addition to the harness readiness
  probe. Switch `pageFor` to `harness.newPage`, remove its 5s timeout overrides,
  and preserve cookie setup, CSP collection, and deterministic CDN/font
  fulfillments. Keep backend mocks and mock cleanup. Live external smoke tests,
  if retained, belong in an explicit opt-in workflow, outside this CI harness.
- **#27, viewer fragments:** pass the existing Node request handler to
  `harness.start`, reference `harness.origin`, and replace its page factory with
  `harness.newPage`. Preserve route/backend mocks and fragment/navigation
  assertions. Wrap scroll, postMessage, and frame-navigation waits with labels.
  Keep mock cleanup; remove the duplicated server/browser teardown.

Neither migration requires changing production viewer behavior or assertions.

## UI transition registry (#99 / #102)

`tests/ui-transitions.json` is the maintained behavior inventory. It reconciles
all 152 coverage-audit families (`UI-001`–`UI-152`), the 98 broader modernization
families (`G/A/M/O/P/V/C` references on edges), and route ledger `R01`–`R35`.
Additional families cover landing motion, viewer reading mode/resize, shared
controls, the signed-in home (UI-166), and the `/r/` read path. Families, edges,
route-ledger entries and inventory references whose surface was removed (#286:
uploads, organizations, projects, API keys, Google sign-in) move to the
`retired` section with a reason; their IDs are never reused. Keep IDs
stable; append new IDs instead of renumbering. Sources are canonical controller
paths; route strings use Hono's actual method and parameter names. In particular,
`:viewerToken` corresponds to the inventory's abbreviated `:ticket`.

Each edge records **state → trigger → expected result**, its inventory references,
evidence status, and exact test file/declaration title (use the literal template
for `it.each`). Status means:

- `untested`: no cited assertion for this edge; prose/source inspection is not coverage.
- `unit`: a unit, VM, DOM, HTTP, or markup assertion, limited to the stated result.
- `browser`: an executing Chromium browser assertion, possibly with mocked services.
- `e2e`: an assertion through the complete local application/backend stack.

A family's status is its **strongest cited edge**, not a claim that all its
behavior is covered. Broad acceptance requirements remain untested until their
own assertions are linked; narrower existing assertions are recorded separately.
This deliberately preserves partial evidence without promoting an entire family.
The report prints both family and edge counts, plus families whose *every* edge
has browser/e2e evidence. Declared roles, viewport widths, and engines are required
dimensions, not executed coverage. Anonymous/outsider roles include denied entry;
not every role can successfully perform each action. Existing browser evidence
is Chromium only; the individual test defines its actual fixtures/dimensions.

Epic #99 requires **every edge to reach browser or e2e coverage** in Chromium,
Firefox, and WebKit, with representative mobile widths (320/375/430), desktop,
roles, keyboard, light/dark, reduced motion, errors, and race conditions. Unit
coverage percentages and a passing registry validator do not satisfy that goal.
For implementation conflicts, follow the current controller: for example, comment
submission uses plain Enter, not the audit's Cmd/Ctrl-Enter description.

Run the generated summary and validation from the repository root:

```sh
pnpm exec tsx scripts/ui-transition-report.ts
VITEST_MAX_WORKERS=2 pnpm exec vitest run tests/ui-transitions.test.ts
```

Initial reconciled family counts: **70 untested, 64 unit, 26 browser, 0 e2e**
(160 total). The historical audit at `6e22d7f` on 2026-10-15 had 152 families:
64 untested, 62 unit, 26 browser. The eight additions have six untested and two
unit families. The JSON also preserves the historical configured coverage
S/B/F/L **65.50/64.76/69.47/67.42%** (101 files), widened coverage
**66.25/65.44/70.93/68.45%** (171 files), and **2,188 passed / 12 skipped tests**.
These are historical measurements, not a fresh coverage run. Those 12 formerly opt-in `convex-public-rpc` tests now run unconditionally against
a disposable local backend; their RPC assertions receive no UI registry credit.

The validator walks the real Worker and Node Hono registrations (without starting a server), including shared route
modules, HTML POST results, document frames, and fallback pages. Every registration
must be a family route or an **exact method/path** exclusion with a reason in
`routeSkips`; APIs, middleware, XML, and static assets are enumerated there. A new
page route fails the gate until registered, even under `/api/`; wildcards are not
used to exempt newly registered paths. Remove stale exclusions when routes change.
The validator also checks schema, unique IDs, inventory retention, source/test-file
existence, and enabled AST test declarations (not matching strings in comments).
Reviewers must still verify that the cited test actually asserts the described
edge; automated name checks cannot establish semantic coverage.

## Source coverage and debt gate

Install Chromium as above, then run the full suite and coverage gate locally:

```sh
VITEST_MAX_WORKERS=2 pnpm coverage
```

The quality workflow runs this in a separate `coverage` job (20-minute budget)
and uploads the Vitest/merged summaries and counters, browser shards and LCOV,
including on failure. The raw `coverage/coverage-final.json` remains available
even when a test or merge failure prevents the merged report from being written.
`pnpm verify` keeps its existing 15-minute CI budget: the audit's full
coverage run alone took about six minutes, so running the suite again inside
verify would leave insufficient headroom. Vitest honors `VITEST_MAX_WORKERS`;
use two workers on the shared development host.

`scripts/coverage-policy.ts` is the shared source policy: authored `.ts` in
`src` (including `src/index.ts`), `convex` and `shared`, and `.ts`/`.mjs`
in `scripts`. Declaration files, both Convex `_generated` trees, and
`convex/betterAuth/schema.generated.ts` are excluded. Vitest filters are rooted
at the absolute repository path and require end-of-path because its
`contains: true` matcher otherwise selects nested trees and `.tsx` suffixes.
The gate independently globs the source manifest without directory expansion.
Generated browser bundles and tests are outside the source denominator.

The gate reads Istanbul JSON counter reports, canonicalizes relative paths,
absolute paths within this checkout, and `file:` URLs to repository-relative
source paths, then merges by source location rather than counter ID. Reports
must come from the same source revision and compatible transforms: mismatched
statement/function/branch maps, malformed counts, missing reports, and reports
with no included sources fail. Remapped end-of-line columns and implicit branch
locations are preserved; negative inferred branch hits are treated as zero,
matching Istanbul's uncovered classification and preventing cancellation of
positive hits from another shard. Paths outside this checkout fail; producers on
other machines must emit repository-relative paths. Never guess source identity
by stripping arbitrary absolute-path prefixes.

Every manifest file must appear in at least one shard. Missing files receive
zero-hit counters from the source AST (using esbuild source maps and the same
`ast-v8-to-istanbul` converter as Vitest) and fail the gate even if debt exists.
`coverage/merged/coverage-final.json` and `coverage/merged/coverage-summary.json`
contain the combined result, including those zeroes. The console prints summed
covered/total counts for statements, branches, functions, and lines; percentages
are computed from those totals, never averaged across files. An empty executable
denominator is N/A, not evidence of tested behavior.

`coverage-debt.json` version 1 records uncovered counter counts per file and
metric from a real full run. A file outside the ledger must have zero uncovered
counters in all four metrics; an existing entry cannot regress on any metric.
A fully covered or removed file's entry must be deleted. After improving tests,
shrink the ledger using the same complete reports:

```sh
pnpm exec tsx tests/helpers/run-browser-coverage.ts --merge-only --update-ledger
```

This command refuses new debt or increased counters and writes nothing if any
check fails. There is deliberately no bootstrap/reset/grow option. CI also
compares the checked-in ledger against `COVERAGE_DEBT_BASE` (PR base or previous
push), so hand-editing the ledger cannot introduce or increase allowances. The
initial rollout is the only base revision without a ledger. Review ledger
reductions alongside the tests that justify them. **The ledger must be empty
to close epic #99.** Passing this temporary debt gate is not 100% coverage.

### Chromium source coverage (#104)

`pnpm coverage` runs Vitest with `RENDRO_BROWSER_COVERAGE_DIR=coverage/browser`.
The harness writes a uniquely named Istanbul JSON shard for every context,
including an empty receipt for fixtures with no authored browser code. The
runner requires receipts from **every** browser suite before passing all
nonempty shards and the canonicalized Node report to the existing gate. A
missing browser producer fails; Vitest cleans old output before each run.
A failed test still closes its context and writes its report, but a failed
suite prevents the final gate from reporting success.
`pnpm test:coverage` remains the raw Node/Vitest diagnostic command. Use
`pnpm coverage` and `coverage/merged/coverage-summary.json` for the combined
result; Vitest's LCOV file contains only the Node producer's coverage.

A suite with a specialized context lifecycle (currently interrupted-navigation
tests) installs `collectBrowserContext` before creating its first page and still
awaits `context.close()` in teardown. It must produce the same required receipt.

Build browser fixtures with `bundleBrowserAsset(entry)` or
`buildBrowserBundle(options)` from `tests/helpers/browser.ts`. These build only
in memory, using inline source maps with source content, no minification, and
no tree shaking. Production bundles, asset versions, and the asset ledger are
unchanged. Serve JavaScript as `text/javascript; charset=utf-8`: incorrect
decoding changes V8 offsets and is rejected as an unrecognized bundle.
Transport substitutes and publisher fixture modules also have maps, with
virtual paths under `tests/fixtures`, so they cannot receive application credit.

The collector starts Playwright JS coverage before navigation with
`resetOnNavigation: false` and `reportAnonymousScripts: true`. It also uses
public `BrowserContext.newCDPSession` sessions for page and OOPIF targets:
page coverage alone loses samples across some renderer changes, and its debugger
automatically resumes pauses before child collection can finish. The harness
stops that API collector and transfers to CDP while navigation/script responses
are still held, before authored bundle execution. CDP owns collection through
teardown. A script
request barrier attaches child targets before their script responses are
released, including page/context route fulfillments and popup scripts.
Same-process frames share their page's profiler. Chromium's precise-coverage
delta events preserve intermediate samples; a `beforeunload` event breakpoint
flushes the final interval before navigation destroys the old context.
The breakpoint needs a listener that the collector installs in each target's
first document; OOPIF children get their own target per document. A main
document reached after the first navigation has no such listener (injecting one
everywhere changes viewer navigation behaviour), so before page code navigates
the main document itself, for example the viewer's Reload control calling
`location.reload()`, tests must `await harness.flushCoverage(page)`. Otherwise
whether the outgoing interval is retained depends on Chromium's paint-triggered
coverage deltas. A regression covers a page-initiated opaque child reload.
`pagehide` is too late because Chromium suppresses debugger pauses then.
The harness intercepts explicit page/context close and awaits a collection
barrier for every attached target before detaching any session, including failed
tests. Concurrent lifecycle and explicit flushes serialize per target. These hooks run only during
coverage collection, apart from the collector's dedicated regression fixture.
Navigation APIs (`goto`, `reload`, Back and Forward) also await this barrier
before starting navigation: a parent reload can discard child-realm counters
without a reliable child lifecycle pause. The opaque-parent-reload regression
asserts that both the outgoing calls and the new document's call are retained.
An iframe removed directly from the DOM does not run `beforeunload`. Tests must
`await harness.flushCoverage(page)` before removing a frame or triggering other
destructive fixture actions. This barrier is a no-op outside coverage runs.
The regression contract covers direct frame removal after this barrier,
navigation, popup self-close, explicit close, and harness teardown. Renderer
crashes cannot guarantee a final sample.
Source text is read on each `Debugger.scriptParsed` event. A parent reload can
deliver a precise-coverage delta for a transient script that never had that
event; its id is already gone. Such a sample keeps its counts only when every
retained sample for the same URL in that context has one identical source, and
its ranges fit that source. Otherwise conversion fails as before.

Identical-bundle V8 deltas are first combined with Vitest's pinned
`@bcoe/v8-coverage` range-tree merger, avoiding repeated AST conversion.
Conversion uses the same pinned `ast-v8-to-istanbul` and Vitest AST parser as
the gate. It validates embedded source content against this checkout, maps to
repository-relative paths, then drops dependencies, generated APIs, and test
fixtures. esbuild's synthetic class declaration wrappers are ignored; renamed
bundle function symbols are restored by exact declaration/body locations in
the gate's unbundled AST transform. Every remaining counter map must match
exactly before addition, including duplicate branch locations. Unrecognized
script URLs (including extensionless first-party requests), missing maps, stale
source content, and incompatible maps fail the run.

Vite's SSR import rewriting changes some Node source-map start columns. Before
merging, the runner independently reproduces Vite's SSR map and the gate's plain
esbuild map from each browser-covered source. The actual Node map must match
the reproduced SSR map exactly. It translates counter identities using exact
locations first, then unique source endpoints (including function declarations
and every ordered branch arm). Ambiguous matches fail. Statements collapsed by
SSR retain zero hits in the canonical map; normalization cannot manufacture
coverage. `coverage/node-canonical.json` records the result, while the original
Vitest report remains available. The gate itself still requires identical maps.

`tests/browser-coverage-browser.test.ts` proves exact executed/unexecuted branch
lines in a real opaque OOPIF, a final function call immediately before frame
navigation, popup execution retained after navigation/self-close, and collection
after a deliberately failing test. It asserts the child CDP target really is
an `iframe`. `tests/browser-coverage.test.ts` checks required suite receipts and
strict merging. The existing gate tests retain the absent-source/zero-seeding
proof; browser execution cannot remove a file from the denominator.

Inline auth/theme/shell controllers rendered as strings do **not** receive
authored-module coverage here: extraction and genuine source maps belong to
#105/#106. That boundary must not be mistaken for full coverage of rendered
controllers.

### Subprocess coverage (server, scripts)

Tests that spawn Node run the repository's own code outside Vitest's collector:
the Node server and the `scripts/` entry points (as tsx source or an esbuild bundle). `pnpm coverage` sets `RENDRO_SUBPROCESS_COVERAGE_DIR`
(`coverage/subprocess`); a test that spawns passes `subprocessEnv(env)` from
`tests/helpers/subprocess-coverage.ts` to the child (and `subprocessArgs()` before
the entry for a server that SIGTERM stops, so it exits normally and writes its
dump). Each call creates its own receipt directory `raw/<suite>-<uuid>` as that
child's `NODE_V8_COVERAGE`, strictly under the coverage output and never in the
repository tree. Without the variable the helpers do nothing, so plain
`pnpm test` runs are unchanged. Test-built script bundles use `buildRegisteredBundle`
(inline source maps, no tree-shaking) and register the bundle text, because the
scratch file is deleted before conversion. A scratch bundle built any other way
must run without the collector.

`tests/helpers/merge-subprocess-coverage.ts` converts the dumps after the run
(`convertSubprocessCoverage`) and reuses the browser pipeline: manifest and
canonical-path filtering, the source-map conversion and stale-source check of
`convertMapped`, then `alignCoverage` to the gate's canonical maps and
`mergeBrowserFile` to add counts. Three script kinds are handled:

- **tsx-run TypeScript.** V8 reports offsets of tsx's output, which dumps do not
  keep, so the merger re-runs esbuild with tsx's coverage options (minified
  whitespace, `keepNames`, the child's Node target) and accepts the result only
  if every line length equals Node's recorded `lineLengths`. tsx's `.then(...)`
  interop after each dynamic `import()` is inserted as an equal-length placeholder
  and its nodes are ignored. The recorded source map is the one used.
- **Registered bundles** map through their inline source map back to `scripts/`
  and `shared/`.
- **Plain `.js`/`.mjs`** run unmodified (the repository has none today; a scratch
  project in the collector's own tests keeps the path exercised).

The converted maps are re-keyed onto the gate's canonical maps because tsx and
bundles re-print code (esbuild's `__name` helpers, `_default` export bindings,
spans moved by wrapping). A hit that cannot be paired with exactly one canonical
entry is an error, never a guess. The vitest report is aligned the same way for
files that a subprocess also covers; a file Vitest listed without executing is
replaced by its zero map.

The run fails closed: the suites that call the helpers (found by scanning for
`subprocessEnv(`) must each leave a receipt; a receipt with no
dump (a child killed before exit), one that touched no repository source, a
script that maps to authored files but was never registered, an unreproducible
tsx transform, a stale recorded source or an ambiguous pairing all stop the
merge. Raw dumps are deleted once converted, leaving
`coverage/subprocess/<suite>-<uuid>.json` shards, which `--merge-only` reuses.

Subprocesses write only to temp directories and local loopback fixtures: build
scripts run with a copied `src/` in a scratch working directory.

After a successful complete collection, use the same required browser shards
to review/shrink debt without rerunning Chromium:

```sh
pnpm exec tsx tests/helpers/run-browser-coverage.ts --merge-only --update-ledger
pnpm exec tsx tests/helpers/run-browser-coverage.ts --merge-only
```

`tests/lazy-tree-browser.test.ts` and `tests/shared-select-browser.test.ts` (#118) run
the real bundles against small fixture servers: legacy and scoped tree shells, a
frame that relays posted messages, and `page.route` holds or failures for tree and
document requests. Activation-sensitive navigation reserves the parent input with a
real click in the shell before a programmatic frame message, so the confirmation
prompt appears deterministically; the paused page clock drives the 520 ms and 15 s
loader timers and the select's typeahead buffer.

Before shrinking debt, save three consecutive full `VITEST_MAX_WORKERS=2 pnpm coverage`
results outside `coverage/` (Vitest cleans that directory). Compare each adjacent
pair with `pnpm exec tsx tests/helpers/diff-coverage.ts first/merged/coverage-final.json
second/merged/coverage-final.json`. An identical hit/no-hit result prints nothing
and exits zero; differences print exact source maps and branch arms and exit one.
This compares individual counters, not just totals. Do not add tolerance or
discard counters to make a flaky result pass. `browser-determinism-browser.test.ts`
uses a paused Playwright clock, held responses, explicit layout/transition/scroll
events, and controlled comment subscription delivery to exercise both outcomes
of scheduling-sensitive paths. Reduced motion keeps its assertions independent
of CSS animation timing. The legacy comment fixture waits for the bridge
acknowledgement and composer teardown before reloading; database persistence
alone does not establish that the browser has finished handling a mutation.

For CI scheduling regressions on Linux, constrain the entire command (including
Chromium children) to two available CPUs:

```sh
CI=true VITEST_MAX_WORKERS=2 taskset -c 0,1 pnpm coverage
```

Save and compare three consecutive reports with the same counter diff command.
Use CPUs from `taskset -pc $$` if the host does not allow CPUs 0 and 1. Download
the failing workflow's `coverage-summary` artifact with `gh run download <run-id>
-n coverage-summary`; compare its `merged/coverage-final.json` with the matching
local source revision. The comment highlight fixture explicitly updates a visible
anchor twice and asserts DOM segment reuse before exercising off-screen removal;
reuse must not depend on an incidental resize or animation frame.

Coverage context teardown keeps the 10-second browser-action deadline around
protocol flushing, profiler detachment and physical context close. Source-map
conversion and report writing happen afterward, within the existing 60-second
hook budget. A fake-clock regression advances time during reporting to verify
that CPU-heavy conversion is not charged to an already completed browser action;
mapping failures still fail teardown.

The coverage job keeps its existing 20-minute timeout. Browser files remain
serial, and shared-host commands use `VITEST_MAX_WORKERS=2`. The #104 Round 2 validation
used pinned Chromium for three consecutive full runs on unchanged code. All
184 test files passed each time; complete collection and gating took 738.12,
859.03, and 833.21 seconds. Both adjacent per-counter diffs were empty across
all 194 source files. These timings retain headroom for CI setup within the
existing budget.
