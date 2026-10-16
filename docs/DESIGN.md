# Rendro Design Language

> Last updated: 2026-10-10
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
- The document viewer (`src/routes/app.ts`) loads Tailwind CDN utilities for small structural classes; the management, auth, landing, and 404 surfaces use inline CSS only.
- Critical app chrome CSS lives inline in the route templates so first paint has no extra stylesheet dependency.
- Tree behavior ships as `public/lazy-tree.js`, built from `src/lazy-tree/lazy-tree.ts`.
- Comment widget ships as `public/commentor.js` (built from `src/commentor/commentor.ts`); the viewer-side comment bridge ships as `public/commentor-parent.js` (built from `src/commentor/parent-entry.ts`). Both are gitignored build outputs.
- Management controllers and shared browser components ship as the committed bundles `public/management-pages.js`, `public/management-query.js`, and `public/select.js`. `pnpm build:assets` regenerates every bundle; `pnpm verify:assets` fails if a committed bundle is stale.
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
| Text muted | `#71717a` | `#a1a1aa` | Secondary labels, placeholders, file metadata on white/near-black surfaces |
| Text muted strong | `#52525b` | `#a1a1aa` | Small secondary text and neutral badges on container or hovered surfaces (`--cp-muted-strong`) |
| Border | `#e4e4e7` | `#27272a` | Topbar/sidebar dividers, dropdown borders |
| Focus ring | `#c2410c` | `#fb923c` | Search focus and future focus states |
| Error | `#b42318` | `#fca5a5` | Document-load timeout tint, tree load errors |
| Danger solid | `#b42318` + white text | `#f87171` + `#09090b` text | Confirm button in destructive dialogs |

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
- Wordmark: "Rendro" in the primary text color followed by an Ember-colored dot, `24px / 32px`, weight `700` (`20px / 28px` at `760px` and below). Landing, authentication, 404, and the management shell all use this same mark. The document viewer instead shows the organization/project title in the primary color as its `h1`.
- Buttons and labels: compact, readable, never decorative.
- Document typography belongs to the uploaded HTML. Do not normalize iframe fonts from the parent app.

### Unauthenticated landing surface

- The unauthenticated landing page uses the same saved light/dark/system preference as authentication, management, and viewer chrome. Initialize the shared runtime in the head before content paints; never force dark or overwrite a visitor's preference on navigation.
- Use paired light/dark chrome tokens, including the sticky header, screenshot caption, shadows, and primary-action foreground. The product screenshot remains an authored image, not a themeable application surface.
- Small secondary copy must maintain at least 4.5:1 contrast against normal and hovered cards. Use the darker zinc secondary token on light elevated surfaces rather than carrying white-surface muted text unchanged.
- The header keeps a compact **Sign in** link at every width next to **Get started**, so returning visitors never have to go through sign-up.
- The header includes the shared theme control with the same tri-state cycle, micro-interactions, keyboard focus, and mobile target size as other screens.
- Lead with the product value and a real Rendro workspace image before asking the visitor to authenticate. The page order is hero, factual product proof, workflow, feature showcase, organization security, and final sign-in action.
- Header and footer navigation scroll Product, Workflow, and Security to the top of their section content without adding fragments or history entries. The section's own top padding clears the sticky header; reloads return to the hero, and legacy section fragments are removed.
- Google sign-in is available from the header, hero, security section, and final call to action through one shared JSON submit handler. The handler resets pending UI on history restoration and re-enables the actions after request failures, showing an explanation (with an email sign-in link) in a `role="alert"` region next to the clicked button rather than only relabeling it; it must never fall back to an HTML form POST because the auth endpoint accepts only JSON.
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
- Same-organization management navigation progressively enhances links: keep the topbar, organization identity, sidebar and shared theme controller mounted, and replace only the main content. Insert the destination skeleton locally, then mount the version-matched public controller/template bundle generated from the SSR routes. Start fresh access and data reads together; never release data to the controller until the current account and organization membership are verified. Missing/incompatible bundles retain the authenticated-HTML fallback. First loads remain server-rendered; this is not static generation or caching of personalized pages.
- Keep account, authentication, onboarding, organization switching, document viewing, modified clicks and unsupported routes on full browser navigation. Enhanced navigation must preserve history/hash behavior and fall back to full navigation for an incompatible shell or authentication redirect.
- Each management page owns an abortable request scope. Disposing it cancels reads and releases observers/listeners; stale successes and failures cannot paint a later page. Deduplicate in-flight reads. The user-approved TanStack Query Core exception caches only project lists/details, deployment lists and publication lists in memory (30-second freshness, five-minute inactive retention), keyed by user, organization, endpoint and project. TanStack owns freshness, deduplication and garbage collection; do not duplicate its timestamps or storage. Retained data additionally requires fresh organization membership. Never cache permission-bearing responses, credentials, invitation data, private shares, secrets or authenticated HTML. Known writes remove only affected native queries before and after settlement, including uncertain failures; authorization-changing and unknown writes invalidate conservatively. Cross-tab invalidations carry only resource/organization/project identity. Session failure and page exit clear the cache. Resumed visibility and reconnect mark data stale without aborting an initial read or replacing form drafts. A Refresh notice lets users explicitly reload the screen through existing pending-write, dialog and unsaved-change guards. These are snapshots, not live subscriptions. Explicit organization-scoped navigation must not mutate the active organization.
- Pending writes and open dialogs block enhanced navigation. Unsaved settings offer a discard confirmation; one-time secrets must be confirmed before leaving and cleared from their dialog and copy handlers after completion.
- Desktop: fixed `56px` topbar, fixed `232px` organization sidebar, and a centered main column no wider than `1120px`.
- Mobile at `760px` and below: the sidebar becomes a left drawer opened from a visible **Menu** control. The drawer header carries the organization mark and name, a **Switch organization** link, and the gated docs link, because the topbar collapses them. The scrim, `Escape`, and a selected navigation link close it. No page may create horizontal viewport overflow.
- Project sections (Overview, Deployments, Publications, Private shares) render as tabs on desktop and as a labelled native project-section picker on mobile, built from the real section links and upgraded by the shared select component; the links keep working without JavaScript.
- The topbar contains the Rendro mark, organization switcher, **Open docs**, theme control, and account menu. **Open docs** appears only on project screens once the project has an active deployment; it is hidden on organization-level and chooser screens. The organization switcher is omitted entirely when no organization is selected (chooser, invitation). The organization button opens an in-place navigation menu with a current-organization checkmark; selecting another organization preserves the active sidebar section (Overview, Projects, People, Teams, Settings, or API keys). Project-detail sections fall back to the destination organization's Projects screen because project IDs are organization-specific. The switcher and chooser share user-scoped TanStack Query Core display data (ID/name/slug only). TanStack's per-query persister keeps that sanitized list in tab-local session storage across full-page organization navigation; time, visibility, reconnect and page exit do not make it stale. Organization creation, rename, deletion and membership changes invalidate it locally and across tabs; sign-out or authorization failure clears it. Cached labels never authorize access. Reopening a fresh menu or switching organizations must not issue another list request unless an invalidating change occurred. It reuses shared popup surface tokens, supports keyboard navigation and dismissal, and provides local loading/error/retry states. The chooser remains an explicit Manage organizations action and no-JavaScript fallback. The Rendro mark returns to the current organization's overview (or organizations when no organization is selected).
- Sidebar information architecture is stable: **Overview**, **Projects**; **People**, **Teams**, **Settings**; **API keys**. The active item uses an Ember background and left indicator so state is not communicated by color alone.
- Organization pages load the canonical organization name after authorization. IDs may appear in operational details, but placeholder slugs or domain-derived tenant labels must not drive navigation.
- Organization switching updates the source header label and mark immediately, then carries the selected display name as a one-use, tab-local navigation hint bound to the signed-in user and destination organization and discarded after sixty seconds. Apply it inline beside the destination header before external scripts so the name does not flash back to “Organization.” This is navigation presentation only, not persisted TanStack data or authorization. If a route-leave guard rejects or navigation fails, restore the previous source label and clear the hint; the normal authorized response may reconcile a renamed organization. Missing/blocked storage falls back safely to the normal loading behavior.
- Reuse neutral zinc surfaces, compact `8px`–`12px` radii, border-based hierarchy, Ember Orange intent, dark-mode counterparts, and the motion tokens below. Do not add a dashboard framework or icon package.

### Authentication and invitations

- Auth and management chrome honor `hidden` ahead of layout styles. A completed sign-up hides email and Google controls and focuses the labelled confirmation; password-reset success does the same for its form. Returning through the sign-in/create-account links restores the ready form.
- Authentication uses a focused two-column desktop composition: factual Rendro context beside a `380px`–`440px` form. Mobile collapses to the form.
- Sign-in, sign-up, verification, recovery, reset, and account-security routes share the same fields, error region, pending state, password reveal behavior, and theme semantics. Their dark tokens match the shell (`#09090b` surface, `#18181b` secondary surface, `#27272a` border), and the form `h1` precedes the context `h2` in DOM order.
- Account security load failures show a stacked title and one plain-language message with a retry action; never surface raw error text.
- An invitation `returnTo` survives sign-in and sign-up. Invitation context appears before authentication, but acceptance remains a distinct authenticated decision showing organization, invited email, and role.
- Never ask an invited user to create an unrelated personal organization. After acceptance, route directly to the accepted organization.
- OAuth failure restores the initiating button without losing the current URL. Email recovery and verification responses do not reveal whether an account exists.

### First-use activation

1. Resolve organization membership after authentication.
   - Zero organizations: start organization creation.
   - One organization: open it directly.
   - Multiple organizations or an explicit switch action: show the chooser.
2. Onboard with exactly three visible steps: **Organization → Project → First deployment**.
3. Generate a project-scoped API key with **Read deployments** (`docs:read`) and **Push documentation** (`docs:write`) as the recommended minimum, then show the secret once.
4. Show the real CLI command (the same pinned `npx --yes rendro@<version> push` command used on project pages and in the README, from one shared builder) and wait on actual deployment state. Do not simulate terminal typing, progress, document counts, or deployment success.
5. Replace the waiting state only when an active deployment is observed; then expose **Open documentation**.

### Management interaction patterns

- Every single-value selection dropdown uses the progressive-enhancement component in `src/ui/select.ts`. Retain the native select for form values, validation, no-JavaScript fallback and existing change handlers. Use a shared shadcn-style trigger/listbox/checkmark, neutral popup surface, 40px desktop/44px mobile triggers, keyboard typeahead, Arrow/Home/End/Page keys, Enter/Space/Tab commit and Escape cancellation. Native multi-select/listbox controls remain native. Popups stay in their modal's active tree, use the top layer when supported, constrain themselves to the viewport, and reposition after dialog transitions. Do not rebuild options for unchanged property writes: the management shell also observes and synchronizes the DOM. Selection lists and action menus share popup surface tokens in `src/ui/menu-styles.ts` but retain their distinct semantics.
- Overview shows project, member, and team counts; project release states; setup checklist; and the latest real deployment. No decorative graphs or fabricated metrics.
- Pending dialog writes keep Cancel, Close, backdrop and Escape from dismissing the form until the request settles. Success and failure restore the submit control; reopening must permit another submission without reloading the page. Successful invitations initialize a fresh row before closing; an arriving list refresh preserves any reopened draft. Inline creation and invitation-response forms stay disabled after success with a logical guard against duplicate submission, clear their busy indicator, and show a polite completion message with a focusable Continue link before navigating. The link remains available when navigation is stopped or the completed document is restored. A committed 500 navigation replaces that document with a styled error page; Try again retries the destination with a GET and does not repeat the successful write.
- Create and invite actions use focused dialogs. Destructive revoke/remove actions require an explicit confirmation through the shared themed confirm dialog in `src/ui/management-ui.ts` (danger confirm button, `Escape`/backdrop cancel, focus returns to the trigger), never native `confirm()`. The only exception is a navigation guard that must answer synchronously (discarding unsaved settings). Completion feedback is inline or a toast.
- Statuses, roles, release states, and permission names come from the shared label map in `src/ui/management-ui.ts` and render in title case; never print raw enum values such as `superseded` or `docs:read`. Permission labels are **Read deployments**, **Push documentation**, **Read publications**, and **Manage publications**; checkbox groups use `fieldset`/`legend`.
- Rows lead with a human label (name or date). IDs are secondary: monospace, truncated with an ellipsis, full value in `title`, and a copy button where users need the value (project ID, active deployment). Do not repeat the same ID in two columns.
- Copy is role-aware: members are never told to perform an action their role cannot perform, and restricted messages render outside, not inside, an empty table.
- Toasts announce through the single polite live region only; individual toasts do not add their own `role`.
- People uses separate member and pending-invitation tables, both with a trailing **Actions** column; the current user's row carries a **You** badge. Role changes apply only after server confirmation. Batch invitations preserve failures on their individual rows.
- Teams organize existing members; they do not introduce a second role model. Managers can expand a team roster on demand (the **View members** toggle sits above the team's destructive footer), add members, and remove individual memberships with confirmation. Roster reads use bounded Convex cursor pages, never the unsupported Better Auth offset adapter. Removing a team or team membership never implies removing organization members.
- People exposes confirmed organization-member removal only where the current role allows it; the current user and sole owner are protected. Role changes and removals update counts and controls only after server confirmation. Organization contexts at the auth join's 100-member boundary complete their roster through fresh cursor reads rather than silently omitting members. Moving large rosters to fully paginated screen rendering remains a separate performance improvement.
- API key rows expose name, prefix, project scope, permissions, last use, expiry, and status. Default to project scope, minimum permissions, and `90`-day expiry. Revoked rows show a status badge only, not a disabled action button.
- A newly created API key is rendered once in a modal. The user must affirm that it was stored before closing; subsequent screens show only the prefix.
- Every close path for a one-time secret modal—close button, `Escape`, and backdrop—must respect the confirmation gate. The first-use screen also warns before navigation until the secret is confirmed; deployment polling may continue in the background while the page remains open.
- Project detail keeps **Overview**, deployments, **Publications**, and **Private shares** in one project navigation context. Deployment history leads each row with its date and explains immutable releases without exposing storage keys.
- **Open documentation** is shown only when the project has an active deployment. Before the first deployment, show a "Waiting for first deployment" state with a link to Deployments instead of a link that would 404.
- Publications distinguish tracked active releases from pinned immutable releases. Private shares expose expiry and revocation state. Both stay subordinate to the selected project.
- Tables may scroll inside their own container on narrow screens; the page itself must not overflow. Empty states state what is missing and offer one next action.
- Dynamic collection removal must resolve to the same explicit empty state as an initially empty response. Empty-state marks use Material Symbols, remain `aria-hidden`, and never rely on a placeholder letter as the visible icon.

### Control-plane motion

- Page content enters once with `opacity` and at most `6px` vertical movement.
- Drawer, dialog, dropdown, toast, row insertion/removal, copy feedback, and button press use the shared `150ms`–`300ms` tokens.
- Loading uses a local skeleton or one pending control. Deployment polling uses one small state indicator; never animate the whole page.
- When management controllers or templates change, rebuild assets and bump `MANAGEMENT_SHELL_VERSION` in `src/routes/management-navigation.ts`; a mismatched shell falls back to full navigation.
- Initial loads and retries render a destination-shaped skeleton inside the final screen container. Reloadable async views use a request version guard so an older response cannot replace newer content; failures replace the skeleton with an actionable retry state.
- Immediate management navigation and SSR must use the same canonical loading template, including page-specific headings, tabs, wrappers, columns and responsive styles. Keep those skeleton nodes mounted through controller initialization (and any authenticated-HTML fallback); do not insert a generic first loader, restart shimmer, or replay a whole-content fade when data arrives. Unknown data values and row counts remain placeholders. Primary content must not wait for independent secondary sections: deployment history, recent deployment and invitations have local loading/error/retry states. Publication deployment choices load only when pinned mode is selected.
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
- Header starts with the project title (project viewer), publication title (public viewer), or organization slug (legacy viewer) as the page `h1`; there is no sidebar collapse toggle.
- The title uses the primary color and stays consistent between private and public docs.
- Right-side actions: hide/show app shell, share, theme toggle, avatar. The share button is **Share document** in the project viewer (creates a revocable 7-day private share), **Copy public URL** in the public viewer, and **Copy signed URL** in the legacy viewer.
- On mobile the toolbar keeps the tree toggle, title, and share visible and moves the project back link, reading mode, theme, and account into a **More** menu (`aria-label="More document actions"`, `44px` rows, closes on `Escape` or outside click and returns focus). The theme row in that menu is a plain row: no border or background, row text color.
- Avatar menu opens near its trigger and closes on outside click. Successful copy feedback stays inline in the copy button. Share failures use a persistent, dismissible notice placed after the toolbar in DOM order; Escape dismisses it and returns focus to the share action. A separate, always-present polite live region announces the reason once, and a delay once when it starts and once when it ends. The per-second countdown is aria-hidden, never live. Size/complexity errors explain the limit without Retry; a busy (deadline) failure offers Retry; quota errors count down to an explicit Retry action. Dismissing a quota notice does not bypass its delay, and navigating to another document clears every notice except the quota countdown.
- Hide/show app shell persists in `localStorage`; `Ctrl+Shift+H` (`Cmd+Shift+H` on macOS) toggles it from either the app shell or the focused document iframe, top/left hot zones temporarily reveal the header/sidebar while hidden, and `Escape` restores the full shell.
- Theme toggle cycles `system → dark → light → system`. Supported browsers reveal the new shell/commentor theme with a radial ripple from the theme button while the icon scrolls through `contrast`, `dark_mode`, and `light_mode`. Reduced-motion and unsupported browsers switch directly. Publisher iframe content is not restyled.

Interaction spec:

| Element | Default | Hover | Active/open |
|---|---|---|---|
| Share button | Neutral bordered button with link icon | Neutral container hover bg, stronger border | Link and label scroll to a CSS spinner plus the pending label (`Creating share…`, `Copying public URL…`, or `Creating signed URL…`); success continues to the check icon plus the done label (`Share link copied!`, `Public URL copied!`, or `Signed URL copied!`) |
| Icon buttons | Muted icon | Container hover bg | Icon motion / menu visible |
| Theme toggle | Current mode icon (`contrast`, `dark_mode`, `light_mode`) | Container hover bg | Stabilized radial theme reveal starts; icon track scrolls vertically to the active mode |
| Avatar | Single-initial chip (same logic as the management shell) | Border/surface emphasis | Avatar menu visible |

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
- Project viewer: `/organizations/:organizationId/projects/:projectId/docs?doc=<path>`, with iframe documents streamed from `…/docs/files/*` and tree pages from `…/docs/tree`.
- Public publications: `/p/:slug` (anonymous, read-only).
- Private shares: `/s/:token` — revocable, expiring Convex share grants; they bypass auth and serve the single shared document.
- Legacy viewer: `/docs/:org/:path*` (tree-only `/docs/:org`), iframe documents from `/files/:org/:path*`, legacy `?doc=:org/:path` links upgraded with `history.replaceState`, and legacy `/share/:token` 7-day HMAC links. These remain only for the migration window.
- App-shell URLs and iframe stream URLs are separate ownership boundaries.
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

- Missing routes and missing documents use a centered card with the Rendro wordmark (hidden inside iframes), eyebrow **Error 404**, and heading **Page not found**. It loads Inter like every other surface. The default action is **Go to Rendro** (`/`); callers may pass a context-specific label and destination (for example **Open project docs**).
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
| Share button | Keeps the button enabled while creating the link; scrolls the link icon to a spinner and the label to the pending label; ignores duplicate activation until completion; then preserves the existing check icon and done-label feedback |
| Theme toggle | Tri-state cycle `system → dark → light`; stabilized radial View Transition over `520ms`; icon track scrolls vertically over `300ms`; direct switch under reduced motion or without View Transition support |
| Avatar menu | Opens at avatar, shows email and sign-out action |
| Document load | Active tree pill shimmers left-to-right and subtly recoils while the iframe request is active; the 4px indicator remains static |
| Sidebar resize | Boundary handle highlights on hover/focus; drag updates width directly; keyboard arrows resize in `24px` steps |
| Comment drawer | Edge-attached, draggable, follows parent theme |

Rules:

- Every interactive element needs hover/focus/active or open state where applicable.
- Repeated controls share state styling, not just event handlers: use neutral container hover, Ember keyboard focus, 150ms standard easing, and `.98` button press feedback. Disabled controls must not acquire enabled hover/press feedback. Reduced motion removes press transforms while preserving positioning transforms. Account-menu rows use 14px/20px text, 20px icons, and 44px mobile targets; toolbar controls use 36px desktop and 44px mobile targets.
- Keep tab underlines inside their link box; an indicator must not create vertical scrolling in a horizontal navigation strip. Long document titles truncate within the fixed-height header without shrinking its actions.
- Do not add flourish to app chrome. Rendro should feel fast and reliable, not playful.
- If two indicators could describe one action, keep the more local one and remove the other.
- Motion must never block pointer interaction.

## Comments layer

The commentor is an enhancement over publisher HTML.

- Runs as vanilla JS injected into served documents.
- Uses Shadow DOM where needed to isolate comment UI from publisher CSS.
- Follows the parent app theme intent but must remain legible on arbitrary document backgrounds.
- Selection-to-comment should feel contextual: select text, affordance appears, drawer opens only when needed.
- Widget styles use only CSS custom properties the widget itself defines.
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
- Mutation controls expose one local pending indicator, preserve drafts on error, and report failures through an accessible status. Comment quota failures keep drafts editable, disable thread/reply submission for the supplied delay, and show a persistent, dismissible countdown that is announced once at the start and once at the end (the per-second number is aria-hidden). Dismissing returns focus to the draft, and pressing Enter in a draft during the delay shows the reason again. Expiry re-enables submission without automatically replaying writes. Delete uses a five-second **Undo** toast before the destructive mutation.
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
- Document navigation uses only the active tree-pill feedback described above.
- Auth redirects may show browser navigation; do not add fake progress.
- Org creation/API-key creation should return a concrete result page, not a spinner page.
- Comments can show local pending state, but should not block reading.

The product promise is instant docs. Loading UI should acknowledge latency, not dramatize it.

## Dark mode rules

Dark mode applies to app chrome only.

- Persist app theme in `localStorage` under `commentor-theme` with values `"system"`, `"dark"`, or `"light"`.
- `system` follows `prefers-color-scheme`; unset storage is treated as `system`.
- All theme-aware route templates, including landing, use `renderThemeAssets()` from `src/routes/theme.ts`; pages with a toggle mount its shared controller. Do not create page-local theme engines or force a mode when following sign-in/get-started links.
- Every theme button is emitted by `renderThemeButton()`, without page-local icon/button classes. Its neutral surface, muted icon, border, 6px radius, container hover, strong hover foreground, Ember keyboard focus ring, .98 press, disabled state, and 150ms easing belong to the shared component. Use 36px desktop and 44px at widths up to 760px consistently across shells. A viewer mobile-menu row may expand in width and add its label; it does not redefine hover/focus colors or motion. Hover-only feedback is gated by hover-capable input; reduced motion removes transitions and press transforms.
- Every toggle cycles `system → dark → light → system`, with the same `contrast`, `dark_mode`, and `light_mode` icon track (300ms), radial reveal (520ms), and subtle press feedback. The next mode is announced by the button label; the current mode is exposed in its title.
- Initialize before page content paints. Synchronize preference changes across tabs and system appearance changes without animating unrelated screens. Rapid toggles must preserve the latest intended mode, including when an earlier transition fails or completes late.
- Persist an explicit user choice before awaiting a theme snapshot so immediate navigation sees that choice. On persisted Back/Forward restoration, reconcile the saved preference and current system appearance without replaying the theme animation or accepting a stale snapshot callback.
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
- Reduced motion for share-link creation: icon and label rows switch instantly and the loader remains static.
- Icon-only buttons need `aria-label` or visible text.
- There is no standalone loading element with `role="progressbar"` or a live-region announcement.
- Sidebar resize uses a focusable `role="separator"` with `aria-orientation="vertical"`, `aria-controls`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-valuetext`.
- Sidebar splitter keyboard support: Left/Right resize by one step; Home/End move to min/max.
- Hidden shell state preserves full sidebar width/state, uses `aria-pressed` on the shell hide/show button, toggles with `Ctrl+Shift+H`/`Cmd+Shift+H` from the shell or focused document iframe, and restores with `Escape`.
- Dropdowns must remain reachable by keyboard in future iterations; current click-only menus are acceptable but should not regress.
- Active tree state cannot be color-only; the 4px indicator and active background both communicate selection.
- Error states use text or ARIA labels in addition to red color.
- Verify mobile layouts at `320px`, `375px`, and `430px` (320px is the WCAG Reflow width); management controls are `44px` up to `760px` and `36px` on desktop.
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
12. **Cache bust assets** — If `lazy-tree.ts` or `commentor.ts` changes, rebuild assets and bump the relevant script query version. If management controllers or templates change, rebuild assets and bump `MANAGEMENT_SHELL_VERSION`.
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
9. `pnpm verify` passes when code changes are involved.
10. Browser-harness verifies the user-visible interaction when UI behavior changes.
