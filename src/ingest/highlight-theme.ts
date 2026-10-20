/**
 * Colours for highlightCodeBlocks output: GitHub's light and dark syntax
 * palettes, as packaged in highlight.js's github.css and github-dark.css
 * (BSD-3-Clause). The serving layer ships this stylesheet; the rendered HTML
 * has no style attributes.
 *
 * Contrast (#270): every token reads on the code background, which the frame
 * stylesheet sets to `--subtle` (#f6f8fa light / #151b23 dark). The stock
 * github themes put the keyword, variable, tag and light addition below
 * 4.5:1 there, and the dark heading far below, so those tokens take
 * GitHub's own primed palettes (github-light@higher-contrast tokens
 * #cf222e/#953800/#116329 and the dark accent blue #4493f8) — the rest is
 * unchanged. tests/ingest-render.test.ts keeps every token at 4.5:1 or
 * better on both backgrounds.
 */
export const HIGHLIGHT_CSS = `
.hljs{--hl-fg:#24292e;--hl-keyword:#cf222e;--hl-entity:#6f42c1;--hl-constant:#005cc5;--hl-string:#032f62;--hl-variable:#953800;--hl-comment:#6a737d;--hl-tag:#116329;--hl-heading:#005cc5;--hl-list:#735c0f;--hl-ins-fg:#116329;--hl-ins-bg:#f0fff4;--hl-del-fg:#b31d28;--hl-del-bg:#ffeef0;color:var(--hl-fg)}
@media (prefers-color-scheme:dark){.hljs{--hl-fg:#c9d1d9;--hl-keyword:#ff7b72;--hl-entity:#d2a8ff;--hl-constant:#79c0ff;--hl-string:#a5d6ff;--hl-variable:#ffa657;--hl-comment:#8b949e;--hl-tag:#7ee787;--hl-heading:#4493f8;--hl-list:#f2cc60;--hl-ins-fg:#aff5b4;--hl-ins-bg:#033a16;--hl-del-fg:#ffdcd7;--hl-del-bg:#67060c}}
.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:var(--hl-keyword)}
.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:var(--hl-entity)}
.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-variable,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id{color:var(--hl-constant)}
.hljs-regexp,.hljs-string,.hljs-meta .hljs-string{color:var(--hl-string)}
.hljs-built_in,.hljs-symbol{color:var(--hl-variable)}
.hljs-comment,.hljs-code,.hljs-formula{color:var(--hl-comment)}
.hljs-name,.hljs-quote,.hljs-selector-tag,.hljs-selector-pseudo{color:var(--hl-tag)}
.hljs-subst{color:var(--hl-fg)}
.hljs-section{color:var(--hl-heading);font-weight:bold}
.hljs-bullet{color:var(--hl-list)}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:bold}
.hljs-addition{color:var(--hl-ins-fg);background-color:var(--hl-ins-bg)}
.hljs-deletion{color:var(--hl-del-fg);background-color:var(--hl-del-bg)}
`.trim();
