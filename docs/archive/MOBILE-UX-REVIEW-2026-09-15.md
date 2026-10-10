# Mobile UX review and redesign

Target: dev.rendro.app. Research and visual inspection used T3's embedded browser. This is a design decision record, not a production-readiness certification.

## Diagnosis from the actual application

- At 375px, document chrome squeezes the project title between six competing controls. Several icons are ambiguous without opening them.
- The document viewport and comment list display thick native scrollbar tracks and arrow buttons.
- Management tables visually become cards below 760px but retain desktop minimum widths. The private-share card had 720px of content inside a 345px container.
- Project navigation wraps labels and can show scrollbars in both directions. The current Private shares tab starts offscreen.
- Header actions wrap to different heights. Card metadata is a long, low-hierarchy vertical list rather than an easily scanned item summary.
- The comment panel settles within its 16px margins. An intermediate animation screenshot is not evidence of a containment defect; no speculative positioning rewrite is needed.

## Research and application

| Source | Principle | Rendro decision |
|---|---|---|
| [Apple: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | Prioritize frequent actions, useful titles, and logical groups; secondary actions can use a More menu on compact screens. | Keep document navigation, a readable title, and Share immediately available. Group project return, reading mode, theme, and account controls without removing their functionality. |
| [Apple: Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | Consistent alignment, related groups, progressive disclosure, and adaptable safe areas improve hierarchy. | Use a single mobile primary action, consistent 16px gutters, aligned metadata, and compact contextual navigation. Keep Rendro's own neutral/Ember tokens; do not copy native glass treatments. |
| [Google web.dev: Responsive web design basics](https://web.dev/articles/responsive-web-design-basics) | Let content determine breakpoints; adapt layouts to available space instead of shrinking desktop arrangements or hiding essential information. | Remove desktop table minimum widths when using stacked cards. Retain all metadata and all operations. Keep desktop tables and navigation unchanged. |
| [W3C: Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) | Content should remain available at 320 CSS pixels without two-dimensional reading, except genuinely two-dimensional content. | Test at 320, 375, and 430px. Avoid page overflow and unnecessary scrolling within cards; preserve legitimate publisher code/content scrolling. |
| [W3C: Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | Pointer targets need adequate size or separation; larger important controls are preferable. | Keep Rendro's 44px mobile control contract, with a 48px native section picker. This exceeds the 24px WCAG AA minimum; it is not a claim that all WCAG criteria pass. |

These sources support interaction principles. The particular visual solution is a Rendro design judgment, not a claim that an external guideline prescribes this exact layout.

## Implementation direction

1. **Management shell:** primary action full width; secondary action quieter; panel headers stack; cards use item identity followed by aligned label/value rows. No metadata is removed.
2. **Project navigation:** a native, labeled section picker on mobile, generated from real page links. Desktop tabs remain. Without JavaScript, original links remain available. Deployment hash links retain their full destination.
3. **Document toolbar:** useful project title and fewer immediately exposed actions; accessible More menu with Escape, outside-click, and focus behavior. Desktop controls stay available.
4. **Scrolling:** remove unwanted scrollbar chrome without setting document overflow to hidden. Preserve publisher-owned nested scroll areas. Style Rendro's comment list with a thin, theme-aware scrollbar.
5. **Motion:** use the shared theme controller on every theme-aware screen, preserving the same cycle, icon motion, radial reveal, press feedback, and reduced-motion fallback. No animation libraries or new runtime framework. Keep account-security loading anchored instead of moving the whole card.

## Verification status

- The 375px management CSS preview reduced the share card from 720px scroll width to its container width with no page overflow.
- The redesigned 375px preview showed a 48px section picker, full-width primary action, and aligned metadata; card contents fit without horizontal scrolling.
- T3 can recreate/reload a page during viewport changes, discarding injected preview CSS. Preview results must not be treated as deployed or as coverage at another width.
- Deployed redesign `cea29fa5-36ac-4b68-aaa5-1d59a70547af`: document toolbar checked at 320/375px and restored desktop controls at 1280px; management cards checked at 320px dark and 430px light with no horizontal overflow. The 375px More menu fits the viewport with four 44px action rows. Escape closes it and restores focus; reading mode restores the visible mobile trigger. Theme and account actions remain available.
- Mobile interaction recording: T3 artifact `browser-recording-mu28z7ot` (More menu and reading mode). This is a browser-host artifact, not a repository file.
- Follow-up deployment `e8b75aa3-6276-48be-b1a2-1d0e9d4e25a6` standardizes native select chevrons across management forms: a vertically centered 16px image inset 12px, 40px reserved end padding, paired light/dark colors, and native forced-colors fallback. This implements the design-review requirement for consistent spacing and dark parity without replacing native select semantics or adding JavaScript dependencies.
- T3 verified Publications at 375px light (48px picker, zero page overflow), publication form select spacing, member-role controls at 320/375px (44px targets and 40px end padding), and the section picker at 320px dark. The later role-select shorthand does not override the more-specific shared end-padding rule.
- Direct project `#deployments` now selects Deployments after asynchronous navigation is rendered. The latest keyboard retry was not delivered by T3 (a narrowly scoped keydown counter stayed empty), so it is not counted as a new keyboard pass. Earlier section-picker keyboard navigation passed before the chevron-only styling change.
- The original mobile redesign gate passed 111 tests across 12 files. The current expanded gate and new shared-theme/mobile-scrollbar evidence are recorded in [RELEASE-GATE-2026-09-15.md](RELEASE-GATE-2026-09-15.md). Broader actual-OS reduced-motion and complete workflow coverage remain open; these checks are not a bug-free certification.

## Release blockers outside this visual change

- Outbound invitation/signup email is not configured, per the user. Do not send test invitations or claim these live flows pass. Sender configuration and delivery verification are production-readiness requirements.
- No second real test identity is available yet. Local identity-based permission tests provide partial evidence, not a substitute for end-to-end account/role checks.
- Broader remaining QA coverage is tracked in [QA-2026-09-15.md](QA-2026-09-15.md).
