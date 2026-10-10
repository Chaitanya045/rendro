# Management content-loading optimization

DEV Worker: `d4e62d4f-f535-4498-9a4b-c7698a34e796`. Management shell/controller bundle version **8**. Convex development deployment: `deafening-beagle-38`. No production deployment, commit or push.

## Changes

- Same-organization navigation mounts public, version-matched controllers and dialog templates generated from the real SSR routes. It no longer fetches full HTML on the fast path. Initial loads remain server-rendered; missing/incompatible bundles use the existing authenticated-HTML fallback. Rebuild assets and bump the shell version whenever these controllers/templates change.
- Every scoped management GET starts its data read and a fresh minimal identity/membership check together; data is withheld until access is confirmed. A changed signed-in account is rejected and reloaded. Only concurrent access requests are deduplicated; completed permissions are not cached. Query Core continues to own data freshness, deduplication, garbage collection and targeted invalidation.
- The access endpoint returns organization identity and the current member, not the roster. Management API authorization also uses the existing indexed organization/user membership lookup instead of loading all members/teams. Every backend operation still authorizes independently. Settings now uses the minimal access response.
- Project details render independently of deployment history. History failures keep primary content visible and offer a local retry.
- People renders members before invitations finish. Invitation failures remain local to that section.
- Overview renders primary content before recent deployment. One indexed, compact recent-deployment query replaces up to six project-history requests, searches across the organization rather than just the first six projects, and omits storage keys. Invitation status updates separately.
- Publications fetch deployment choices only when pinned mode is selected. Loading, empty and retry states prevent submitting an unavailable pinned release.
- Live mobile QA found a 5px Overview overflow caused by the newly displayed commit text. Scoped flex shrinking, ellipsis and non-shrinking badges fix it while retaining full text in the DOM.
- Settings fields now use `form.elements.namedItem` rather than ambiguous form-name properties.

The deferred public controller bundle is approximately 171KB minified / 23KB gzip. It contains build-fixture templates, not real user data, permissions, secrets or HTML response caches. No React or animation library was added.

## Verification

- `pnpm verify`: **364 tests / 44 files**, TypeScript, ESLint, all asset builds and whitespace checks passed. Convex TypeScript and its dev deployment checks passed separately.
- New runtime tests exercise all nine generated controllers in a real DOM implementation, no HTML fetch, delayed access gates, revoked access, changed accounts, secondary failures, navigation cleanup and lazy pinned choices. Existing role, form, navigation/history, cache, dropdown and security suites remain passing.
- Expanded deployed permission matrix: **78/78**, run `76e2460069ad4b89`. Tests include minimal access payloads for owner/admin/member, outsider/anonymous denial, recent-deployment boundaries, expired/revoked sessions, and existing mutation restrictions. All 12 synthetic application records were removed; zero remained, no cleanup/execution failure. Backend code did not change between this run and the final frontend-only deployment.
- Final shell 8 T3 replay: **29 route samples at actual 375×812**, including all nine route kinds in both light and dark mode, plus repetitions. No overflow, timeout, captured runtime error, missing select enhancement, header/theme replacement or skeleton replacement in these samples. **Zero authenticated HTML requests** on the enhanced-navigation path.
- Live dialog navigation guard, discarded-navigation draft preservation, rapid-navigation last-destination behavior, and Back/Forward restoration passed. No application mutations were submitted. Temporary settings edits, fetch instrumentation and theme overrides were restored; QA tab was left on Projects.
- On shell 7 (same critical-path implementation), holding the live deployment-history response left project details visible while only history retained its loading state. Pinned publication choices loaded on demand and enhanced to the shared dropdown.

## Timing evidence and limitations

Pre-change shell 6 samples using 50ms polling recorded Projects 2,955ms, project details 1,624ms and Publications 1,791ms to primary content. Polling in the embedded browser can be timer-throttled, so these are approximate, not a controlled before/after benchmark.

Final shell 8 samples use DOM mutation observation rather than polling:

| Screen | Observed primary-content range | Samples |
|---|---:|---:|
| Projects | 346–543ms | 5 |
| Settings | 367–584ms | 5 |
| Publications | 393–400ms | 2 |
| Project details | 409–2,016ms | 2 |
| People | 517–961ms | 3 |
| Teams | 516–558ms | 3 |
| Overview | 598–1,020ms | 3 |
| API keys | 793–1,121ms | 4 |
| Private shares | 385–412ms | 2 |

These mix cold and cached reads and measure DOM content readiness, not frame presentation, field percentiles or an SLA. Most repeated Projects reads used only one fresh access request. Backend latency variation remains: one uncached project sample exceeded two seconds. People and API keys still have role-gated secondary reads; primary improvements do not imply every request disappeared.

## Open evidence gaps

Design-review verdict: **NEEDS WORK for full visual sign-off**, with functional/mobile layout checks passing above. T3 screenshot capture failed. Desktop resize timed out repeatedly and actual width remained 375px; no final desktop claim is made. Dialog/popup measurements during CSS transitions did not consistently settle in the embedded host (a dialog still reported its starting transform after waits), so animation-time alignment remains unverified, not passed. Native keyboard, physical devices, Firefox/Safari, throttled-network/CPU and large-data/load matrices remain open. Local dispatched-key tests are not native browser-keyboard proof.

Orca orchestration could not establish coordinator authority (`no_active_sender_terminal`); this work was performed locally, not by Sol workers. Email remains parked. See the production release gates for monitoring, rollback, CI enforcement and rollout approval requirements.
