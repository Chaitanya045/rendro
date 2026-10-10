# Management navigation performance — 2026-09-15

Scope: same-organization management navigation on `dev.rendro.app`. This is a focused progressive-enhancement refactor, not a framework rewrite or production certification.

## Baseline

The sidebar used ordinary full-document navigation. Every management HTML request waited for remote session validation before the browser could receive its skeleton. The organization label was emitted as `Organization` and replaced after client data arrived.

Organization sections additionally called `set-active`, then fetched full organization data, then fetched section-specific data. Local Better Auth endpoint inspection confirmed that the team mutations already pass an explicit organization ID and independently check membership/permissions; navigation does not need to mutate the active organization.

Observed development samples (individual runs, not averages):

- People: HTML TTFB 1,358ms; `set-active` 6,934ms; organization lookup 817ms; invitations 917ms. These requests formed a sequential waterfall.
- Teams: HTML TTFB 1,149ms; first paint 1,524ms; `set-active` 810ms; organization lookup 1,321ms.
- Projects, fresh pre-change sample: HTML TTFB 1,514ms; DOM ready 1,578ms; projects and organization requests started together at 1,568ms and each took about 3,022ms.

The frontend change can make navigation acknowledgment immediate and preserve the shell. It cannot make backend data arrive instantly; server timing separates session lookup from document generation for follow-up measurement.

## Verification plan

- Stable header, organization label, sidebar and theme-control DOM across supported navigation.
- Destination skeleton inserted before awaiting the next authenticated HTML response.
- Fresh authorization on the server and fresh role resolution on destination pages; no private HTML or permission cache.
- Cancellation and stale-result guards for rapid navigation, retries and failures.
- Back/Forward, same-route retry, project tabs/hash links, full-navigation exclusions and modified clicks.
- Dialog, pending-write, unsaved-draft and one-time-secret protection.
- Desktop/mobile geometry, theme consistency and reduced-motion preservation in T3.
- Full unit/integration regression, lint, TypeScript and asset builds before DEV deployment.

## Implemented and deployed

Final DEV Worker: `ef55c76a-6c15-4ba6-9f78-4b6d34d10781` (management shell contract v2). No production deployment or git commit was made.

- Persistent header/sidebar/theme controller for the nine supported same-organization management route kinds.
- Removed section-load `set-active`. Organization/project reads start together; the header resolves independently of slower section data and unchanged labels are not rewritten.
- Captured page scopes cancel reads and guard stale successes/errors; observers and timers are released. In-flight read reuse does not cache completed permission data.
- Fresh server session validation remains in place. Cookie-authenticated HTML uses `private, no-store`; numeric `session` and `render` Server-Timing metrics contain no identity or response data.
- Pending writes/open dialogs block enhanced navigation; unsaved settings can be retained or explicitly discarded. Confirmed one-time keys are cleared from their dialog/copy closures. Onboarding retains full navigation and its existing secret warning.
- Back/Forward, project hashes, same-route retry and incompatible-response fallback are covered by executed regressions. A shell/organization/user/project mismatch never initializes the fetched route script.

### Double-loader correction

The first iteration used a generic local placeholder followed by the real SSR skeleton. The user correctly reported a visible two-stage loader. A T3 reproduction on People at 375px confirmed different skeleton node identities and a repeated `cpPageIn` animation.

The final implementation uses the same canonical headings, actions, wrappers, skeletons and page styles for SSR and immediate navigation. It preserves that exact pending DOM through authenticated HTML arrival, adds hidden dialogs, and initializes the page without recreating its initial loader. The whole-content animation is suppressed both during handoff and when data arrives; existing theme/control/dialog interactions remain shared. Retry still shows the proper destination skeleton.

Skeletons describe the actual screen structure, not unknown data values or exact live row counts.

## Verification results

- Final local gate: **296 tests across 40 files**, TypeScript, full ESLint, asset builds and diff checks passed. Tests include executed request/navigation lifecycles, role transitions, failures, canonical template parity and secret cleanup; these are not 296 browser E2E scenarios.
- T3 final-build continuity checks: **nine route kinds at actual 375px and 1280px**. API delivery was temporarily gated in memory to inspect the HTML handoff before data resolved. Every sample retained the same skeleton node identities, measured **0px geometry change**, reported `animation-name: none` at handoff/data-ready, finished loading, and had no horizontal page overflow or captured page errors. Measured immediate skeleton construction took **8–29ms** in these samples. Light and dark themes were exercised; this was not a full two-theme matrix at both widths.
- Route kinds: Workspace, Projects, People, Teams, Settings, API keys, project overview, Publications and Private shares. Canonical SSR parity tests independently compare all nine templates and URL-safe project parameter substitution.
- The live shell/header/theme nodes remained identical through navigation. One rapid-navigation probe observed zero organization-label mutations; simultaneous People → Teams → Projects calls settled `[false, false, true]` with only Projects remaining active.
- Mobile drawer closed before pending-heading focus, removed main-content inertness, and retained correct expanded state. Dialogs created after navigation opened/closed and blocked navigation while open. Project dropdown navigation and project `#deployments`, Back and Forward all worked.
- A temporary intercepted settings POST tested pending-write navigation blocking and failure recovery without changing the database. Draft text survived a refused discard and a simulated failed save. An intercepted project-read failure produced an actionable retry; retry restored the list. All fetch/confirmation fixtures were restored.
- The development HTTP role suite passed **65/65** on both the initial performance rollout and the final v2 build (owner/admin/member/outsider, role changes, tenant boundaries, native team/invitation endpoints, expired/revoked sessions). Final run `65e7af19c6d6411b` reported zero remaining fixtures and no cleanup failure; its 12 synthetic application records were removed along with the fixture auth data. User data was preserved.
- Initial final-session instrumentation on the first performance rollout measured session lookup **542ms**, render **0ms** (rounded) in one navigation sample. Other live data completion samples were about **1.1–3.4s**; immediate skeletons do not eliminate backend latency. These are development samples, not an SLA or percentile benchmark.

## Limits and follow-up

T3 screenshot capture remains unavailable. A desktop resize timed out once; the width was verified and the desktop checks were repeated after resizing succeeded. DOM geometry/identity checks are not a screenshot-based aesthetic review, physical-device certification or cross-browser certification. Existing email delivery remains unavailable, as the user reported; invitation-state permission tests do not certify email delivery.

Back/Forward restores the correct route; deep scroll restoration may remain approximate when asynchronous content grows after the initial skeleton. Further backend/session latency profiling is warranted; no framework rewrite or private-page SSG was introduced. This report does not certify the whole application as bug-free or production-ready.
