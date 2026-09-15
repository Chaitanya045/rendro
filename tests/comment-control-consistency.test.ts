import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/commentor/commentor.ts", import.meta.url),
  "utf8",
);

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = source.match(new RegExp(`${escaped} \\{([^}]+)\\}`))?.[1];
  expect(body, `missing CSS rule for ${selector}`).toBeDefined();
  return body ?? "";
}

describe("comment control consistency", () => {
  it("uses the same theme tokens for control states in explicit light, explicit dark, and system dark modes", () => {
    const light = cssRule(":host(.light)");
    const dark = cssRule(":host(.dark)");
    const systemDark = source.match(
      /@media \(prefers-color-scheme: dark\) \{\s*:host \{([^}]+)\}/,
    )?.[1] ?? "";

    expect(light).toContain("--accent: #c2410c");
    expect(light).toContain("--accent-hover: #9a3412");
    for (const theme of [dark, systemDark]) {
      expect(theme).toContain("--bg: #09090b");
      expect(theme).toContain("--border-soft: #27272a");
      expect(theme).toContain("--accent: #fb923c");
      expect(theme).toContain("--accent-hover: #fdba74");
    }
  });

  it("gives keyboard focus to buttons, the drag grip, thread cards, and text inputs", () => {
    const focus = cssRule(
      'button:focus-visible, [tabindex="0"]:focus-visible, textarea:focus-visible',
    );
    expect(focus).toContain("outline: 2px solid var(--accent)");
    expect(focus).toContain("outline-offset: 2px");
  });

  it("keeps hover and press feedback off disabled controls", () => {
    for (const selector of [
      ".toolbar button",
      ".filter-tabs button",
      ".new-comments",
      ".empty button",
      ".card-action",
      ".quote",
      ".locate-link",
      ".actions button",
      ".reply-row button",
      ".toast button",
    ]) {
      expect(source.includes(`${selector}:active:not(:disabled)`), selector).toBe(true);
    }

    expect(source).toContain(
      '.selection-action[data-state="open"]:active:not(:disabled)',
    );

    expect(source).toContain(".toolbar button:hover:not(:disabled)");
    expect(source).toContain(".card-action:hover:not(:disabled)");
    expect(source).toContain(".actions button.primary:hover:not(:disabled)");
    expect(source).toContain(".actions button.ghost:hover:not(:disabled)");
    expect(source).not.toMatch(/\.card-action(?:\.danger)?:hover\s*\{/);
    expect(source).not.toMatch(/\.actions button(?:\.primary|\.ghost)?:hover\s*\{/);
  });

  it("uses one .98 press scale for ordinary controls while preserving structural transforms", () => {
    for (const selector of [
      ".toolbar button:active:not(:disabled)",
      ".filter-tabs button:active:not(:disabled)",
      ".empty button:active:not(:disabled)",
      ".card-action:active:not(:disabled)",
      ".quote:active:not(:disabled)",
      ".locate-link:active:not(:disabled)",
      ".actions button:active:not(:disabled), .reply-row button:active:not(:disabled)",
      ".toast button:active:not(:disabled)",
    ]) {
      expect(cssRule(selector), selector).toContain("scale(.98)");
    }
    expect(cssRule('.selection-action[data-state="open"]:active:not(:disabled)'))
      .toContain("translateY(0) scale(.98)");
    expect(cssRule(".new-comments:active:not(:disabled)"))
      .toContain("translateX(-50%) scale(.98)");
    expect(cssRule(".pin:active")).toContain("rotate(-45deg)");
    expect(source).not.toMatch(/button:active[^{]*\{[^}]*scale\(\.(?:96|99)\)/);
  });

  it("removes press transforms and communicates every disabled control without color alone", () => {
    for (const selector of [
      ".toolbar button:disabled",
      ".filter-tabs button:disabled",
      ".new-comments:disabled",
      ".empty button:disabled",
      '.selection-action[data-state="open"]:disabled',
      ".card-action:disabled",
      ".quote:disabled",
      ".locate-link:disabled",
      ".toast button:disabled",
    ]) {
      const rule = cssRule(selector);
      expect(rule, selector).toContain("opacity:");
      expect(rule, selector).toContain("cursor:");
      expect(rule, selector).toContain("transform:");
    }
    expect(cssRule("textarea:disabled")).toContain("cursor: not-allowed");
    expect(cssRule(".actions button:disabled, .reply-row button:disabled"))
      .toContain("transform: none");
  });

  it("keeps touch controls at least 44px and preserves the compact toolbar alignment", () => {
    const mobile = source.slice(
      source.indexOf("@media (max-width: 760px)"),
      source.indexOf("@media (max-width: 419px)"),
    );
    expect(mobile).toContain(
      ".card-action { width: 44px; height: 44px; flex: 0 0 44px; }",
    );
    for (const selector of [
      ".filter-tabs button",
      ".actions button",
      ".reply-row button",
      ".empty button",
      ".new-comments",
      ".quote",
      ".locate-link",
      ".toast button",
    ]) {
      expect(mobile, selector).toContain(selector);
    }
    expect(mobile).toContain("min-height: 44px");

    const narrow = source.slice(source.indexOf("@media (max-width: 419px)"));
    expect(narrow).toContain(
      ".head { display: grid; grid-template-columns: minmax(0, 1fr) auto 44px; align-items: center; }",
    );
    const touch = source.slice(source.indexOf("@media (hover: none)"));
    expect(touch).toContain(".card-action { width: 44px; height: 44px; }");
    for (const selector of [
      ".filter-tabs button",
      ".actions button",
      ".reply-row button",
      ".empty button",
      ".new-comments",
      ".quote",
      ".locate-link",
      ".toast button",
    ]) {
      expect(touch, selector).toContain(selector);
    }
    expect(cssRule(".toolbar button, .grip")).toContain("min-width: 44px");
    expect(cssRule(".toolbar button, .grip")).toContain("min-height: 44px");
    expect(cssRule(".pin::after")).toContain("inset: -8px");
  });

  it("turns off repeated control transitions and scale feedback for reduced motion", () => {
    const reduced = source.slice(
      source.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    for (const selector of [
      ".toolbar button",
      ".filter-tabs button",
      ".new-comments",
      ".empty button",
      ".selection-action",
      ".card-action",
      ".quote",
      ".locate-link",
      ".actions button",
      ".reply-row button",
      ".toast button",
    ]) {
      expect(reduced, selector).toContain(selector);
    }
    expect(reduced).toContain("transition: none !important");
    expect(reduced).toContain(
      ".pin:hover, .pin.is-highlighted, .pin:active { transform: rotate(-45deg); }",
    );
    expect(reduced).toContain(
      ".new-comments:active:not(:disabled) { transform: translateX(-50%); }",
    );
  });
});
