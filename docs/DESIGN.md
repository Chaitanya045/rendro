# Rendro — Design System

## Principles

1. **Zero runtime dependencies** — all UI ships as vanilla JS/CSS. No React, Vue, or framework runtime in the browser.
2. **Progressive enhancement** — core doc browsing works without JS. The tree UI, comments, and themes enhance the experience.
3. **Content-first** — the UI recedes. Docs are the hero. Sidebar, topbar, and widgets are chrome.
4. **Micro-interactions over page loads** — transitions, loaders, and state changes feel immediate even when the network is slow.
5. **Dark mode parity** — every component has light and dark variants. Theme is persisted in localStorage and respects system preference.

## Color Tokens

| Token | Light | Dark | Usage |
|---|---|---|---|
| Primary | `#0a66c2` | `#4493f8` | Links, active states, accents |
| Surface | `#ffffff` | `#1e1f22` | Page backgrounds |
| Surface alt | `#f8f9fa` | `#1e1f22` | Main content area |
| Container | `#f0f0f3` | `#2f3136` | Cards, hover states |
| Text primary | `#111418` | `#f2f3f5` | Headings, body text |
| Text muted | `#6b7280` | `#9aa0a8` | Secondary text, meta |
| Border | `#e5e7eb` | `#383a40` | Dividers, card edges |

## Typography

- **Font**: Inter (Google Fonts, `wght@400;600;700`)
- **Icons**: Material Symbols Outlined (variable font, `FILL@0..1,wght@100..700`)
- Scale:
  - Body: `14px / 20px` (400)
  - Headline small: `20px / 28px` (600)
  - Headline medium: `24px / 32px` (600)

## Layout

```
┌──────────────────────────────────────────────┐
│ Topbar (56px, fixed)                         │
│ Logo │ Search ────────── │ Share Theme Avatar│
├──────────┬───────────────────────────────────┤
│ Sidebar  │ Main (scrollable, no overflow)     │
│ 280px    │                                    │
│          │ ┌─ Loader bar (3px, absolute) ──┐ │
│ Tree UI  │ │ Skeleton overlay              │ │
│ with     │ │ Content iframe (100% x 100%)  │ │
│ lazy     │ │                                │ │
│ loading  │ └────────────────────────────────┘ │
└──────────┴───────────────────────────────────┘
```

## Components

### Topbar
- Fixed position, full-width, 56px height
- Logo: brand primary color, 24px bold
- Actions: share, theme toggle, avatar with dropdown menu

### Sidebar
- Fixed position, 280px width, full viewport height
- Tree UI with lazy loading (50 items per page)
- Active indicator: 4px blue bar that animates position
- Folder expand/collapse: 300ms cubic-bezier caret rotation
- Sticky folder headers at depth-dependent offsets
- Border-line indentation via CSS custom properties

### Doc Loader (page transition)
- **Progress bar**: thin (3px) indeterminate bar at top of main area. Blue gradient slides left-to-right in 1.4s loop.
- **Skeleton shimmer**: 7 lines of varying width (35-90%) pulse opacity 0.4→0.8 in staggered 1.5s loop.
- **Tree loading state**: active tree item shows a pulsing underline.
- **Lifecycle**: show loader immediately on click → hide on iframe `onload` + `doc-loaded` postMessage.
- **Dark mode**: bar shifts to `#4493f8`, skeleton bg to `#2f3136`, lines to `#2f3136`.

### Tree Item States
| State | Visual | Trigger |
|---|---|---|
| Default | Muted text (`#6b7280`) | — |
| Hover | Light bg (`#f0f0f3`), dark text | Mouse over |
| Active | Blue bg (`#e8f0fe`), blue text (`#0a66c2`) | Selected doc |
| Loading | Pulsing underline below link text | Doc click, before iframe load |

### Commentor Widget
- Docks to screen edge (magnetic snap)
- Draggable via grip handle
- Inline text selection → comment pin
- Shadow DOM isolated styles
- Theme follows parent page

### Toast
- Fixed bottom-center, auto-dismiss 1.7s
- Slide-up enter, fade-out exit (200ms)
- Dark mode: light bg, dark text

## Animations & Timing

| Animation | Duration | Easing | Purpose |
|---|---|---|---|
| Loader bar slide | 1.4s loop | ease-in-out | Indeterminate progress |
| Skeleton pulse | 1.5s loop, staggered | ease-in-out | Content placeholder |
| Tree item underline | 0.8s loop | ease-in-out | Doc loading indicator |
| Active indicator move | 0.3s | cubic-bezier(.4,0,.2,1) | Tree selection |
| Folder caret rotate | 0.3s | cubic-bezier(.4,0,.2,1) | Expand/collapse |
| Iframe fade-in | 0.3s | ease | Content reveal |
| Toast enter | 0.2s | — | Notification |

## Accessibility

- All interactive elements are keyboard-accessible
- ARIA labels on icon buttons (theme, share, avatar)
- Commentor drawer has `role="complementary"` and `aria-label`
- Active tree item is focusable
- Reduced motion: respect `prefers-reduced-motion` (TODO)

## Browser Support

- Modern Chromium, Firefox, Safari (last 2 versions)
- Cloudflare Workers runtime (no DOM APIs at build time — DOMParser polyfill)
- Material Symbols require variable font support

## Anti-Patterns (avoid)

- No runtime frameworks (React, Vue, Svelte)
- No CSS-in-JS
- No icon fonts — use Material Symbols variable font only
- No animation libraries — CSS keyframes only
- No heavy image assets — SVG inline or Unicode only
- No blocking JS in the critical path — lazy-tree.js is the only required script, loaded at end of body
