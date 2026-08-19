# Rendro Design Language

> Last updated: 2026-07-27
> Companion docs: [PRODUCT.md](PRODUCT.md) (what Rendro is) and [TECHNICAL.md](TECHNICAL.md) (how it works). This doc is **how Rendro looks, moves, loads, and stays out of the document's way**.

## Philosophy

1. **The document is the product.** Rendro hosts publisher-owned HTML. The app chrome exists to find, frame, share, and comment on that HTML — never to restyle it.
2. **Chrome recedes; orientation stays clear.** The sidebar tree, active indicator, topbar, and comments should tell users where they are without competing with the document.
3. **Plain web over app framework.** Runtime UI is vanilla HTML/CSS/JS. No React/Vue/Svelte runtime, no animation library, no CSS-in-JS, no heavyweight component layer.
4. **Progressive enhancement first.** If `lazy-tree.js` fails, links still point to real document URLs. JavaScript enhances tree expansion, active state, cross-doc navigation, comments, theme, and share affordances.
5. **No surprise surfaces.** Publisher HTML can be light, dark, branded, or unstyled. During navigation, never flash an app-colored overlay over the iframe.
6. **Motion is feedback, not decoration.** Animate only user-caused state changes: hover, focus, active tree movement, folder expansion, document loading, menu open/close, and inline copy confirmation.
7. **Fast beats fancy.** Animations must feel immediate and stay compositor-friendly where possible. If a transition makes reading slower or causes contrast flicker, cut it.

## Visual base: Rendro chrome around publisher HTML

Rendro has two visual layers with different ownership:

| Layer | Owner | Rule |
|---|---|---|
| App chrome | Rendro | Controlled palette, typography, states, dark mode, comments, tree |
| Document iframe | Publisher | Render exactly as uploaded; do not inject global app theme or layout assumptions |

### Runtime stack

- Server-rendered HTML from Hono routes on Cloudflare Workers.
- Tailwind CDN utilities are available for small structural classes in rendered markup.
- Critical app chrome CSS lives inline in `src/routes/app.ts` so first paint has no extra stylesheet dependency.
- Tree behavior ships as `public/lazy-tree.js`, built from `src/lazy-tree/lazy-tree.ts`.
- Comment widget ships as `public/commentor.js`, built from `src/commentor/`.
- Icons: Material Symbols Outlined variable font.
- Font: Inter for app chrome. Publisher documents may use anything inside the iframe.

### Token palette

Use semantic intent, not arbitrary color picking. If a color appears in app chrome, it must have light and dark behavior.

| Token | Light | Dark | Usage |
|---|---|---|---|
| Primary | `#c2410c` | `#fb923c` | Logo, links, active indicator, document-loading shimmer, accent actions |
| Primary hover | `#9a3412` | `#fdba74` | Pressed/hovered primary controls |
| Primary muted | `#ffedd5` | `rgba(251,146,60,.16)` | Active tree item and avatar background |
| Surface | `#ffffff` | `#09090b` | Topbar, sidebar, app shell |
| Surface low | `#fafafa` | `#09090b` | Main placeholder area only; never shown as a doc-loading overlay |
| Container | `#f4f4f5` | `#18181b` | Hover states, icon wells, subtle surfaces |
| Menu | `#ffffff` | `#09090b` | Share/avatar dropdowns |
| Text primary | `#09090b` | `#fafafa` | Topbar, headings, active foreground |
| Text muted | `#71717a` | `#a1a1aa` | Secondary labels, placeholders, file metadata |
| Border | `#e4e4e7` | `#27272a` | Topbar/sidebar dividers, dropdown borders |
| Focus ring | `#c2410c` | `#fb923c` | Search focus and future focus states |
| Error | `#b42318` | `#fca5a5` | Document-load timeout tint, tree load errors |

Rules:

- Every new chrome color gets a dark-mode counterpart in the same change.
- Do not theme inside publisher documents. The iframe is an isolation boundary.
- Accent direction is **Ember / Orange**: warm, energetic, and more expressive than blue while staying readable for a documentation product.
- Avoid raw one-off hex values outside token definitions and dark-mode pairs.
- The app may darken its chrome; it must not assume the iframe document is dark.

### Typography

- App chrome font: Inter, fallback `system-ui, sans-serif`.
- Base body: `14px / 20px`, weight `400`.
- Sidebar org title: `20px / 28px`, weight `600`.
- Logo: `24px / 32px`, weight `700`.
- Buttons and labels: compact, readable, never decorative.
- Document typography belongs to the uploaded HTML. Do not normalize iframe fonts from the parent app.

### Unauthenticated landing surface

- The unauthenticated landing page is intentionally fixed to the application dark theme, regardless of OS color scheme or saved app preference.
- Use the dark chrome tokens directly: `#09090b` page, `#18181b` containers, `#27272a` borders, `#fafafa` foreground, and `#a1a1aa` supporting copy.
- Brand and primary sign-in actions use dark-theme Ember Orange: `#fb923c`, with `#fdba74` on hover and `#09090b` text.
- Lead with the product value and a real Rendro workspace image before asking the visitor to authenticate. The page order is hero, factual product proof, workflow, feature showcase, organization security, and final sign-in action.
- Header and footer navigation scroll Product, Workflow, and Security to the top of their section content without adding fragments or history entries. The section's own top padding clears the sticky header; reloads return to the hero, and legacy section fragments are removed.
- Google sign-in is available from the header, hero, security section, and final call to action through one shared JSON submit handler. The handler resets pending UI on history restoration and re-enables the actions after request failures; it must never fall back to an HTML form POST because the auth endpoint accepts only JSON.
- Desktop uses a copy/product split; tablet and mobile stack the hero and convert all primary actions to full-width `44px` targets without horizontal overflow.
- Product claims must be evidence-backed. Do not add placeholder customer logos, fabricated usage counts, fake CLI output, or features not present in the application.
- Hero entrance and viewport reveals run once with `transform` and `opacity`; hover motion stays within the `150ms`–`300ms` timing contract, and reduced-motion mode removes transforms.
- Landing viewport reveals use one native `IntersectionObserver`, reveal each target once, and unobserve it immediately. Section headers move `16px`; proof cells, cards, security rows, and the final CTA move `12px`; group staggering is capped at `180ms`.
- Content remains visible by default. The `motion-ready` class is added only after the observer and reveal targets are initialized, so disabled JavaScript, script errors, unsupported observers, reduced motion, and print output never hide content.
- Primary navigation may mark the current Product, Workflow, or Security section with a `150ms` Ember underline. Do not add scroll listeners, `requestAnimationFrame` loops, count-up numbers, simulated terminal typing, parallax, pinned sections, or replay-on-reverse reveals.

## Authenticated control plane

The management experience is a separate shell from the document viewer. It operates organizations, projects, people, credentials, deployments, publications, and shares; it never wraps or restyles publisher HTML.

### Shell and navigation

- Use one shared server-rendered shell for every authenticated management route.
- Desktop: fixed `56px` topbar, fixed `232px` organization sidebar, and a centered main column no wider than `1120px`.
- Mobile at `760px` and below: the sidebar becomes a left drawer opened from a visible **Menu** control. The scrim, `Escape`, and a selected navigation link close it. No page may create horizontal viewport overflow.
- The topbar contains the Rendro mark, organization switcher, **Open docs**, theme control, and account menu. The organization switcher returns to an explicit chooser; it must not force repeat selection during normal sign-in.
- Sidebar information architecture is stable: **Overview**, **Projects**; **People**, **Teams**, **Settings**; **API keys**. The active item uses an Ember background and left indicator so state is not communicated by color alone.
- Organization pages load the canonical organization name after authorization. IDs may appear in operational details, but placeholder slugs or domain-derived tenant labels must not drive navigation.
- Reuse neutral zinc surfaces, compact `8px`–`12px` radii, border-based hierarchy, Ember Orange intent, dark-mode counterparts, and the motion tokens below. Do not add a dashboard framework or icon package.

### Authentication and invitations

- Authentication uses a focused two-column desktop composition: factual Rendro context beside a `380px`–`440px` form. Mobile collapses to the form.
- Sign-in, sign-up, verification, recovery, reset, and account-security routes share the same fields, error region, pending state, password reveal behavior, and theme semantics.
- An invitation `returnTo` survives sign-in and sign-up. Invitation context appears before authentication, but acceptance remains a distinct authenticated decision showing organization, invited email, and role.
- Never ask an invited user to create an unrelated personal organization. After acceptance, route directly to the accepted organization.
- OAuth failure restores the initiating button without losing the current URL. Email recovery and verification responses do not reveal whether an account exists.

### First-use activation

1. Resolve organization membership after authentication.
   - Zero organizations: start organization creation.
   - One organization: open it directly.
   - Multiple organizations or an explicit switch action: show the chooser.
2. Onboard with exactly three visible steps: **Organization → Project → First deployment**.
3. Generate a project-scoped API key with `docs:read` and `docs:write` as the recommended minimum, then show the secret once.
4. Show the real CLI command and wait on actual deployment state. Do not simulate terminal typing, progress, document counts, or deployment success.
5. Replace the waiting state only when an active deployment is observed; then expose **Open documentation**.

### Management interaction patterns

- Overview shows project, member, and team counts; project release states; setup checklist; and the latest real deployment. No decorative graphs or fabricated metrics.
- Create and invite actions use focused dialogs. Destructive revoke/remove actions require an explicit confirmation and provide inline or toast completion feedback.
- People uses separate member and pending-invitation tables. Role changes apply only after server confirmation. Batch invitations preserve failures on their individual rows.
- Teams organize existing members; they do not introduce a second role model. Removing a team never implies removing organization members.
- API key rows expose name, prefix, project scope, permissions, last use, expiry, and status. Default to project scope, minimum permissions, and `90`-day expiry.
- A newly created API key is rendered once in a modal. The user must affirm that it was stored before closing; subsequent screens show only the prefix.
- Project detail keeps **Overview**, deployments, **Publications**, and **Private shares** in one project navigation context. Deployment history explains immutable releases without exposing storage keys.
- Publications distinguish tracked active releases from pinned immutable releases. Private shares expose expiry and revocation state. Both stay subordinate to the selected project.
- Tables may scroll inside their own container on narrow screens; the page itself must not overflow. Empty states state what is missing and offer one next action.

### Control-plane motion

- Page content enters once with `opacity` and at most `6px` vertical movement.
- Drawer, dialog, dropdown, toast, row insertion/removal, copy feedback, and button press use the shared `150ms`–`300ms` tokens.
- Loading uses a local skeleton or one pending control. Deployment polling uses one small state indicator; never animate the whole page.
- `prefers-reduced-motion` removes transforms, shimmer, pulse, and stagger while retaining visible state changes.

## Motion tokens

Rendro does not have a runtime motion library. These values are the canonical timing contract for CSS and vanilla JS-driven state changes.

```css
:root {
  --ease-standard: cubic-bezier(.4, 0, .2, 1);
  --ease-folder: cubic-bezier(.34, 1.56, .64, 1);
  --dur-instant: 150ms;
  --dur-fast: 200ms;
  --dur-base: 300ms;
  --dur-folder: 400ms;
  --dur-loader: 1100ms;
}
```

These custom properties are the canonical reference values, not yet emitted by the app template. Until they are added to `src/routes/app.ts`, use the exact values above in CSS; do not call `var(--ease-standard)` or `var(--dur-base)` in production code.

Current source locations:

| Interaction | Source |
|---|---|
| Tree expand/collapse | `src/lazy-tree/lazy-tree.ts`, CSS in `src/routes/app.ts` |
| Active indicator movement | CSS in `src/routes/app.ts` |
| Document loading feedback | Active tree-row CSS in `src/routes/app.ts`, lifecycle in `src/lazy-tree/lazy-tree.ts` |
| Theme/avatar menus and share copy | Inline header script in `src/routes/app.ts` |
| Sidebar resize | CSS and inline header script in `src/routes/app.ts` |
| Comment widget movement | `src/commentor/` |

Rules:

- Prefer `transform` and `opacity` for movement.
- Folder expansion may animate `max-height` because the tree is the only expanding layout surface; keep it bounded and predictable.
- Sidebar resize may animate `width`/`margin-left` over `300ms`; live dragging disables transitions so the pane tracks the pointer directly.
- Do not animate iframe opacity during document navigation. Full-opacity iframe prevents app-surface flashes between differently themed docs.
- Infinite animation is allowed only for active loading state. No ambient loops in chrome.
- Never delay document display for motion. Loading feedback may remain for the `520ms` minimum feedback window so fast loads still acknowledge the click.

## Application shell layout

```text
┌───────────────────────────────────────────────┐
│ Topbar 56px fixed                             │
│ Organization                           Tools  │
├───────────────┬───────────────────────────────┤
│ Sidebar       │ Main / iframe area            │
│ 220-420px     │                               │
│ default 280px │ <iframe: publisher HTML>      │
│ Tree          │                               │
└───────────────┴───────────────────────────────┘
```

### Topbar

Purpose: global actions, not navigation depth.

- Fixed at the top, `56px` height.
- White/dark surface with a bottom border.
- Header starts with the current organization slug; there is no sidebar collapse toggle.
- The organization label uses the primary color and stays consistent between private and public docs.
- Right-side actions: hide/show app shell, copy signed URL, theme toggle, avatar.
- Avatar menu opens near its trigger and closes on outside click. Copy feedback stays inline in the copy button.
- Hide/show app shell persists in `localStorage`; `Ctrl+Shift+H` (`Cmd+Shift+H` on macOS) toggles it from either the app shell or the focused document iframe, top/left hot zones temporarily reveal the header/sidebar while hidden, and `Escape` restores the full shell.
- Theme toggle cycles `system → dark → light → system`. Supported browsers reveal the new shell/commentor theme with a radial ripple from the theme button while the icon scrolls through `brightness_auto`, `dark_mode`, and `light_mode`. Reduced-motion and unsupported browsers switch directly. Publisher iframe content is not restyled.

Interaction spec:

| Element | Default | Hover | Active/open |
|---|---|---|---|
| Copy signed URL | Neutral bordered button with link icon | Neutral container hover bg, stronger border | Link and label scroll to a CSS spinner plus `Creating signed URL…`; success continues to the check icon plus `Signed URL copied!` |
| Icon buttons | Muted icon | Container hover bg | Icon motion / menu visible |
| Theme toggle | Current mode icon (`brightness_auto`, `dark_mode`, `light_mode`) | Container hover bg | Stabilized radial theme reveal starts; icon track scrolls vertically to the active mode |
| Avatar | Initials chip | Border/surface emphasis | Avatar menu visible |

### Sidebar tree

Purpose: file-system orientation.

- Resizable left column below the topbar. Default `280px`, minimum `220px`, maximum `420px` or viewport-constrained so the document keeps usable width.
- Mirrors object prefixes in R2.
- Folders lazy-load one level at a time.
- Large directories show `Load more`; the button may say `Loading...` while fetching the next page.
- Sticky folder headers stack by depth so users keep local context while scrolling.
- File and folder labels stay on one line and truncate with an ellipsis when the available sidebar width is insufficient; the complete name remains in the DOM.
- Active document is shown with background/text color plus a 4px active indicator bar.

- The resize handle sits on the sidebar/main boundary, persists the last width, and never collapses the sidebar.
- Full app shell hiding is controlled by the shell hide button and edge hot zones, not by the sidebar resize control.

Tree behavior rules:

- Clicking a folder expands/collapses it; it does not load a document.
- Clicking a file updates selected tree state immediately, then starts iframe navigation.
- Document loading belongs to the active file pill: animate its background and apply only the documented subtle recoil. Do not add spinners, progress bars, text shimmer, or active-indicator pulses.
- Do not delay active state until iframe load. Selection is a navigation acknowledgment.
- Cross-doc links inside iframe post navigation messages; the tree expands ancestors and syncs active state.

URL rules:
- Canonical selected-document URLs are `/docs/:org/:path*`. The path includes the org slug plus the stored document key.
- Tree-only app shell URLs are `/docs/:org`.
- Legacy `?doc=:org/:path` links are upgraded with `history.replaceState` before loading the document.
- Publisher HTML still streams inside the iframe from `/files/:org/:path*`; app-shell URLs and iframe stream URLs are separate ownership boundaries.
- Public share links use `/share/:token` (7-day HMAC). They bypass auth and serve raw HTML without the app shell.
- Local authentication uses the standard sign-in flow. Legacy `dev_user`,
  `X-Dev-User`, and `rendro-dev-user` impersonation inputs are ignored.

State table:

| State | Visual | Trigger |
|---|---|---|
| Default | Muted text | Tree item idle |
| Hover | Container background, primary text contrast | Pointer hover |
| Folder open | Caret rotated 90°, children visible | Folder click |
| Active file | Primary text, primary-muted bg, active indicator aligned | Selected document |
| Folder page loading | `Load more` button disabled/text change only | Fetching more children |
| Document loading | Active pill keeps readable text while its background shimmers left-to-right and the pill subtly recoils | File selected, iframe loading |
| Document load timeout | Static error tint on active pill | Iframe request still pending after `15s` |

### Main / iframe area

Purpose: give the document the largest stable reading surface.

- Starts below the topbar and to the right of the sidebar while the shell is visible; expands to the viewport when the shell is hidden.
- Document-loading feedback stays inside the active sidebar tree row; the main/iframe area has no loading overlay.
- Contains either the empty placeholder or `#content-frame`.
- Uses `overflow:hidden`; document scrolling belongs inside the iframe document when the publisher page scrolls.
- Does not inject chrome padding over the iframe. Uploaded HTML owns its own spacing.

Empty state:

- Icon well, short heading, one-sentence instruction.
- Centered in main area.
- Uses chrome tokens and dark-mode variants.
- Disappears as soon as a file is selected.

404 state:

- Missing routes and missing documents use a centered 404 Not Found card.
- The page works standalone and inside `#content-frame`; recovery links use `target="_top"` so iframe 404s can return to the app shell.
- Use the same neutral chrome tokens, dark-mode variants, and reduced-motion behavior as the app shell.

## Document navigation & loading

This is the highest-risk interaction because the app shell can be dark while the user document is light, or the reverse.

### Required tree feedback pattern

- The parent shell has no header-level, main-area, or iframe loading overlay.
- Clicking a document immediately selects its tree row and starts iframe navigation.
- While `html.doc-loading` is present, the active row keeps its text and icon readable while `::before` runs a warm background shimmer from left to right.
- The pill runs a synchronized, subtle recoil: `-4px` with a small horizontal squash, `+2px` settle, then rest. The 4px active indicator does not pulse.
- The current iframe remains fully opaque while the next document loads; document display is never delayed for animation.
- Loading feedback remains active for at least `520ms` so a fast iframe response does not make the acknowledgment imperceptible. Only the tree feedback is held; the loaded iframe is already visible.
- `frame.onload` clears the loading class after the remaining minimum window. A stale iframe load cannot clear a newer selection's state.
- A request still pending after `15s` replaces the shimmer with the static `html.doc-loading-error` tint on the active row.

Implementation contract:

| Requirement | Selector / code path |
|---|---|
| Feedback surface | `html.doc-loading .tree-item.active::before` |
| Background motion | `docRowShimmer` in `src/routes/app.ts` |
| Pill recoil | `docPillRecoil` in `src/routes/app.ts` |
| Show on navigation | `showDocLoader()` adds `doc-loading` in `src/lazy-tree/lazy-tree.ts` |
| Hide on iframe load | `hideDocLoader(frame, loadId)` guarded by `activeDocLoadId` |
| Minimum feedback window | `DOC_LOAD_MIN_VISIBLE_MS = 520` |
| Timeout fallback | `window.setTimeout(..., 15000)` sets `doc-loading-error` |
| No iframe fade | No `.content-frame.loading` / `.content-frame.ready` opacity rules |
| Cache busting | Rebuild assets and bump `/lazy-tree.js?v=N` whenever `lazy-tree.ts` behavior changes |
| Missing document | `/files/:org/:path*` returns the shared Broken Document Graph 404 HTML; `iframe.onload` still fires because HTTP 404 is a loaded response |

Rejected patterns:

- Header-level or fixed top loading line.
- Centered spinner or full-panel loader in the iframe area.
- Skeleton that imitates unknown publisher HTML.
- Shimmer applied to document-row text or icons.
- Loading pulse on the 4px active indicator.
- App dark/light overlay while an iframe changes.
- Any loader that creates a blank white or blank dark moment.
- Multiple simultaneous indicators for one document click.

## Micro-interactions

Rendro's micro-interactions are small and functional. They make state legible.

| Surface | Interaction |
|---|---|
| Tree folder | Caret rotates over `300ms`; children expand/collapse with opacity + bounded max-height |
| Tree active item | 4px active indicator translates to selected item over `300ms` |
| Tree hover | Background/text color transition over `200ms` |
| Topbar search | Border shifts to primary on focus within `150ms` |
| Copy signed URL | Keeps the button enabled while creating the link; scrolls the link icon to a spinner and the label to `Creating signed URL…`; ignores duplicate activation until completion; then preserves the existing check icon and `Signed URL copied!` feedback |
| Theme toggle | Tri-state cycle `system → dark → light`; stabilized radial View Transition over `520ms`; icon track scrolls vertically over `300ms`; direct switch under reduced motion or without View Transition support |
| Avatar menu | Opens at avatar, shows email and sign-out action |
| Document load | Active tree pill shimmers left-to-right and subtly recoils while the iframe request is active; the 4px indicator remains static |
| Sidebar resize | Boundary handle highlights on hover/focus; drag updates width directly; keyboard arrows resize in `24px` steps |
| Comment drawer | Edge-attached, draggable, follows parent theme |

Rules:

- Every interactive element needs hover/focus/active or open state where applicable.
- Do not add flourish to app chrome. Rendro should feel fast and reliable, not playful.
- If two indicators could describe one action, keep the more local one and remove the other.
- Motion must never block pointer interaction.

## Comments layer

The commentor is an enhancement over publisher HTML.

- Runs as vanilla JS injected into served documents.
- Uses Shadow DOM where needed to isolate comment UI from publisher CSS.
- Follows the parent app theme intent but must remain legible on arbitrary document backgrounds.
- Selection-to-comment should feel contextual: select text, affordance appears, drawer opens only when needed.
- Comment UI must never permanently cover the selected document text without a way to move/close it.
- Expanded comment content is capped at `min(60vh, 520px)`; additional comments scroll inside the list and comment cards never shrink to absorb overflow.
- When the rendered list changes height, reposition the expanded dock against its saved edge so the complete widget remains inside the viewport margin.
- Below `420px`, expansion becomes a viewport-contained bottom sheet with `16px` margins and a horizontal toolbar; the panel must also remain contained inside narrow publisher iframes.
- Toolbar controls and the keyboard-operable drag grip use `44px` targets. Pins may remain visually compact but must keep at least the WCAG 2.2 minimum target area.
- The drawer separates **Active**, **Resolved**, and **History** threads. A shared active-state surface slides between tabs while `aria-selected` updates immediately; reduced-motion mode moves it directly. Archived threads belong only in History; resolved threads remain recoverable.
- Hover, focus, and card activation connect a drawer card to its pin and document anchor. Missing anchors remain visible in the drawer with an explicit recovery message.
- Text-range anchors preserve the complete selected quote and render one contiguous highlight segment for every visual line, including selections that span inline elements. Segment geometry comes only from selected text-node glyphs, never list markers or block/list-item boxes.
- Element anchors that contain rendered text use the same glyph-based, per-line highlight as text-range anchors and show that text in the thread's quote control. Elements without rendered text fall back to a padded element-boundary highlight and the `Locate element` control.
- Quote controls retain the complete anchor text in the DOM but visually clamp the preview to two lines with an ellipsis.
- Anchor navigation scrolls only the publisher document's scrolling element. It does nothing when the anchor is already visible or the document cannot scroll, and must never move an ancestor iframe or app-shell container.
- The composer exposes **Post** and **Cancel**. `Enter` posts, `Shift+Enter` inserts a newline, and `Escape` closes the current mode or bubble.
- Mutation controls expose one local pending indicator, preserve drafts on error, and report failures through an accessible status. Delete uses a five-second **Undo** toast before the destructive mutation.
- Collapsed drawer content is `inert` and `aria-hidden`. Icon tooltips supplement accessible names through `aria-describedby`; status and error feedback use appropriate live-region semantics.

State expectations:

| State | Behavior |
|---|---|
| Idle | Drawer/chrome recedes to edge |
| Selection | Show comment affordance near selection |
| Open thread | Keep selected context visible when possible |
| Growing list | Cap panel height, preserve full card height, and scroll the comment list without moving the dock off-screen |
| Drag | Drawer follows pointer without layout jank |
| Theme change | Comment UI updates; publisher document remains untouched |
| Composer pending | Disable duplicate submission, keep one button-local indicator, then close on confirmed success or restore the draft on failure |
| Realtime arrival | Animate only newly arrived pins/cards/replies; if the reader is away from the list end, show a local `N new comments` action without moving their scroll position |
| Review filters | Active is the default; resolving moves a thread to Resolved, archiving moves it to History, and each view shows its own count and contextual empty state |
| Reduced motion | Replace smooth scrolling and positional/scale transitions with direct state changes |

## Loading & perceived speed

- Prefer no loader for sub-300ms state changes.
- Use exactly one loading indicator for one action.
- Tree pagination uses button-local loading text.
- Document navigation uses only the main-width line loader.
- Auth redirects may show browser navigation; do not add fake progress.
- Org creation/API-key creation should return a concrete result page, not a spinner page.
- Comments can show local pending state, but should not block reading.

The product promise is instant docs. Loading UI should acknowledge latency, not dramatize it.

## Dark mode rules

Dark mode applies to app chrome only.

- Persist app theme in `localStorage` under `commentor-theme` with values `"system"`, `"dark"`, or `"light"`.
- `system` follows `prefers-color-scheme`; unset storage is treated as `system`.
- Toggle by resolving the current mode and adding/removing `html.dark` on the parent page.
- Do not pass app dark mode into the iframe as a global stylesheet.
  The commentor widget is the exception: it follows the parent theme because it is Rendro chrome inside the iframe, not publisher document content.
  Parent shell sends `{ type: "rendro-theme", theme: "system" | "dark" | "light" }` to the iframe; commentor removes both host theme classes for `system` and lets its own `prefers-color-scheme` media query resolve.
  Commentor does not expose its own theme toggle.
- The radial theme View Transition must pre-clip the new root snapshot at the trigger, use `fill:"both"`, and guard overlapping completion. Do not use a solid-color overlay fallback or allow an un-clipped new snapshot frame.
- Do not assume publisher docs have transparent backgrounds.
- Every app menu, text, border, hover, active, document-loading feedback, and inline copy-feedback color has a dark variant.
- Dark mode follows shadcn's neutral/zinc feel: near-black shell (`#09090b`), subtle elevated surfaces (`#18181b`), neutral borders (`#27272a`), muted text (`#a1a1aa`), and high-contrast foreground (`#fafafa`).
- Avoid the old bluish/Discord palette (`#1e1f22`, `#2b2d31`, `#2f3136`, `#383a40`) for app chrome.

Theme mismatch rule:

> If the app is dark and the document is light, or the app is light and the document is dark, switching documents must not flash the app surface over the iframe. The iframe stays fully opaque; loading feedback remains confined to the active tree pill.

## Reduced motion & accessibility

- Respect `prefers-reduced-motion` for document-loading and future transitions.
- Reduced motion for document loading: disable pill recoil and shimmer motion; retain the static active-row background.
- Focus states must not depend on animation.
- Reduced motion for theme toggle: no radial reveal and no icon scroll; theme switches directly.
- Reduced motion for signed-link creation: icon and label rows switch instantly and the loader remains static.
- Icon-only buttons need `aria-label` or visible text.
- There is no standalone loading element with `role="progressbar"` or a live-region announcement.
- Sidebar resize uses a focusable `role="separator"` with `aria-orientation="vertical"`, `aria-controls`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-valuetext`.
- Sidebar splitter keyboard support: Left/Right resize by one step; Home/End move to min/max.
- Hidden shell state preserves full sidebar width/state, uses `aria-pressed` on the shell hide/show button, toggles with `Ctrl+Shift+H`/`Cmd+Shift+H` from the shell or focused document iframe, and restores with `Escape`.
- Dropdowns must remain reachable by keyboard in future iterations; current click-only menus are acceptable but should not regress.
- Active tree state cannot be color-only; the 4px indicator and active background both communicate selection.
- Error states use text or ARIA labels in addition to red color.
- Current `doc-loading` and `doc-loading-error` feedback is visual-only. This is a known accessibility gap, not a pattern to copy; add text or status semantics before treating it as complete accessible feedback.

## Performance rules

- No runtime UI frameworks.
- No animation libraries.
- No CSS-in-JS.
- No extra icon libraries.
- No heavy image assets for chrome.
- `lazy-tree.js` remains the only required script for document navigation enhancement.
- Avoid layout reads after writes in tree interaction code.
- Keep tree page size bounded; default lazy page size is 50.
- Compositor-friendly transitions where possible.
- Cut animation before accepting jank.

Specific bans:

- Full-screen app loader for document navigation.
- Parent-page scroll listeners for document content.
- Parent styles that normalize iframe document typography or colors.
- Animating `left`, `top`, `width`, or `height` for frequently repeated interactions is banned. Exceptions: bounded tree `max-height` and sidebar resize transitions. Live sidebar dragging must disable transitions.
- Multiple simultaneous indicators for a single click.

## Browser support

- Modern Chromium, Firefox, and Safari, last two versions.
- Cloudflare Workers runtime for server-rendered shell.
- Material Symbols variable font support required for icon rendering.
- Core document links should remain usable without app JS.
- Browser APIs used by enhancements must degrade cleanly.

## Implementation checklist

Before merging a UI change:

1. **Scope** — Does it affect app chrome, publisher iframe content, or comment UI? Keep ownership boundaries intact.
2. **No duplicate conventions** — Reuse existing tokens, timing, menu behavior, tree state, and active-row loading pattern.
3. **Dark parity** — Verify the chrome in light and dark mode.
4. **Theme mismatch** — If the change touches iframe navigation, test app-dark + light-doc and app-light + dark-doc behavior.
5. **Reduced motion** — Disable or simplify motion under `prefers-reduced-motion`.
6. **One action, one indicator** — Remove duplicate loaders, spinners, and active-indicator pulses.
7. **Tree feedback only for doc nav** — Selection is optimistic; loading motion stays on the active pill background and never on its text.
8. **No iframe opacity fade** — Keep publisher HTML fully opaque during navigation.
9. **Sidebar shell changes** — Verify pointer resize, keyboard resize, hide/show shell behavior from parent and iframe focus, hot-zone reveal, localStorage persistence, and dark-mode states.
10. **404 states** — Verify bad `/docs/...` URLs, unknown routes, and missing `/files/...` iframe loads show the Broken Document Graph page with a real `404` status where applicable.
11. **Theme sync** — Verify header cycle order, stabilized radial reveal without an initial flash, system fallback, commentor theme sync, no commentor-local theme button, overlapping switches, and reduced-motion fallback.
12. **Cache bust assets** — If `lazy-tree.ts` or `commentor.ts` changes, rebuild assets and bump the relevant script query version.
13. **Browser-harness proof** — For UI behavior, verify in a real browser, not only by reading source.
14. **Comment workflow** — Verify selection chip, explicit composer controls, mutation recovery/Undo, keyboard tab and drag behavior, collapsed `inert` state, Active/Resolved/History filters, card/pin/anchor linking, realtime arrival feedback, narrow-iframe containment, dark contrast, and reduced-motion fallback.

## Definition of done

A Rendro UI change is done when:

1. The document remains the visual priority.
2. App chrome works in light and dark mode.
3. Publisher iframe content is not restyled, dimmed, or covered unexpectedly.
4. Navigation gives immediate feedback without changing doc-tree production behavior.
5. Document loading uses the active tree-pill background only; no fixed header/main loader is present.
6. Motion uses the documented durations/easing or a written exception.
7. Reduced motion has a sane outcome.
8. Keyboard/focus/ARIA states are not worse than before.
9. `pnpm build:assets` and `pnpm typecheck` pass when code changes are involved.
10. Browser-harness verifies the user-visible interaction when UI behavior changes.
