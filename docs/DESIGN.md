# Rendro Design Language

> Last updated: 2026-07-12
> Companion docs: [PRODUCT.md](PRODUCT.md) (what Rendro is) and [TECHNICAL.md](TECHNICAL.md) (how it works). This doc is **how Rendro looks, moves, loads, and stays out of the document's way**.

## Philosophy

1. **The document is the product.** Rendro hosts publisher-owned HTML. The app chrome exists to find, frame, share, and comment on that HTML — never to restyle it.
2. **Chrome recedes; orientation stays clear.** The sidebar tree, active indicator, topbar, and comments should tell users where they are without competing with the document.
3. **Plain web over app framework.** Runtime UI is vanilla HTML/CSS/JS. No React/Vue/Svelte runtime, no animation library, no CSS-in-JS, no heavyweight component layer.
4. **Progressive enhancement first.** If `lazy-tree.js` fails, links still point to real document URLs. JavaScript enhances tree expansion, active state, cross-doc navigation, comments, theme, and share affordances.
5. **No surprise surfaces.** Publisher HTML can be light, dark, branded, or unstyled. During navigation, never flash an app-colored overlay over the iframe.
6. **Motion is feedback, not decoration.** Animate only user-caused state changes: hover, focus, active tree movement, folder expansion, document loading, menu open/close, toast confirmation.
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
| Primary | `#c2410c` | `#fb923c` | Logo, links, active indicator, loader line, accent actions |
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
| Error | `#b42318` | `#fca5a5` | Loader failure line, tree load errors |

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
| Document loading line | CSS in `src/routes/app.ts`, lifecycle in `src/lazy-tree/lazy-tree.ts` |
| Theme/share/avatar menus | inline header script in `src/routes/app.ts` |
| Sidebar resize/collapse | CSS and inline header script in `src/routes/app.ts` |
| Comment widget movement | `src/commentor/` |

Rules:

- Prefer `transform` and `opacity` for movement.
- Folder expansion may animate `max-height` because the tree is the only expanding layout surface; keep it bounded and predictable.
- Sidebar collapse may animate `width`/`margin-left` over `300ms` because it is an explicit user-triggered shell layout change; live dragging disables transitions so the pane tracks the pointer directly.
- Do not animate iframe opacity during document navigation. Full-opacity iframe prevents app-surface flashes between differently themed docs.
- Infinite animation is allowed only for active loading state. No ambient loops in chrome.
- Delays are almost always wrong. If feedback needs to wait, the interaction is too clever.

## Application shell layout

```text
┌───────────────────────────────────────────────┐
│ Topbar 56px fixed                             │
│ [panel] Rendro                          Tools │
├───────────────┬───────────────────────────────┤
│ Sidebar       │ Main / iframe area            │
│ 220-420px     │ ─ 3px loading line ─          │
│ default 280px │                               │
│ Tree          │ <iframe: publisher HTML>      │
│ collapsible   │                               │
└───────────────┴───────────────────────────────┘
```

### Topbar

Purpose: global actions, not navigation depth.

- Fixed at the top, `56px` height.
- White/dark surface with a bottom border.
- Header includes a left-panel toggle immediately before the Rendro logo. It collapses/restores the document tree without changing the current document.
- Logo uses primary color and stays visually stable across orgs.
- Right-side actions: share, theme toggle, avatar.
- Menus open near their trigger and close on outside click.
- Theme toggle cycles `system → dark → light → system`. The selected transition is a radial theme ripple from the theme button. Use View Transitions where available; fall back to a CSS `clip-path: circle()` overlay. The icon may still morph in fallback paths, but the ripple is the primary theme-change feedback. Publisher iframe content is not restyled.

Interaction spec:

| Element | Default | Hover | Active/open |
|---|---|---|---|
| Share button | Primary text, transparent bg | Container hover bg | Share menu visible |
| Icon buttons | Muted icon | Container hover bg | Icon swaps / menu visible |
| Sidebar toggle | Muted panel icon | Container hover bg | Icon swaps, sidebar collapses/restores |
| Theme toggle | Current mode icon (`brightness_auto`, `dark_mode`, `light_mode`) | Container hover bg | Radial theme ripple starts from the button |
| Avatar | Initials chip | Border/surface emphasis | Avatar menu visible |

### Sidebar tree

Purpose: file-system orientation.

- Resizable left column below the topbar. Default `280px`, minimum `220px`, maximum `420px` or viewport-constrained so the document keeps usable width.
- Mirrors object prefixes in R2.
- Folders lazy-load one level at a time.
- Large directories show `Load more`; the button may say `Loading...` while fetching the next page.
- Sticky folder headers stack by depth so users keep local context while scrolling.
- Active document is shown with background/text color plus a 4px active indicator bar.

- The resize handle sits on the sidebar/main boundary, persists the last expanded width, and restores that width after collapse.
- Collapsing hides the sidebar fully and moves the main document area to the left edge; it does not reload the iframe or clear tree state.

Tree behavior rules:

- Clicking a folder expands/collapses it; it does not load a document.
- Clicking a file updates selected tree state immediately, then starts iframe navigation.
- Do not add document-loading spinners, pulses, or progress bars to tree items.
- Do not delay active state until iframe load. Selection is a navigation acknowledgment.
- Cross-doc links inside iframe post navigation messages; the tree expands ancestors and syncs active state.

URL rules:
- Canonical selected-document URLs are `/docs/:org/:path*`. The path includes the org slug plus the stored document key.
- Tree-only app shell URLs are `/docs/:org`.
- Legacy `?doc=:org/:path` links are upgraded with `history.replaceState` before loading the document.
- Publisher HTML still streams inside the iframe from `/files/:org/:path*`; app-shell URLs and iframe stream URLs are separate ownership boundaries.
- Public share links use `/share/:token` (7-day HMAC). They bypass auth and serve raw HTML without the app shell.
- Local-only `?dev_user=email` is a one-time bootstrap for the `rendro-dev-user` cookie. Do not propagate it into document URLs or iframe URLs.

State table:

| State | Visual | Trigger |
|---|---|---|
| Default | Muted text | Tree item idle |
| Hover | Container background, primary text contrast | Pointer hover |
| Folder open | Caret rotated 90°, children visible | Folder click |
| Active file | Primary text, primary-muted bg, active indicator aligned | Selected document |
| Folder page loading | `Load more` button disabled/text change only | Fetching more children |
| Document loading | No tree-specific visual | File selected, iframe loading |
| Error | Small red inline tree error text | Tree API failure |

### Main / iframe area

Purpose: give the document the largest stable reading surface.

- Starts below the topbar and to the right of the sidebar.
- Owns the doc-loading line.
- Contains either the empty placeholder or `#content-frame`.
- Uses `overflow:hidden`; document scrolling belongs inside the iframe document when the publisher page scrolls.
- Does not inject chrome padding over the iframe. Uploaded HTML owns its own spacing.

Empty state:

- Icon well, short heading, one-sentence instruction.
- Centered in main area.
- Uses chrome tokens and dark-mode variants.
- Disappears as soon as a file is selected.

## Document navigation & loading

This is the highest-risk interaction because the app shell can be dark while the user document is light, or the reverse.

### Required loader pattern

- Loader is a **3px line** at the top of `<main>`, directly under the fixed header.
- Loader width equals iframe/main width. It never spans the sidebar.
- Loader background is transparent.
- Loader animation is a left-to-right indeterminate sweep. Dark mode may use the brighter primary-hover token and a subtle glow on the 3px bar so it remains visible on near-black chrome.
- Loader never covers, dims, fades, blurs, or masks the iframe.
- Current iframe remains `opacity: 1` while the next document loads.
- On `iframe.onload`, hide the line.
- If a stale iframe load finishes after a newer selection, ignore it.
- If the request hangs, the line becomes static error red inside the same 3px space.

Implementation contract:

| Requirement | Selector / code path |
|---|---|
| Loader element under main | `#doc-loader` child of `<main class="main">` |
| Bar element | `.doc-loader-bar` |
| Show on navigation | `showDocLoader()` in `src/lazy-tree/lazy-tree.ts` |
| Hide on iframe load | `frame.onload` guarded by `activeDocLoadId` |
| Timeout fallback | `window.setTimeout(..., 15000)` guarded by `activeDocLoadId` |
| No iframe fade | No `.content-frame.loading` / `.content-frame.ready` opacity rules |
| Cache busting | bump `/lazy-tree.js?v=N` whenever `lazy-tree.ts` behavior changes |

Rejected patterns:

- Centered spinner in the iframe area.
- Full-panel loader surface.
- Skeleton that imitates unknown publisher HTML.
- Tree-item loading pulse for document navigation.
- App dark/light overlay while an iframe changes.
- Any loader that creates a blank white or blank dark moment.

## Micro-interactions

Rendro's micro-interactions are small and functional. They make state legible.

| Surface | Interaction |
|---|---|
| Tree folder | Caret rotates over `300ms`; children expand/collapse with opacity + bounded max-height |
| Tree active item | 4px active indicator translates to selected item over `300ms` |
| Tree hover | Background/text color transition over `200ms` |
| Topbar search | Border shifts to primary on focus within `150ms` |
| Share menu | Opens at trigger, closes on outside click; copy action creates a signed public link for the current document and shows toast |
| Theme toggle | Tri-state cycle `system → dark → light`; radial ripple expands from button center over ~`520ms`, with CSS overlay fallback and no motion under reduced-motion |
| Avatar menu | Opens at avatar, shows email and sign-out action |
| Toast | Bottom-right, fades in/out, no layout movement |
| Document load | Main-width 3px line sweeps while iframe request is active |
| Sidebar resize | Boundary handle highlights on hover/focus; drag updates width directly; keyboard arrows resize in `24px` steps |
| Sidebar collapse | Header panel icon swaps; sidebar and main area transition over `300ms` |
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

State expectations:

| State | Behavior |
|---|---|
| Idle | Drawer/chrome recedes to edge |
| Selection | Show comment affordance near selection |
| Open thread | Keep selected context visible when possible |
| Drag | Drawer follows pointer without layout jank |
| Theme change | Comment UI updates; publisher document remains untouched |

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
- Theme transition overlay/ripple is allowed only for explicit theme changes. It must be `pointer-events:none`, short-lived, and never reused for document navigation.
- Do not assume publisher docs have transparent backgrounds.
- Every app menu, text, border, hover, active, loader, and toast color has a dark variant.
- Dark mode follows shadcn's neutral/zinc feel: near-black shell (`#09090b`), subtle elevated surfaces (`#18181b`), neutral borders (`#27272a`), muted text (`#a1a1aa`), and high-contrast foreground (`#fafafa`).
- Avoid the old bluish/Discord palette (`#1e1f22`, `#2b2d31`, `#2f3136`, `#383a40`) for app chrome.

Theme mismatch rule:

> If the app is dark and the document is light, or the app is light and the document is dark, switching documents must not flash the app surface over the iframe. The iframe stays fully opaque; the loading line is transparent except for its 3px moving accent.

## Reduced motion & accessibility

- Respect `prefers-reduced-motion` for loader animation and future transitions.
- Reduced motion for loader line: static full-width accent line while loading.
- Focus states must not depend on animation.
- Reduced motion for theme toggle: no radial ripple, no icon morph; theme switches instantly.
- Icon-only buttons need `aria-label` or visible text.
- Loader uses `role="progressbar"` while active and `role="status"` for timeout/error fallback.
- Sidebar resize uses a focusable `role="separator"` with `aria-orientation="vertical"`, `aria-controls`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-valuetext`.
- Sidebar splitter keyboard support: Left/Right resize by one step, Home/End move to min/max, Enter collapses/restores.
- Collapsed sidebar receives `inert` and `aria-hidden="true"` so hidden tree links leave the tab order.
- Dropdowns must remain reachable by keyboard in future iterations; current click-only menus are acceptable but should not regress.
- Active tree state cannot be color-only; the 4px indicator and active background both communicate selection.
- Error states use text or ARIA labels in addition to red color.

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
- Animating `left`, `top`, `width`, or `height` for frequently repeated interactions is banned. Exceptions: bounded tree `max-height`, and the sidebar's explicit collapse/restore transition. Live sidebar dragging must disable transitions.
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
2. **No duplicate conventions** — Reuse existing tokens, timing, menu behavior, tree state, and loader pattern.
3. **Dark parity** — Verify the chrome in light and dark mode.
4. **Theme mismatch** — If the change touches iframe navigation, test app-dark + light-doc and app-light + dark-doc behavior.
5. **Reduced motion** — Disable or simplify motion under `prefers-reduced-motion`.
6. **One action, one indicator** — Remove duplicate loaders/spinners/pulses.
7. **No tree loader for doc nav** — Tree selection is optimistic; loading belongs to main/iframe width.
8. **No iframe opacity fade** — Keep publisher HTML fully opaque during navigation.
9. **Sidebar shell changes** — Verify pointer resize, keyboard resize, collapse/restore, localStorage persistence, and dark-mode states.
10. **Theme sync** — Verify header cycle order, radial ripple or fallback, system fallback, commentor theme sync, no commentor-local theme button, and reduced-motion fallback.
11. **Cache bust assets** — If `lazy-tree.ts` or `commentor.ts` changes, rebuild assets and bump the relevant script query version.
12. **Browser-harness proof** — For UI behavior, verify in a real browser, not only by reading source.

## Definition of done

A Rendro UI change is done when:

1. The document remains the visual priority.
2. App chrome works in light and dark mode.
3. Publisher iframe content is not restyled, dimmed, or covered unexpectedly.
4. Navigation gives immediate feedback without changing doc-tree production behavior.
5. Document loading uses the 3px main-width line only.
6. Motion uses the documented durations/easing or a written exception.
7. Reduced motion has a sane outcome.
8. Keyboard/focus/ARIA states are not worse than before.
9. `pnpm build:assets` and `pnpm typecheck` pass when code changes are involved.
10. Browser-harness verifies the user-visible interaction when UI behavior changes.
