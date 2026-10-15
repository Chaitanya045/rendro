# Chromium tests

Run `pnpm exec playwright install chromium`, then `CI=true pnpm test:browser`.
`pnpm test` and `pnpm verify` include both projects. On Linux, use
`CI=true taskset -c 0,1 pnpm test:browser` to reproduce a two-CPU budget (choose
CPUs from `taskset -pc $$` if your container has a different allowed set).

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
These are historical measurements, not a fresh coverage run. The 12 opt-in
`convex-public-rpc` tests require `CONVEX_TEST_BACKEND` and receive no registry credit.

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
