import { AxeBuilder } from "@axe-core/playwright";
import { expect } from "../fixtures";
import { testVisual } from "./state";
import { applyTheme, fixClock, settleVisual, sizeFor, type Width, type Theme } from "./states";
import { openState, type Cell } from "./render-states";

/**
 * Accessibility scans (#120): axe over the interactive states the baselines render, on
 * Chromium, Firefox and WebKit — all three engines run the same states through the same shared
 * helpers, so an engine-specific failure cannot hide behind a Chromium-only render. Scans never
 * auto-accept: a violation fails the engine spec, and a whitelist entry below needs a written
 * reason and a removal plan, exactly like the documented approval process in docs.
 */

type Scanned = Cell & { width: Width; themes: Theme[]; };
const both: Theme[] = ["light", "dark"];
const at = (family: string, state: string, ...sizes: Width[]): Scanned[] => sizes.map(width => ({ family, state, width, themes: both }));
// The comment states of #268 show #267's two light-appearance contrast findings (`.quote-text`, `.reply > .when`), which are not
// listed again: until #267 lands they are scanned in dark only, and its pull request switches them to `at(...)`.
const darkUntil267 = (family: string, state: string, ...sizes: Width[]): Scanned[] => sizes.map(width => ({ family, state, width, themes: ["dark"] }));
// Every state is scanned in both appearances (#268): a contrast or focus failure can belong to the dark theme alone.
const scanned: Scanned[] = [
  ...at("landing", "default", 1440),
  ...at("landing", "security", 375),
  ...at("sign-in", "default", 1440),
  ...at("sign-up", "default", 1440),
  ...at("org", "overview", 1440),
  ...at("projects", "list", 1440),
  ...at("projects", "empty", 1440),
  ...at("projects", "error", 1440),
  ...at("projects", "dialog", 1440, 375),
  ...at("project", "overview", 1440),
  ...at("teams", "list", 1440),
  ...at("keys", "list", 1440),
  ...at("account-menu", "default", 1440, 375),
  ...at("viewer", "tree", 1440),
  ...at("viewer", "menu", 375),
  ...at("comments", "drawer", 1440, 375),
  ...darkUntil267("comments", "resolved", 1440),
  ...darkUntil267("comments", "reply", 1440),
  ...darkUntil267("comments", "deleted", 1440),
  ...darkUntil267("comments", "offline", 375),
  ...darkUntil267("comments", "refused", 1440, 375),
  ...at("repo", "home", 1440),
  ...at("repo", "search", 1440, 375),
  ...at("repo", "search-empty", 1440),
  ...at("repo", "search-error", 1440, 375),
  ...at("repo", "search-limited", 375),
  ...at("repo", "not-found", 1440),
  ...at("repo", "denied", 1440),
  ...at("repo", "unavailable", 1440),
  ...at("repo", "preparing", 1440),
  ...at("repo", "prepare-failed", 1440),
  ...at("repo", "private", 1440),
  ...at("repo", "markdown", 1440, 320),
  ...at("repo", "long-title", 320),
  ...at("repo", "large", 1440),
  ...at("repo", "tree-expanded", 1440, 320),
  ...at("repo", "doc-error", 1440),
  ...at("repo", "link-confirm", 1440, 375),
];
const cells: Array<Scanned & { theme: Theme }> = scanned.flatMap(cell => cell.themes.map(theme => ({ ...cell, theme })));

/**
 * Known violations, each tied to an open issue. An entry matches a rule on nodes whose target
 * contains `target` in one cell, and is *stale* (the cell fails) as soon as it matches nothing, so
 * the fix of the issue must delete the entry. Adding an entry takes a written reason and an issue
 * and is reviewed like a baseline change (docs/BROWSER_TESTS.md); it never widens past one cell.
 */
type Engine = "chromium" | "firefox" | "webkit";
type Known = { family: string; state: string; rule: string; target: string; issue: string; reason: string; /** The appearance the entry belongs to: light unless stated, or "both". */ theme?: Theme | "both"; /** Only this viewport width; every width unless stated. */ width?: Width; /** Only this engine; every engine unless stated. */ engines?: Engine[] };
const known: Known[] = [
  { family: "comments", state: "drawer", rule: "color-contrast", target: ".quote-text", issue: "#267", reason: "the quoted text of a thread is too light on the drawer background" },
  { family: "comments", state: "drawer", rule: "color-contrast", target: ".reply > .when", issue: "#267", reason: "the reply timestamp is too light on the drawer background" },
  { family: "repo", state: "search", rule: "color-contrast", target: ".repo-search-item-path", issue: "#267", reason: "#71717a on the #f4f4f5 active row is below 4.5:1" },
  // Dark appearance, Firefox only. Chromium and WebKit pass these cells, and on Chromium axe does not list the elements as
  // "incomplete" either (checked on the reply, search and markdown cells), so Firefox renders or resolves their dark colours
  // differently. An entry without `engines` would be stale on the other two. The contrast fixes of #267 and #270 delete these.
  ...[["drawer", ".quote-text"], ["drawer", ".reply > .when"], ["resolved", ".quote-text"], ...["reply", "offline", "refused"].flatMap(state => [[state, ".quote-text"], [state, ".reply > .when"]])].map(([state, target]): Known => ({ family: "comments", state, rule: "color-contrast", target, issue: "#267", theme: "dark", engines: ["firefox"], reason: "Firefox only: the quote and reply timestamp of a thread are reported too light on the dark drawer background" })),
  { family: "repo", state: "search", rule: "color-contrast", target: ".repo-search-item-path", issue: "#267", theme: "dark", engines: ["firefox"], reason: "Firefox only: the result path is too light on the dark active row" },
  { family: "repo", state: "markdown", rule: "color-contrast", target: ".hljs-keyword", issue: "#270", theme: "dark", engines: ["firefox"], reason: "Firefox only: the dark highlight theme's keyword colour is below 4.5:1 on the code background" },
  // #270, found by the #268 states.
  ...["search-empty", "search-error", "search-limited"].map((state): Known => ({ family: "repo", state, rule: "aria-required-children", target: "#repo-search-results", issue: "#270", theme: "both", reason: "the panel keeps role=listbox while it holds a single message instead of options" })),
  { family: "repo", state: "markdown", rule: "label", target: ".task-list-item", issue: "#270", theme: "both", reason: "the checkboxes of a rendered task list have no accessible name" },
  { family: "repo", state: "markdown", rule: "color-contrast", target: ".hljs-keyword", issue: "#270", reason: "the light highlight theme's keyword colour is below 4.5:1 on the code background" },
  { family: "repo", state: "markdown", rule: "scrollable-region-focusable", target: "pre:nth-child", issue: "#270", theme: "both", width: 320, reason: "a code block that overflows at 320px cannot be scrolled from the keyboard" },
  { family: "repo", state: "markdown", rule: "scrollable-region-focusable", target: "table", issue: "#270", theme: "both", width: 320, reason: "a table that overflows at 320px cannot be scrolled from the keyboard" },
];

/** WCAG 2.1 A/AA rules; anything outside these tags is out of scope for this suite. */
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

for (const cell of cells) {
  testVisual(`axe — ${cell.family} — ${cell.state} — ${cell.width} — ${cell.theme}`, async ({ page, visual, browserName }) => {
    await page.setViewportSize(sizeFor(cell.width));
    await applyTheme(page, cell.theme);
    await fixClock(page, visual.clockEpoch);
    const open = await openState(page, visual, cell.family, cell.state);
    try {
      await settleVisual(page);
      // The state must still be on screen after settling (a lost dialog would make the scan vacuous).
      if (cell.state === "dialog") await expect(page.locator("#project-dialog")).toBeVisible();
      await open.verify?.();
      const scan = await new AxeBuilder({ page }).withTags(tags).analyze();
      const entries = known.filter(entry => entry.family === cell.family && entry.state === cell.state && (entry.theme === "both" || (entry.theme ?? "light") === cell.theme) && (entry.width === undefined || entry.width === cell.width) && (entry.engines === undefined || entry.engines.includes(browserName)));
      const matched = new Set<Known>();
      const remaining = scan.violations
        .map(violation => ({ ...violation, nodes: violation.nodes.filter(node => {
          const entry = entries.find(candidate => candidate.rule === violation.id && JSON.stringify(node.target).includes(candidate.target));
          if (entry) matched.add(entry);
          return !entry;
        }) }))
        .filter(violation => violation.nodes.length > 0);
      const stale = entries.filter(entry => !matched.has(entry));
      expect(stale.map(entry => `${entry.rule} ${entry.target} (${entry.issue})`), "known-violation entries that no longer match: delete them").toEqual([]);
      const formatted = remaining.map(format);
      const label = `${cell.family} — ${cell.state} at ${cell.width}px (${cell.theme})`;
      // No auto-accept: a violation fails the engine run; nobody adjusts a threshold to go green.
      expect(formatted.length, `${remaining.length} axe violations on ${label}\n${formatted.join("\n")}`).toBe(0);
    } finally {
      await open.close();
    }
  });
}

type Axeviolation = { id: string; impact?: string | null; description?: string | null; nodes: Array<{ target: unknown }> };

function format(violation: Axeviolation) {
  return `${violation.id} (${violation.impact ?? "unknown"}, ${violation.nodes.length} nodes): ${violation.nodes.slice(0, 8).map(node => JSON.stringify(node.target)).join(", ")}`;
}
