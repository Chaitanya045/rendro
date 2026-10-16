# Browser tests

There are two independent layers. The **Vitest browser project** below runs
focused Chromium tests against Node HTTP fixtures, including real Worker route
handlers where useful. **Playwright Test E2E** runs the actual `src/worker.ts` in
workerd with Chromium, Firefox, and WebKit. It exercises Worker bundling,
compatibility flags, HTTP, the ASSETS binding, browser CSP enforcement and the
S3 client together. Neither layer replaces the other.

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
```

`e2e/playwright.config.ts` owns the projects and global setup. Setup rebuilds
browser assets every run so ignored bundles cannot silently be stale, then uses
Wrangler **4.149.0**'s `createTestHarness().listen()` to start the real Worker.
The harness uses the same local workerd development runtime as `wrangler dev`;
it does not import the Worker into Node or replace its route handlers. A temporary
copy of `wrangler.toml` relocates only the entry point and asset directory to
absolute paths, preserving the production compatibility date, `nodejs_compat`,
ASSETS binding and `run_worker_first`. `NODE_ENV` remains `production`.

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

The disposable backend sets `DATABASE_UDF_USER_TIMEOUT_SECONDS=5`. The pinned
[backend defaults to one second](https://github.com/get-convex/convex-backend/blob/a3538c6/crates/common/src/knobs.rs#L967)
of elapsed time outside syscalls, which can expire
even an indexed session lookup when a shared runner deschedules it. This test-only
execution budget leaves application deadlines, auth lifetimes and rate limits intact.

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

S3Proxy **4.1.1** runs from the digest-pinned image in `e2e/services.ts`, with a loopback-only host
port, fresh credentials, a tmpfs data directory, and a fresh bucket. The actual
AWS SDK and CLI exercise signed reads, uploads, listings and commits. No persistent
volume or named shared container is used. The public smoke publication is created
through the real API after a real CLI push. Its missing-object control deliberately
deletes one already-uploaded object; its manifest remains intact.

Convex's outbound proxy terminates mail and OAuth requests locally, with a fresh
CA and server certificate trusted only by the child backend process. The Resend
wire endpoint captures verification/invitation messages in memory. The deterministic
Google fixture preserves state, binds authorization codes to the redirect and PKCE
challenge, consumes codes once, and returns a locally signed identity token. Browser
navigation to Google's authorization URL is fulfilled locally. No email or OAuth
request reaches an external provider. Only the exact local Worker/Convex origins
can pass through the backend proxy; other destinations fail teardown. This tests
the application/provider protocol boundary, not Google's UI or deliverability.

Seed helpers use real signup, verification, sign-in, organization and invitation
APIs to provision owner/admin/member plus an outsider in a second organization.
Their generated sessions live only in a mode-0600 temporary fixture file. Each
browser context gets its own cookies; test artifacts contain disposable fixture
identities only. Distinct synthetic ingress IPs keep engine auth rate-limit windows
independent while leaving the application's limits enabled.

The Worker outbound guard allows only the exact local services. Redirect responses
are returned to the browser without following them. The browser guard permits
Worker and local Convex HTTP/WebSocket traffic and fulfills font/CDN resources
locally. Any other destination fails. Teardown closes workerd, Convex, the proxy,
mail sink and S3Proxy and removes temporary data, including on setup/test failure.
An empty temporary `.dev.vars` and disabled dotenv loading isolate Worker secrets.

The three engines run the original nonce/CSP, opaque publication/SVG and 404 MIME
smokes, role/tenant allowed-and-denied checks, local OAuth success/state rejection,
and one full UI signup → mail verification → organization → project → one-time API
key → built CLI push → private viewer → comment journey. The comment must arrive
in a second open viewer via a real subscription and remain after reload. These are
functional checks, not visual fidelity assertions or coverage of every epic #99 edge.

Local retries are zero. CI permits one diagnostic retry, prints each attempt,
and uses `failOnFlakyTests` so a passing retry cannot hide a first failure.
[`retain-on-failure`](https://playwright.dev/docs/trace-viewer) records the
original failed attempt even without retries. The separate `e2e` job in
`quality.yml` installs all three engines and uploads traces, failure screenshots
and the HTML report for seven days. Open a trace with
`pnpm exec playwright show-trace test-results/e2e/<test>/trace.zip`.
`pnpm verify` continues to run the existing Vitest layers independently.
`e2e/` is typechecked/linted test infrastructure, outside the production
coverage denominator. The loopback/environment guards have a separate 100% coverage
regression. The Worker XML polyfill exposes an array of named attributes, so the SDK reads
empty S3 listing elements as strings instead of objects. A focused regression
covers this compatibility fix; no generated Convex module is modified.

`tests/convex-public-rpc.test.ts` now always starts its own pinned backend: all 12
RPC envelope/cursor tests execute in `pnpm verify` and in an explicit mandatory
step of the E2E job. There is no opt-in skip or shared deployment credential.
CI caches the verified backend archive and S3Proxy image layers as well as pnpm dependencies.
The workflow jobs have no conditional opt-out or allowed failure. Repository
branch protection must require the existing `verify`, `coverage`, and `e2e` checks.

The remaining slices extend this foundation: #110 shell,
navigation, menus, dialogs and selects; #112 organizations, onboarding, people/invitations and teams; #113 projects,
deployments, API keys, shares and publications; #114 document tree/viewer/link
confirmation; #115 comments and recovery. The transition registry's `e2e` status still requires edge-specific assertions;
this baseline does not promote all those journeys to complete E2E coverage.

## Authentication journeys (#111)

`e2e/auth.spec.ts` extends the real-stack suite with signup and verification mail,
neutral duplicate/recovery responses, browser validation/focus/reveal, pending
submission exclusion, the production sign-in limiter, remember-me session/cookie
lifetimes, safe return destinations, password reset and change, initial-password
freshness, method-load retry, Google linking/callback errors, and sign-out across
contexts, tabs and history. Tests project session reads to non-secret identity
and lifetime metadata, and check backend record removal after revocation.
The original signup mail is captured before any later verification message and
followed through explicit sign-in to its query-bearing return destination. A
separate account tests resend delivery and neutral eligible/ineligible responses.
Reset mismatch asserts zero reset requests, with one request after correction.
Sign-out checks that the retained protected containers are hidden and their shell
is inert in both tabs before navigation; protected inputs cannot regain focus.
The shared sign-out helper waits for the security method list's `aria-busy=false`
before clicking Sign out in every journey. Method loading expands the card and
moves that control; WebKit can otherwise finish its actionability check just
before the response arrives and click the old position. Waiting for this explicit
ready state also covers the method-load failure UI, without sleeps or retries.

The complete three-engine suite has a 20-minute bound (30 minutes for the CI
job including installation); individual auth journeys have a 60-second bound.
Each test/context has a deterministic synthetic ingress address. The limiter
case actually exhausts the configured five-attempt window; production limits
remain enabled. Transport-failure tests hold individual browser requests and
return a deliberate 503. Method-load and Google-link cases then retry against
the real backend. The OAuth fixture
supports per-authorization identities, denial and mismatched state while keeping
the real callback, single-use code, PKCE and token exchange.

A mode-0600 file in the run's private directory gives the test helper access to
that exact loopback backend's component adapter. It changes only disposable
session creation/expiry and reset-token expiry timestamps. It is never copied
into the worktree, exposed to browser JavaScript or supplied to a shared backend.
No production auth option or Convex source changes are needed for these cases.

Real back/forward traversal checks that signed-out pages do not expose account
content. Since browser routing can prevent native BFCache eligibility, an
additional test explicitly dispatches a persisted `pageshow` event after backend
revocation; it checks the restoration handler, not native cache admission.

The #146 signup visibility regression now passes in all engines: the credential
form, Google control and divider disappear, focus moves to the confirmation,
and returning through sign-in restores the signup controls.
`tests/auth-hidden-browser.test.ts` checks computed display, keyboard focus,
retry and restored forms at desktop/mobile sizes, plus reset and security states.

Expected failures, when present, name follow-up issues. Their broken assertions
receive no `e2e` registry credit; an unexpected pass fails the suite so the marker
must be removed when the product is fixed. None are currently open.

The #145 regression (AUTH-111-02) now passes in all three engines. It asserts the
one-day backend lifetime after account, organization, project and document reads,
reloads and the expiry boundary, alongside the session-only browser cookie.
The same reads run with absent and altered client preference markers. Password
rotation regressions check both stored lifetime choices and replacement-cookie
persistence after removing the marker.
A remembered-session control ages the disposable record past its update age and
verifies protected entry refreshes it to seven days.

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
runner cannot reliably fit a unit test's 5s budget. Operations normally fail
after 10s with a step label; Chromium launch has its own 45s deadline. These
are failure bounds, not sleeps or retries. Assertions are not retried at the
test level.

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
fixture origin, and reports unexpected origins after each test. Fulfill any
intentional CDN/font fixtures with `page.route` before navigation (page routes
take precedence over the context guard). Do not use `route.continue()` for
external resources. Node/backend requests must also use mocks; the context
route guard does not intercept Node fetch or Playwright's APIRequestContext.
Default CI must never require a live account, CDN, font service, or backend.
CI uses the installed Playwright Chromium; a local executable can be supplied
with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

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
Eight additional families cover landing motion/OAuth, viewer reading mode/resize,
legacy organization creation, cache invalidation, and shared controls. Keep IDs
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
and uploads both the Vitest and merged JSON summaries plus LCOV, including on
failure. `pnpm verify` keeps its existing 15-minute CI budget: the audit's full
coverage run alone took about six minutes, so running the suite again inside
verify would leave insufficient headroom. Vitest honors `VITEST_MAX_WORKERS`;
use two workers on the shared development host.

`scripts/coverage-policy.ts` is the shared source policy: authored `.ts` in
`src` (including `src/index.ts`), `convex`, `cli/src`, and `shared`, and `.ts`/`.mjs`
in `scripts`. Declaration files, both Convex `_generated` trees, and
`convex/betterAuth/schema.generated.ts` are excluded. Vitest filters are rooted
at the absolute repository path and require end-of-path because its
`contains: true` matcher otherwise selects nested trees and `.tsx` suffixes.
The gate independently globs the source manifest without directory expansion.
Generated browser/CLI bundles and tests are outside the source denominator.

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
pnpm exec tsx scripts/coverage-gate.ts --update-ledger coverage/coverage-final.json
```

This command refuses new debt or increased counters and writes nothing if any
check fails. There is deliberately no bootstrap/reset/grow option. CI also
compares the checked-in ledger against `COVERAGE_DEBT_BASE` (PR base or previous
push), so hand-editing the ledger cannot introduce or increase allowances. The
initial rollout is the only base revision without a ledger. Review ledger
reductions alongside the tests that justify them. **The ledger must be empty
to close epic #99.** Passing this temporary debt gate is not 100% coverage.

### Additional coverage shards (#104 and #107)

The current Playwright suites execute Chromium outside Vitest's Node collector.
Inline controller strings, browser bundles, and CLI/server subprocesses remain
measurement gaps even when their functional tests pass. Do not exclude these
authored sources or run operational scripts against real services to raise the
score.

Chromium collection (#104) will collect before navigation, retain navigation and
iframe coverage, and remap bundle execution through source maps. Subprocess
collection (#107) will use isolated `NODE_V8_COVERAGE` outputs and remap CLI/server
execution. Both producers must use the same revision, converter, original source
locations, and compatible counter maps as the unit shard. Then add each required
report explicitly to the gate command after all producers succeed, for example:

```sh
pnpm exec tsx scripts/coverage-gate.ts \
  coverage/unit/coverage-final.json \
  coverage/chromium/coverage-final.json \
  coverage/subprocess/coverage-final.json
```

These extra shards do not exist yet. Do not discover them through an optional
wildcard: explicitly naming required reports makes a missing producer fail.
