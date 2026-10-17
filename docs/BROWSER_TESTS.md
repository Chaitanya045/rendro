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
`E2E_RETRIES` overrides the count; the nightly stability workflow sets it to `0`.
[`retain-on-failure`](https://playwright.dev/docs/trace-viewer) records the
original failed attempt even without retries. In `quality.yml` each engine runs as
its own `e2e (chromium|firefox|webkit)` job (`pnpm e2e --project=<engine>`), so wall
time follows the slowest engine rather than the sum. A final `e2e` job depends on
all three and fails unless every one succeeded, keeping a single required check
name. Each engine uploads its traces, failure screenshots and HTML report for
seven days as `workerd-e2e-failures-<engine>`. Open a trace with
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

The complete three-engine suite has a 45-minute bound locally. In CI each engine
is its own job (30 minutes including installation), so the bound applies per
engine; individual auth journeys have a 60-second bound.
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
verifies protected entry refreshes it to seven days. A bearer-token check sends
the session token as `Authorization`, alone and with the cookie, directly to
Convex and through the Worker. It asserts that bearer tokens never authenticate,
that no persistent session cookie is set, and that the stored expiry is unchanged.

## Shell, navigation, menus, dialogs and selects (#110)

Six specs under `e2e/shell-*.spec.ts` cover the management shell and its shared
controls on the real Worker, in all three engines at 1440px and 375px. They
use `tests/ui-transitions.json` as the checklist: an edge is credited `e2e`
only when a named test asserts its final state (URL and history entries, focus
location, `aria-expanded`/`aria-modal`/`inert`, visible content and request
counts); the ledger names those tests.

| Spec | Covers |
|---|---|
| `shell-navigation.spec.ts` | Persistent chrome and the ten client-routed destinations (no document request), destination skeleton and in-place data swap, modified/targeted/download/cross-organization links, no-JavaScript navigation, Back/Forward, blocked Back, dialog/pending-write/cross-tab blockers and Refresh, late responses from disposed pages, dirty-settings discard, revoked membership and account change, and the authenticated-HTML fallback (unavailable bundle, invalid/mismatched/stalled HTML) |
| `shell-menus.spec.ts` | Mobile drawer modal semantics, focus trap, scrim/Escape/close/route dismissal and resize reconciliation; account menu; organization switcher lazy load, cache reuse, keyboard/typeahead, dismissal, optimistic label hand-off, failure/empty/retry, late responses |
| `shell-dialogs.spec.ts` | Form dialogs (containment, Close/Cancel/Escape/backdrop, mobile footer order and fit, pending exclusion, failure retention), shared destructive confirmation, toasts |
| `shell-selects.spec.ts` | Enhanced select keyboard, typeahead, disabled options/groups, validation, reset, programmatic changes, positioning and dismissal |
| `shell-theme.spec.ts` | Initial theme before first paint, cycle and persistence, OS/storage synchronization, rapid and failing transitions, reduced motion, unavailable storage |
| `shell-controls.spec.ts` / `shell-entry.spec.ts` | Copy feedback, control sizes and states; direct-entry redirects, focused layouts and error pages |

Tests that mutate or need an exact organization list use a verified disposable
user. `e2e/shell-fixtures.ts` shares one such user per worker (eight organizations,
each with a project) and one for the organization switcher, so signup and
mail verification are paid once; tests that sign out or change membership still
create their own. The seeded owner is used read-only. Hold helpers stall a single
backend request at the browser boundary; no production behavior, header or
clock is changed. The authenticated-HTML fallback test installs Playwright's fake
clock to cross the 15-second navigation timeout without waiting.

No expected failures are currently open. The #162 regression passes in all three
engines: the shared select follows a user-activated native Reset button. The browser
restores the control only after the `reset` event and its microtasks have run (a
microtask suffices for programmatic `form.reset()`), so the select also re-syncs from a
task queued by the event. `tests/shared-select-browser.test.ts` covers it in Chromium and
`e2e/shell-selects.spec.ts` asserts the label, selected option and `aria-selected`
state in every engine (registry edge UI-023-E11).


## Organizations, onboarding, people and teams (#112)

Six specs under `e2e/org-*.spec.ts` run the organization journeys on the real Worker
and local Convex in all three engines. Journeys that involve several people use
`e2e/org-fixtures.ts`: each *actor* is its own browser context (own cookies and
ingress address), provisioned through the real signup, mail verification and
organization APIs by the shell helpers, and closed with the external-request guard
asserted. Setup that is not the journey under test (an invitation accepted so
someone is already a member) goes through the real authorization APIs; the journey
itself is driven through the UI. Final state is asserted three ways: the DOM (text,
ARIA, focus, announced toasts), the URL, and a re-fetch from the server or a second
person's view.

| Spec | Covers |
|---|---|
| `org-lifecycle.spec.ts` | Chooser with zero, one and many organizations (replace-redirect, forced chooser, cards, hostile names as text), create with slug derivation/override, length, native validation, pending exclusion, conflict and retry, the completed-state recovery link, list failure and Try again; settings guard, canonical save, slug conflict; owner-only deletion (API-only: there is no delete control) and the lost access of every member |
| `org-onboarding.spec.ts` | Organization → project → credential → first deployment with a real CLI push, five-second polling on a frozen page clock (hidden-tab pause, outage and recovery), one-time key reveal/copy/confirmation, setup initialization failure, foreign project, Finish later, member restriction |
| `org-people.spec.ts` | Invite batch (1–10 rows, native validation, sequential partial failure, retry without resending, captured mail), pending list failure and retry, revocation; roles (owner/admin/member controls, last-owner rule, failure revert, self-demotion, leave); member removal (confirmation, pending, failure, retry, lost access, team membership, revoked admin's rejected action) |
| `org-invitations.spec.ts` | Mailed link signed out through sign-up, verification and sign-in; review, accept (failure, pending, completed-state recovery) and decline; wrong recipient, revoked, expired and already-used invitations |
| `org-teams.spec.ts` | Create (validation, pending, failure, reuse), assign, roster open/hide/refresh, remove from team, delete (the last team and the session's active team are not offered, and the server still refuses them), read-only members; a 52-member roster with Load more, failure and retry, and an outdated page response |
| `org-permissions.spec.ts` | Controls of owner, admin and member on People, Teams and Settings; outsider denial; every management write refused for members, outsiders and (for ownership and deletion) admins |

Completed writes navigate immediately, so "stays visible" states are observed by
cancelling the destination navigation (`stopNavigation`, an aborted request that keeps the
current document) and then following the recovery link with real navigation. The 52
organization members of the roster test are written directly to the disposable auth
store through the admin key (`authRecord("create", …)`): signing up that many users
would dominate the run, and the roster is read through the same management APIs.
Invitation expiry is aged the same way. Polling uses Playwright's fake clock paused
after load; timers advance only when the test says so. A real `beforeunload`
prompt is not exercised: the guard is checked by dispatching the event and reading
`defaultPrevented`.

No organization expected failures remain: every journey above passes in all three engines.

Not asserted (not credited): the invitation page's own read-failure state (the page consumes the
server-rendered lookup instead of issuing a read that a browser test could fail), the organization
creation form's Cancel (there is none), roster completion beyond 100 members, the onboarding
credential step's third and fourth scope (the step offers only the two recommended ones), a
real `beforeunload` prompt, and an empty team list (unreachable: the server never deletes the last team).

## Projects, deployments, API keys, shares and publications (#113)

Five specs run the project journeys on the real Worker, local Convex, S3Proxy and the built CLI in all three
engines. They reuse the `actor` fixture of `e2e/org-fixtures.ts` (one independent browser context per person, own
cookies and ingress address, provisioned through real signup, mail verification and organization APIs), so each test
owns its users, organization and slugs; none uses the seeded users. Final state is
asserted four ways: the DOM (text, ARIA, focus, announced toasts), the URL, the authoritative API, and the **actual
URL or credential** the feature is about (an anonymous recipient's `/s/<token>` and `/p/<slug>` requests, a Bearer key
used by the CLI or `curl`-style calls). Helpers in `e2e/project-helpers.ts` push a document tree with the real CLI,
start/upload/commit/fail a deployment by hand (to hold one in `staging` or `failed`), and call the Worker with only a
Bearer key.

| Spec | Covers |
|---|---|
| `projects.spec.ts` | Empty list, create dialog (slug follows name, manual override, native validation, pending exclusion, conflict with retained draft, correction, same-shell navigation), overview facts and tabs, release badge; server-side normalization, boundaries and refusals; per-organization slug scope; read failure with Try again; another organization's project is a 404; owner/admin/member/outsider/anonymous controls and API |
| `deployments.spec.ts` | Empty history and the pinned, placeholder-only CLI command; a staging deployment (commit, dirty flag, size, date), an incomplete commit refused, a failed attempt with its reason, a real CLI push to Active/Deployed, a superseded release, a manually completed release; a stale failure call cannot deactivate the live release; history read failure with isolated retry; organization overview (counts, checklist, recent deployment empty/active/retry); member, outsider and anonymous access |
| `api-keys.spec.ts` | Create dialog (defaults, validation, rejection that keeps every choice, retry), one-time secret (modal, Done gated by the stored checkbox, Escape refused, exact copy values and clipboard rejection, scrubbed on close, absent from the list/DOM/storage), list facts, use by the CLI and recorded last use, revoke (Escape, pending, failure, success) with the **very next** API and CLI request refused; scope and project binding matrix; expiry (short-lived key refused after its time, "Expiring"/"Expired"/"Never", expired key still revocable); refused creation fields; owner/admin/member/outsider/anonymous |
| `shares.spec.ts` | Share from the document toolbar (exact copied URL, seven-day grant), anonymous recipient (headers, document, stylesheet, image), scope (sibling and unreferenced files, other folders, `?doc=`, altered token), pinned to its release across a later deployment, list facts without the link, revoke (Escape, pending, failure, success) ending every request; a one-minute link expiring while others live, "Expiring"/"Expired"/"Revoked", invalid shares refused; member creates but cannot revoke, admin revokes, outsider and anonymous denied |
| `publications.spec.ts` | Create dialog (validation, no deployment, lazily loaded pin choices with retry, only active/superseded releases offered, entry-file and slug conflicts that keep the form, reset after success), tracked vs pinned publication viewed anonymously (follows the new release vs keeps the old one, folder scope, tree, traversal), copy/open link, unpublish (Escape, pending, failure, success) with the URL gone on the next request and the slug reusable; API normalization and pinned-deployment rules; list failure with Try again; member read-only, admin removes, outsider and anonymous denied, slugs shared across organizations |

The one-minute share expiry is real time (the API minimum is 60 seconds and the Worker/backend read the system clock);
the test does its other work while waiting and polls the link, so it adds about 45 seconds per engine. The short key
expiry uses eight seconds. Everything else is clock-independent.

Not supported by the product (so not tested): renaming, editing settings of or deleting a project; re-activating an
older deployment (a new push is the only way to change the active release, and an older release is reachable through a
pinned publication or an existing private share); a retention display (the history shows the latest 100 releases and
says so). Not asserted (not credited): the sign-out and other-tab races of the key reveal and share revoke, copy
feedback timing (the copied values are asserted), legacy signed URLs, public-URL copy from the document toolbar,
`?docQuery`/fragment restoration in a shared document, the mobile layout of these pages, and quota (429) responses.

The four expected failures this suite once pinned (a lone surrogate in a project name answered 502, an out-of-range
key expiry was stored, a repeated permission was stored twice, and the publication title length was not enforced by
the API) were fixed by #187 and are now ordinary passing tests with registry credit.

Harness note: an oversized request body (the Worker answers 413 without reading it) makes the *next* request on that
connection fail with miniflare's "Network connection lost" 500. This is the local development transport, not the
application, but it means no test here sends an oversized body.

## Document viewer: tree, chrome and link confirmation (#114)

Four specs run the document viewers on the real Worker and local Convex in all three engines. One
deployment per worker is pushed through the real CLI (`e2e/viewer-fixtures.ts`: a private project with
an owner and an outsider, a whole-deployment and a one-folder publication, pages written to exercise
links, fragments and hostile publisher scripts; `e2e/deployment-tree.spec.ts` pushes its own 260-file
deployment so folders page). Final state is asserted in the DOM, ARIA, focus, the URL, history length,
`localStorage`, and the iframe's own location (`documentFrame()`); the document is opaque, so only
Playwright can read where it is.

| Spec | Covers |
|---|---|
| `deployment-tree.spec.ts` | Directory-page browsing (root page, folder pages and Load more by cursor, deep links beyond the first page), folder and Load more failure and Retry, failed deep-link reveal, root failure and empty listing, no deployment, Tab/Enter/Space operation (arrow, Home/End and typed keys do nothing), selection indicator, Back/Forward between documents |
| `viewer-links.spec.ts` | Fragments within and across documents (Unicode ids, named anchors, bare and unmatched hashes, replace vs push, reload), `docQuery`, and the parent-owned link confirmation: a reader's click or Enter opens at once; a link followed with no reader action is offered (confirm, dismiss, review, repeat), a visible prompt is never retargeted, forged and malformed requests do nothing, new-tab and external links |
| `viewer-chrome.spec.ts` | Theme (cycle, persistence, what the document is told and that its own colors are untouched), avatar menu, reading mode (control, shortcut, hot zones, Escape, persistence), sidebar resize (keyboard, drag, cancel, limits, viewport clamp, persistence), the phone tree drawer and More menu (focus, dismissal, one handler per action, desktop/landscape restore), 320/375/430px containment, document loading, never-arriving and replaced loads with their announcements, reduced motion, share failure notices |
| `viewer-surfaces.spec.ts` | Private vs publication vs share chrome; outsider and signed-out access; a publication's deep links, Back/Forward and scope; a share's fragments and out-of-grant links; revoked and expired shares are 404 in the shell, the document and a viewer that was open; the anonymous viewers make no session lookup. Creating, listing and revoking shares and publications is #113's and is not repeated |

Timing-sensitive steps never sleep. The loading specs install Playwright's fake clock and pause it
where the page is idle, hold the document request at the browser boundary, and then advance time by
exact amounts (14,999 ms, then 1 ms, across the 15-second deadline; 519 ms, then 1 ms, across the 520 ms
minimum row feedback). The link-confirmation specs use `trackActivation()`: it waits until the shell's
user activation has lapsed (a navigation typed into the address bar and any Playwright evaluation grant
activation) and then posts to the content frame from inside the shell, so the request carries no reader
authorization; acknowledgements are requests the shell itself makes after handling each message. The
share expiry journey uses the shortest lifetime the product allows (one minute), created when the worker
starts and polled for rather than waited out. Every test uses data provisioned for its worker.

**#169 part 2** (a Back/Forward entry that names no document) is an open product decision. The
Back/Forward test asserts the current behavior and says so: reaching such an entry changes only the URL;
the last document and its selection stay showing.

Expected failures (their broken assertions get no `e2e` credit; an unexpected pass fails the suite):

- **A closed folder's rows are still reached by Tab.** Closed folders hide their rows with
  `max-height`/`opacity` only, so they stay focusable and in the accessibility tree. Fix: `inert` (or
  `visibility: hidden`) on a closed folder's content.
- **An open folder with a full page of rows overlaps the rows after it.** Open content is capped at
  `max-height: 2000px` with visible overflow, so rows past about 60 draw over what follows. Fix: size to
  content (or use `grid-template-rows` for the animation).
- **A link to another site tells the reader nothing.** The shell refuses to frame it; Chromium replaces the
  document with a browser error page, Firefox and WebKit do nothing visible. Fix: route such links
  through the parent confirmation and open them in a new context.
- **The account menu (and More on a phone) stays open when the reader clicks in the document.** The
  document is another frame, so its clicks never reach the shell's outside-click handler. Fix: also close
  on the window's `blur` (focus moving into the frame).
- **Signing in does not return to the document the reader asked for.** The signed-out redirect keeps only
  the path, so `?doc=` is lost. Fix: carry the `doc` and `docQuery` parameters in `returnTo`.

## Comments and recovery (#115)

Three specs run the document-comment journeys on the real Worker, local Convex and the sandboxed publisher frame in all
three engines. Every person is an `actor` context (see #112/#113); documents are published through the deployment API
because the journey under test is the comment UI. `e2e/comment-helpers.ts` re-reads server state with a person's *own*
Convex JWT (never an ambient cookie), so "the server holds it" is asserted with the same functions the widget
subscribes to, and a forged request is the same call the UI would have made. Final state is asserted in the widget's
DOM, ARIA, focus and announced toasts (`role=status`/`alert`), on the server, and in a second person's open document.

| Spec | Covers |
|---|---|
| `comments-journeys.spec.ts` | Comment on a pointer text selection (chip, anchor label, empty/whitespace Enter ignored, Shift+Enter newline, focus return) and on a clicked element (comment mode, Escape, hint); a teammate's open document receives the pin live. Reply with Enter, resolve/reopen by a teammate, reply removal, empty-state messages. Delete → announced Undo → undo, then delete again → committed exactly once and live for the teammate (paused page clock). Drawer: collapsed `inert`/`aria-hidden`, counts, Arrow/Home/End views, archive from the card and unarchive from the server, drawer stays inside the viewport. Older threads/replies on demand and the "new comment" prompt while scrolled away |
| `comments-permissions.spec.ts` | The controls each of owner, admin and two members is offered (thread and reply level) and the forged request each refusal maps to (`forbidden`, nothing changed); an admin demoted/removed while the drawer is open loses controls without a reload and is refused as `not_found`; an outsider (other organization) and an anonymous caller refused (`not_found`/`unauthenticated`) and a private share and a public publication carry no widget at all; the write limit (below) |
| `comments-recovery.spec.ts` | Signing out in another tab (signed-out notice, draft kept in user-bound storage, restored after sign-in, never shown to a different account); a revoked session found on focus; a connection replaced mid-mutation (request committed, answer lost, reload → "outcome unknown" alert, resubmit reuses the operation: one thread, same `clientOperationId`); a redeploy that rewrites the document (orphaned anchors listed, pins hidden, locate explains itself, orphaned thread still answerable and resolvable) |

Timing. The widget's undo window, quota countdown and toast exits run on the page clock, which the tests install and
pause once the widget is ready, advancing it explicitly (#174). The server's rate-limit bucket refills in **real** time
and the widget's request is the thing being refused, so the test holds the page's outgoing WebSocket messages
(`convexSocket(page).hold`) while it empties the bucket through the API (one write at a time: concurrent writers
conflict with each other rather than with the limit) and releases them when the next token is more than a second away. The
refusal therefore never depends on winning a race for a refilled token. The retry after the notice ends is a person
trying again: a retry that arrives before the server's refill is refused with a fresh notice, and the test tries again.
Nothing sleeps for a fixed time; every wait is on a readiness signal (`aria-busy`, subscribed pins, a server read).

Not supported by the product, so not tested: a read-only "viewer" role (organization roles are owner/admin/member and the
only page that mounts the widget always grants write; a reader who cannot comment is an anonymous share or public
visitor, who gets no widget). Not asserted here (covered by the Chromium browser tests, or
not at all, and not credited): toolbar drag/clamp and tooltips, mobile widths, duplicate-submit blocking, comment
validation messages other than empty text, archive/delete failure rollbacks, pagination errors, sign-out racing a pending
moderation. No product bug is pinned by this suite.

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
A third `timing` project (`groupOrder: 2`, serial) holds `tests/share-budget.test.ts`, whose
CPU-time ratio assertions drifted when parallel unit workers (esbuild builds, tsx
children) shared the cores; it now runs alone after the browser project.
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
  them (`settleRequests` in `management-page-access.test.ts`) instead of sleeping
  a fixed interval, and drain them before closing the DOM window.
- **Do not depend on pointer delivery right after a navigation** when the click is
  incidental to the test: Firefox can drop it under load. Submit with the keyboard
  and wait for the visible confirmation (`requestPasswordReset`).
- **Measure CPU, not wall time, and reduce noise structurally.** The share-budget
  matrix reports process CPU time, takes the median of three identical samples for
  the scaling comparison, and keeps the absolute ceiling on the slowest sample.
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
suite once per engine with retries disabled (`E2E_RETRIES=0`).

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
and uploads the Vitest/merged summaries and counters, browser shards and LCOV,
including on failure. The raw `coverage/coverage-final.json` remains available
even when a test or merge failure prevents the merged report from being written.
`pnpm verify` keeps its existing 15-minute CI budget: the audit's full
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

Management bundle fixture builds map to generated test source. Their returned
controller strings, other inline management/auth/theme controllers, and
publisher HTML scripts do **not** receive authored-module coverage here:
extraction and genuine source maps belong to #105/#106. These boundaries must
not be mistaken for full coverage of rendered controllers.

### Subprocess coverage (CLI, server, scripts)

Tests that spawn Node run the repository's own code outside Vitest's collector:
the CLI (tsx source and an esbuild bundle), the Node server and the `scripts/`
entry points. `pnpm coverage` sets `RENDRO_SUBPROCESS_COVERAGE_DIR`
(`coverage/subprocess`); a test that spawns passes `subprocessEnv(env)` from
`tests/helpers/subprocess-coverage.ts` to the child (and `subprocessArgs()` before
the entry for a server that SIGTERM stops, so it exits normally and writes its
dump). Each call creates its own receipt directory `raw/<suite>-<uuid>` as that
child's `NODE_V8_COVERAGE`, strictly under the coverage output and never in the
repository tree. Without the variable the helpers do nothing, so plain
`pnpm test` runs are unchanged. Test-built CLI bundles use `buildCliBundle`, the
`scripts/build-cli.mjs` options plus inline source maps and no tree-shaking, and
register the bundle text, because the scratch file is deleted before conversion.
A scratch bundle built any other way (a production-style bundle) must run
without the collector.

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
- **Registered bundles** map through their inline source map back to `cli/` and
  `shared/`.
- **Plain `.js`/`.mjs`** (the QA runners) run unmodified.

The converted maps are re-keyed onto the gate's canonical maps because tsx and
bundles re-print code (esbuild's `__name` helpers, `_default` export bindings,
spans moved by wrapping). A hit that cannot be paired with exactly one canonical
entry is an error, never a guess. The vitest report is aligned the same way for
files that a subprocess also covers; a file Vitest listed without executing is
replaced by its zero map.

The run fails closed: the suites that call the helpers (found by scanning for
`subprocessEnv(`/`captureCliPush(`) must each leave a receipt; a receipt with no
dump (a child killed before exit), one that touched no repository source, a
script that maps to authored files but was never registered, an unreproducible
tsx transform, a stale recorded source or an ambiguous pairing all stop the
merge. Raw dumps are deleted once converted, leaving
`coverage/subprocess/<suite>-<uuid>.json` shards, which `--merge-only` reuses.

Subprocesses write only to temp directories and local loopback fixtures: build
scripts run with a copied `src/` in a scratch working directory, the QA runners
see a stand-in `pnpm` as the only executable on `PATH`, and `init-minio` talks to
a loopback fake. The deliberately uninstrumented child in `share-budget.test.ts`
measures CPU time and stays outside the collector.

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
