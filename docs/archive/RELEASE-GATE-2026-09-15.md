# Release gate — 2026-09-15

Status: **NOT production-approved**. Target is dev.rendro.app, tested through T3 embedded Chromium. Changes have not been promoted to the production domain. This records bounded evidence, not an assertion that every possible bug is absent.

Latest development Worker: **`258c43fd-72ba-43b6-8ec3-d29c893615a0`**. Root TypeScript, ESLint, **247 tests in 33 files**, asset builds, and diff checks passed for this UI rollout. Convex TypeScript passed in the preceding backend pass; backend sources were not changed in this UI continuation. The shared worktree baseline is `2062015`; subsequent QA changes remain uncommitted. Production was not deployed.

Latest app-wide control-state and layout fixes, 56 distinct live geometry samples, component-state evidence, and T3 limitations are recorded in [UI-CONSISTENCY-2026-09-15.md](UI-CONSISTENCY-2026-09-15.md). The earlier theme-specific follow-up below is historical context.

## Shared-control consistency follow-up

The reported theme-button inconsistency was reproduced: authentication had an orange hover border, management used a neutral bordered control, and the viewer used a smaller borderless control. A shared runtime alone had not prevented per-shell CSS drift.

- Authentication, account security, management, and public/private document shells now render the same theme-button helper and design-system appearance. It owns default, hover, focus, pressed, disabled, and reduced-motion styling. Desktop controls are 36px; mobile controls are 44px. The viewer's mobile menu uses a full-width row but retains the same colors and interaction feedback.
- Existing 150ms feedback, 300ms icon movement, and 520ms theme reveal are retained. Dialog-close and account-security actions gained missing interaction feedback; viewer toolbar/account controls gained consistent Ember focus rings and hover/pressed feedback.
- T3 compared recovery, management API keys, and the document viewer at 1280px and 375px in both light and dark themes. All five inspected state styles matched across shells (60 state samples), excluding the intentional mobile menu-row width. These were computed-style CSS pseudo-state fixtures preserving original selector specificity and rule order, not native pointer or physical-device tests. Temporary fixture rules and attributes were removed afterward.
- An actual T3 mobile theme-button click changed light to system, closed the menu, made zero instrumented fetch calls, and left zero running animations after settling. Fetch instrumentation was removed. The original system preference was restored.
- T3 resizing exposed a missed media-query notification: CSS changed but controls stayed in desktop slots. A guarded resize fallback now synchronizes only on breakpoint changes. Post-deployment desktop → 375px → desktop checks moved all four controls into/out of the menu correctly with zero horizontal overflow. An executed VM regression proves same-mode resize events do not repeat DOM moves or shell synchronization. This observation is not attributed to a physical-browser defect.
- T3 screenshot capture failed during this continuation; no new screenshot or native-keyboard pass is claimed. Earlier screenshots do not establish exhaustive current UI coverage. Broader component/state and release gates below remain open.

## Multi-user follow-up

The user authorized synthetic development users and direct fixture insertion. Four distinct native Better Auth identities were created in isolated QA organizations. Live HTTP testing found and fixed stale cached-session authorization after persisted session expiry/revocation, plus inconsistent 400 vs 403 membership-denial responses. The fix is deployed to the development Convex backend.

Latest expanded run `0cc85ed16b62463b`: **65/65 deployed HTTP assertions passed**, covering roles, team mutation restrictions, invitation acceptance/decline/expiry/cancellation/wrong recipient/repeated acceptance, foreign-project boundaries, and legacy cached/uncached session revocation. No email was sent. All temporary users, organizations, sessions, memberships, teams, invitation records, projects, credentials, and their application audit records were cleaned up. Independent read-only checks confirmed zero run-owned leftovers and zero orphan team memberships, with the original user and organization retained. See [permission QA](QA-PERMISSIONS-2026-09-15.md).

UI follow-up fixed unguarded management controls and generic permission retry states. A deployed T3 probe proved that component display styles overrode the `hidden` attribute; the shared shell now enforces semantic hiding. Role changes revert to the last confirmed selection on failure and refresh only member rows on success, preserving invite drafts and avoiding duplicate handlers. Organization error text is escaped before rendering.

Post-deployment T3 verification:

- All nine management routes at 320px/system-dark settled with no visible alert, horizontal page overflow, accidentally visible hidden control, or inspected button below 44px. Each required endpoint was requested once per settled navigation in these samples.
- Publication mode switching hides the pinned-release field for tracked mode and shows it for pinned mode. No publication was created during this check.
- At 375px/light, browser-side member presentation fixtures exercised Projects, People, Teams, Settings, Publications, Private shares, and API keys. Unauthorized controls were absent; Settings fields were disabled; People skipped invitation retrieval; API keys displayed access guidance after one organization lookup without a credential request.
- Those presentation fixtures replaced only an in-memory organization response, not database roles or authentication. Native four-user HTTP authorization was tested separately. The browser was navigated back to its normal owner view afterward.
- API-key restriction received light/dark screenshot inspection. Returning to system theme completed with no running animations left and no horizontal overflow. The original system preference and normal owner view were restored, with no open dialogs or unsaved QA drafts.
- Live browser fault injection for Settings returned a simulated 503 before any update request reached the server: the draft remained, error was visible, and Save re-enabled. No organization data changed. Empty-scope API-key submission likewise produced local validation with zero creation calls.

## Systematic management layout pass

Nine routes: organization overview, Projects, People, Teams, Settings, API keys, project detail, Publications, Private shares.

| Viewport / theme | Result | Scope of evidence |
| --- | --- | --- |
| 320px / dark | No horizontal page overflow on all nine routes | Loaded QA organization/project data; compact-button defects identified separately |
| 375px / light | No horizontal page overflow on all nine routes | Same routes; loading skeletons settled; no visible alert errors |
| 768px / light | No horizontal page overflow on all nine routes | Desktop/tablet layout; internal table scrolling is allowed |
| 1280px / light | No horizontal page overflow on all nine routes | Desktop layout; no visible alert errors |

These are geometry checks, not a claim that every route received exhaustive visual or interaction testing in every theme. Long-content, all-empty, all-error, and all-role combinations remain separate cases.

## Confirmed defects fixed in this pass

- Publication listing accepted an organization paired with a foreign project ID. The internal query now validates ownership.
- A project-scoped credential could remove a sibling project's publication by supplying its own project ID with the sibling publication ID. The mutation now matches organization, project, and publication.
- Pinned publications could point at a staging deployment. Only committed/non-failed deployments are accepted.
- A project-scoped credential could fail a different project's staging deployment. Failure now matches organization and project; committed deployments remain unaffected.
- Deployment-list internal queries now independently enforce organization ownership. The HTTP route already checked project ownership, so this particular change is defense-in-depth, not evidence of a newly discovered externally exploitable listing endpoint.
- Compact buttons on overview, project detail, and API-key pages were still 32px high. Shared mobile specificity now enforces 44px.
- Mobile navigation lacked a visible close control and allowed focus behind its scrim. Added a labeled close control, focus containment, background inertness, and desktop restoration. Navigation/account rows are also being standardized at 44px.
- Deep links selected Deployments but did not scroll to the asynchronously mounted section. Navigation now synchronizes both desktop/mobile active states and scrolls once when the target exists; later unrelated DOM updates do not jump the page.
- Password reset without a token presented a form that could never succeed. It now immediately explains the invalid link and offers recovery.
- Concurrent notifications replaced pending Undo actions; a late Undo could falsely claim to restore after the deletion request started. Independent deletion coordination and a bounded notification stack now preserve the correct state.
- Document root/folder loading errors lacked usable accessible recovery. Added Retry controls and loading/error semantics; native folder keyboard activation is supported.
- Project/public empty trees offered an invalid legacy organization-creation action. Empty states now match their context and do not offer unauthorized mutations.
- Modified file-link clicks were intercepted. Native Ctrl/Meta/Shift/Alt/middle-click behavior is preserved.
- The viewer's first main margin collapsed through its body, producing 56px of unintended parent scrolling. A flow-root body contains the margin; the publisher iframe remains the scrolling surface.
- Comment theme initialization could miss the parent's early message and fall back to a different system theme. A current-iframe-validated ready handshake initializes it explicitly.
- Narrow comment headers crowded author information and hid actions on hover-capable narrow viewports. Actions now occupy a separate, visible 44px-control row.
- Authentication switched themes instantly while other shells had separate animation engines. A shared controller now owns initialization, the system/dark/light cycle, icon/radial motion, accessible next-action labels, cross-tab synchronization, system changes, and reduced-motion fallback. Stale transition callbacks cannot overwrite newer choices, and completed/canceled animations are released.
- Account Security still had a thick mobile viewport scrollbar and moved its heading when async sign-in methods arrived. Shared app-owned viewport styling preserves scrolling without mobile scrollbar chrome; the security card is top-aligned during loading and completion.
- Unexpected worker exceptions exposed implementation messages. External responses are now generic; diagnostics remain server-side. Malformed stored manifest shapes fail closed before document object reads. Upload bodies are read only to the declared manifest size and canceled immediately on overflow.

## Live workflow evidence added

- Created the temporary `qa-public-release-20260915` publication through its form; confirmed public shell and document return 200 without credentials and missing asset returns 404. Public viewer rendered the fixture and document tree.
- Removed that exact temporary publication; shell, file, and tree all returned 404 without credentials. The management empty state returned. No temporary public exposure remains.
- Deployed 320px deep link: Deployments selected and active, target visible after automatic scrolling; Copy target measured 44px.
- Deployed 320px drawer: close control 44×44, background inert, focus starts at Close, Shift+Tab wraps to API keys, Tab wraps to Close, Escape closes and restores Menu focus.
- Deployed 320px overview/API-key follow-up: previously small controls no longer measured below 44px.
- Deployed missing-token reset page at 320px: no password fields, immediate recovery link, no page overflow.
- Deployed viewer flow-root fix: document scrollHeight equals the 812px viewport, iframe starts at 56px, and attempting to scroll the outer window does not move it. Publisher document scrolling remains separate.
- Deployed mobile comment header: author, timestamp, and Close share the first row; secondary actions remain visible in their own row with 44px targets.
- Independent T3 clients: a new reply arrived in the first tab while its unsent draft remained intact; submitting from the second tab cleared only that tab's submitted draft.
- Deleted the QA thread and immediately used Undo; a reload restored the thread and its reply. Late Undo and rejected-delete recovery are covered locally, not live fault injection.
- Shared-theme deployment `77dec01d-7a03-4e37-8835-4e7f2f8a4221`: T3 instrumented management, account security, recovery, and document shell switches; observed the 520ms root reveal and 300ms icon track with zero toggle-triggered fetch calls. Cross-tab synchronization, system light/dark changes, explicit dark preservation, and rapid three-toggle final-state handling passed.
- Theme geometry inspected at 320/375/768/1280px across representative management/auth/viewer layouts: zero horizontal overflow; visible mobile theme controls at least 44px; 20px icon windows vertically centered. This is representative coverage, not every route/device permutation.
- Open comment chrome followed both dark and light shell choices while the light publisher document stayed light. Document shell still had a single initial auth-token request and no extra token request from theme toggles.
- Mobile viewport deployment `577f176c-7a85-4eaf-b085-3a5e3dd9d94f`: Account Security at 375px used all 375px, root scrollbar was hidden, document remained scrollable, and scrolling reached the footer. Anonymous landing response included the same viewport CSS while remaining fixed dark with no theme runtime.
- Follow-up security loading verification: sampled pending through loaded state; card top remained exactly 80px at 375px viewport and 112px at 1280px. No heading/card jump occurred in those samples.
- Final deployment: computed theme button transitions on management, authentication, and document shells all use 150ms with the same cubic-bezier easing. Pointer and Enter activation completed correctly; no finished radial animations remained in `document.getAnimations()` after settling. Original system preference was restored through the toggle.

## Automated evidence

Latest full local gate: **247 tests across 33 files**, root TypeScript, ESLint, asset builds, and diff integrity checks passed. Convex TypeScript passed in the preceding backend pass. These include unit, VM runtime, HTTP, and Convex integration tests; they are not 247 browser E2E scenarios. New runtime coverage includes member/owner/admin/missing membership on project/publication/share screens, downgrade transitions, role-update failure and success handling, invitation-draft preservation, partial invitation failure, Settings/team failure recovery, native legacy-cookie revocation, breakpoint-only mobile-toolbar synchronization, and repeat/rejected copy recovery. Shared theme and control-state checks cover the rendering shells, with separate comment-widget and responsive-layout regressions.

Runtime tests now cover real authorization decisions for owner/admin/member/outsider/anonymous; project/org publication and deployment isolation; denied public paths before storage reads; publication revocation; independent Undo timers, late Undo denial, rejected deletion restoration; section navigation and asynchronous target mounting; drawer inertness/focus restoration; contextual empty states; native modified-link behavior; theme-ready messaging. CSS/source checks supplement these where geometry needs a browser.

Theme-specific runtime tests additionally cover missing preference fallback, normal and rapid mode cycles, storage/system notifications, unsupported or rejected View Transitions, reduced-motion interruption, stale callback invalidation, controller destruction, and release of completed radial animations. Route tests assert one shared runtime across auth, management, public/private viewers, and passive error screens. The fixed-dark landing page includes only shared viewport styling.

The role model is owner/admin/member. There is no viewer role; no new role or authentication bypass was introduced for QA.

## Unresolved release gates

1. **Email delivery:** user confirmed no outbound sender is configured. Verification, recovery delivery, and invitations cannot be certified. Requires an authorized sender/provider configuration and a verifiable inbox; no test invitations were sent.
2. **Interactive identity flows:** live synthetic multi-user permissions and seeded invitation processing now pass. Real password/OAuth sign-in, inbox verification, and independently signed-in role-specific browser sessions remain distinct, unverified gates. Synthetic fixture creation intentionally bypassed email verification only for disposable development users, with explicit user authorization.
3. **Remaining browser coverage:** rejected/late Delete/Undo browser fault injection, reduced-motion OS behavior, deeper pagination/failure injection, all populated/empty/error combinations, and Firefox/Safari are not yet complete. T3 viewport resizing is Chromium layout emulation, not a physical-device or cross-browser certification.
4. **Performance confidence:** request-count observations are useful but are not statistically stable field INP/LCP data or a load test.

The original fixture organization/project remains for repeatable testing. Its earlier temporary API keys are revoked; the new isolated permission-run keys were removed during cleanup. Subsequent QA code changes remain uncommitted in the shared worktree; unrelated user changes are preserved.
