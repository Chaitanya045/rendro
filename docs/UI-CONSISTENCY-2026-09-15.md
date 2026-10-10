# UI consistency audit — 2026-09-15

Target: dev.rendro.app, using only T3 embedded Chromium. Final development Worker: `258c43fd-72ba-43b6-8ec3-d29c893615a0`. No production promotion or commit was made. Existing unrelated worktree changes were preserved.

## Findings and fixes

- Viewer Back border was erased by the generic button rule. Toolbar controls now align at 36px desktop / 44px mobile; long titles truncate instead of wrapping beyond the 56px header. A temporary long-title presentation fixture reproduced a 128px title at 768px before the fix; post-deploy desktop title height is 32px.
- Viewer account rows lacked transitions and mobile target sizing. They now match management rows: 14px/20px type, 20px icons, neutral hover, Ember 2px focus outline, `.98` press, and 44px mobile targets. A live state probe caught a general management focus selector overriding the component's no-shadow rule; the final follow-up fixes that cascade.
- Tree Retry / Load more had no complete base style. Added light/dark, focus, disabled, pressed, and reduced-motion states. Mobile rows and sticky offsets share a 44px row token.
- Project tabs had repeated page-local styles. A shared renderer/style now supplies the same links and states. The old underline extended below its link, producing clientHeight 39 / scrollHeight 40; the new inside-link underline has zero vertical overflow.
- Disabled management/auth/comment controls could still acquire enabled hover or pressed feedback. Gated those states; invalid form fields retain error styling on focus/hover. Password reveal and security actions share the standard easing and press feedback.
- Account Security footer links measured 15px high on mobile. They now have 44px mobile targets; the brand also has a 44px header target.
- Management copy actions now share pending, confirmation, failure recovery, and duplicate-click suppression. A repeated copy failure no longer leaves a stale “Copied” label. Onboarding uses the same helper.
- Invitation-row removal / Add another and team Add member controls now communicate when their action would be a no-op. No invitations were sent or memberships changed during this UI pass.
- Comment filters, CTAs, card actions, quote/locate controls, reply/composer actions, and toast controls now have complete feedback and disabled states. Ordinary presses use `.98`; reduced motion removes scaling while preserving structural translations. The 44px mobile contract applies through 760px, not only 419px. Rebuilt the widget and bumped both document-route script references to `commentor.js?v=33`.
- Landing remains fixed dark; its disabled hover/press states were corrected. Standalone 404 controls received matching disabled/reduced-motion handling. No runtime dependency was added.

## Verification

- Full gate: **247 tests across 33 files**, root TypeScript, ESLint, asset builds, and diff checks pass. These are unit, integration, and executed-VM tests, not 247 browser E2E scenarios.
- **56 distinct geometry samples:** 14 routes × actual 375px / 1280px × light / dark. Routes: overview, Projects, People, Teams, Settings, API keys, project detail, Publications, Private shares, Account Security, recovery, missing-token reset, verification, and 404. No horizontal page overflow, undersized inspected mobile button/field/control, or vertical project-tab overflow in these samples. Hidden, inert, and inline prose links were excluded from the target scan.
- T3 initially reset the requested desktop viewport on navigation; those duplicate 375px samples were not counted as desktop coverage. The desktop pass was repeated with resize after navigation and `innerWidth === 1280` verified for every page.
- Browser computed-state fixtures preserved original CSS selector specificity and source order. Management/viewer account hover, focus, pressed styling and geometry now match in light and dark; final focus has one outline and no duplicate shadow. Auth primary/security/reveal controls and comment toolbar/filter/empty CTA passed enabled-state and disabled-hover checks. These fixtures are not native pointer/keyboard certification.
- Actual rendered project-copy handler with a temporary in-memory clipboard stub: pending disabled + aria-busy, duplicate activation caused one write, success showed Copied, second-write rejection restored Copy and re-enabled the control. The real clipboard was not read or written; the stub was restored.
- Comment widget loaded version 33. In its real Shadow DOM, light/dark state fixtures passed. Temporarily enabling its reduced-motion CSS rule removed all tested button press transforms and transitions; original media rules and host classes were restored. This is CSS-rule verification, not an OS setting change.
- Publication dialog at 375px before rollout was contained and its existing fields/actions measured 44px; no publication was submitted. Changed shared field states also have regression coverage.

## Evidence limits

T3 screenshot capture failed throughout this continuation. Later, freeform and preset resizing began timing out while navigation/DOM evaluation remained usable. Post-deploy 768px/430px viewer and narrow comment-widget visual rechecks therefore remain open; failed resize attempts were not counted as mobile passes. Earlier mobile management/auth geometry succeeded, and mobile CSS/source regressions pass, but they do not replace those remaining live checks. Sign-in/MFA/password entry, email delivery, production traffic, and cross-browser/physical-device certification were not performed here. This report is not a bug-free or production-ready certification.
