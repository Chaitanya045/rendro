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
│          │ │ Content iframe (100% x 100%)  │ │
│ Tree UI  │ │ Centered loader overlay        │ │
│ with     │ │ shown only while iframe loads   │ │
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

### Doc Loader (iframe transition)
- **Scope**: iframe/content area only. Do not add loading states, pulses, or spinners to the doc tree.
- **Visual**: centered 32px CSS spinner ring with muted helper text, over the iframe area.
- **Lifecycle**: show immediately after document selection → hide on iframe `onload`; stale loads cannot hide newer selections.
- **Fallback**: if the iframe request hangs, replace the spinner text with a retry hint inside the same iframe area.
- **Dark mode**: overlay uses the dark surface token; spinner accent shifts to blue (`#4493f8`) and error state to soft red.

### Tree Item States
| State | Visual | Trigger |
|---|---|---|
| Default | Muted text (`#6b7280`) | — |
| Hover | Light bg (`#f0f0f3`), dark text | Mouse over |
| Active | Blue bg (`#e8f0fe`), blue text (`#0a66c2`) | Selected doc |
| Loading | No special tree visual; selected state remains optimistic | Document click |

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
| Loader spinner | 0.7s loop | linear | Iframe document handoff |
| Loader error fallback | Static | — | Hung or failed iframe load |
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
