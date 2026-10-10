# Dropdown/cache release QA

Superseded DEV deployment and navigation implementation: see [September 16 content-performance report](MANAGEMENT-CONTENT-PERFORMANCE-2026-09-16.md). The evidence below is retained as historical QA, not final shell-8 certification.

DEV candidate: `e287a7e2-07d3-4644-a385-876098676e0c`, management shell 6, select asset v3, query asset v2. No production deployment or commit.

## Implemented

- A single progressive-enhancement select component for every existing single-value selection dropdown: people roles, invitation roles, team assignment, credential scope/expiry, onboarding expiry, publication tracking/pinned deployment, and mobile project sections. Native form values and change handlers remain authoritative. Native multi-select/listboxes are not converted.
- Shared shadcn-style popup surfaces also used by account/action menus, retaining their different semantics.
- Keyboard navigation, typeahead, selected check, disabled options, validation feedback, reset, async options/role rollback, truncating trigger text, wrapped long list labels, top-layer modal popups, viewport constraints, dialog-transition repositioning, reduced motion and mobile touch sizing.
- Query Core alone owns cache freshness/deduplication/eviction. Removed custom timestamp/generation tracking. Native query identity guards stale results; known writes remove only affected queries. Unknown/authorization-changing writes remain conservative.
- Draft-safe Refresh notice for reconnect/visibility/external changes. Refresh uses existing dialog, pending-write and unsaved-change guards. No implied live subscription.
- `pnpm verify` and a read-only CI quality workflow; workflow/branch protection are not active until the local changes are committed/pushed and repository rules are configured.
- Compatible security updates: Hono 4.13.8, Node adapter 2.1.1, Wrangler 4.131.2 and patched transitives. Audit: zero critical/high, two moderate test-tool findings documented in the release-gate runbook.

## Local evidence

`pnpm verify` passed: 349 tests across 42 files, typecheck, ESLint, asset build and whitespace check. The select suite includes the actual shell observer/project-section synchronization, not just an isolated mock. Query tests cover scoped invalidation and cache isolation; refresh tests cover pending writes, open dialogs and discard guards.

Select runtime: 8,884 bytes / 3,276 bytes gzip. Query runtime: 27,239 bytes / 8,226 bytes gzip. No React runtime or animation library was introduced. Happy DOM is test-only, with external script/CSS loading disabled in the integration test; only repository-owned scripts are evaluated.

## Browser findings and limits

On the first DEV candidate, T3 checked overview, projects, people, teams, settings and API keys at 1280px: no overflow, missing enhancements, duplicate skeleton, header replacement or runtime error observed. People-role popup used the top layer, showed selected/disabled roles correctly, aligned after its opening animation and closed with a native Escape key after focus. API-key dialog popups stayed in their dialog and viewport. T3 screenshot capture failed.

Project-section testing then exposed an observer feedback loop: repeatedly assigning an unchanged native select value rebuilt the popup, retriggering shell synchronization. This was fixed with no-op property updates, asset/shell versioning and an integration regression. Early dialog-opening measurements also motivated repositioning after transition completion. These are fixes found by the live regression, not evidence that the first candidate was clean.

T3's automation host initially disconnected before a complete final-candidate replay. A replacement owned QA tab (`tab_f`) was created after the original tab stalled; no password or MFA was entered. Old early-candidate browser samples must not be presented as final-candidate certification.

### September 16 reconnect replay

T3 status, DOM evaluation, navigation and exact viewport resizing recovered. Reload confirmed `/select.js?v=3` and `/management-query.js?v=2`, with the existing authenticated session intact.

- 33 completed route samples: all nine management route kinds at 375×812 and 1280×800 in dark mode; all nine at 1280×800 in light mode; overview, projects, people, teams, settings and API keys at 375×812 in light mode. Every sample finished loading, had no horizontal document overflow, matched native-select/enhanced-trigger counts, retained the actual header node and retained the canonical skeleton through the HTML handoff. Synchronous skeleton insertion measured 5–50ms across these samples; this is not a network-completion or field-latency benchmark.
- The initial helper used the wrong theme-button selector, so its first 18 theme identity results are not evidence. The selector was corrected to `#cp-theme`, its existence verified, and theme-button identity then passed in the 15 light-mode samples. Error/unhandled-rejection listeners reported no events through the first 18 samples; no claim is made for a final aggregate after the tab reload.
- Mobile project-section popup: aligned to its trigger, viewport-contained, 44px trigger/options. Selecting Publications through the rendered option navigated successfully without the former observer loop/hang. Repeated project overview/publications/shares route checks also completed.
- Desktop People: Owner selected, Member/Admin disabled for the last owner; 40px trigger, aligned/contained popup, dark and light computed surfaces verified. Dispatched Escape closed the popup.
- Desktop API-key dialog: project scope and expiry lists aligned, remained within their modal and viewport, used 40px triggers, and Escape handler closed each popup without closing the dialog. No key was generated.
- Mobile publication dialog: 44px trigger, popup stayed within its modal and viewport. An early combined open/measure sample was transiently misaligned; a separate settled measurement showed exact alignment (trigger/popup left 35px, width 305px, 4px gap). Continuous transition-frame alignment is not certified.
- T3 screenshot capture still failed. Native key commands did not establish the intended page interaction (a `p` also appeared in the conversation); subsequent Escape checks used dispatched DOM events and must not be described as native-keyboard proof.
- Three subsequent evaluation calls failed; status/evaluation recovered, but the tab had reloaded to Overview and the temporary QA helper was gone. It was left on that page with no open dialog. The remaining mobile-light project routes/API-key popup replay, native keyboard and visual screenshot checks remain pending. No application writes were submitted during this replay.

Deployed HTTP authorization matrix on the earlier candidate passed 65/65, run `7ce8e7e155014557`. The final candidate also passed **65/65**, run `ec9d64c2b52a4a84`. Each run deleted its 12 synthetic application fixture records, with zero remaining and no cleanup error. No user records were removed.

## Open production gates

See [production release gates](../PRODUCTION-RELEASE-GATES.md). Email is parked by the user, not passed. Remaining T3 visual/mobile/keyboard checks above, Firefox/Safari/device coverage, load/field baselines, client monitoring and alert routing, restore/rollback rehearsal, CI enforcement and explicit production rollout approval remain open. No production-readiness guarantee is claimed.
