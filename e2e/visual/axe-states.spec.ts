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

const cells: Array<Cell & { width: Width; theme: Theme }> = [
  { family: "landing", state: "default", width: 1440, theme: "light" },
  { family: "sign-in", state: "default", width: 1440, theme: "light" },
  { family: "sign-up", state: "default", width: 1440, theme: "light" },
  { family: "org", state: "overview", width: 1440, theme: "light" },
  { family: "projects", state: "list", width: 1440, theme: "light" },
  { family: "projects", state: "empty", width: 1440, theme: "light" },
  { family: "projects", state: "error", width: 1440, theme: "light" },
  { family: "projects", state: "dialog", width: 1440, theme: "light" },
  { family: "projects", state: "dialog", width: 375, theme: "light" },
  { family: "project", state: "overview", width: 1440, theme: "light" },
  { family: "teams", state: "list", width: 1440, theme: "light" },
  { family: "keys", state: "list", width: 1440, theme: "light" },
  { family: "account-menu", state: "default", width: 1440, theme: "light" },
  { family: "account-menu", state: "default", width: 375, theme: "light" },
  { family: "viewer", state: "tree", width: 1440, theme: "light" },
  { family: "viewer", state: "menu", width: 375, theme: "light" },
  { family: "comments", state: "drawer", width: 1440, theme: "light" },
  { family: "comments", state: "drawer", width: 375, theme: "light" },
  { family: "repo", state: "home", width: 1440, theme: "light" },
  { family: "repo", state: "search", width: 1440, theme: "light" },
  { family: "repo", state: "search", width: 375, theme: "light" },
];

/**
 * Known violations, each tied to an open issue. An entry matches a rule on nodes whose target
 * contains `target` in one cell, and is *stale* (the cell fails) as soon as it matches nothing, so
 * the fix of the issue must delete the entry. Adding an entry takes a written reason and an issue
 * and is reviewed like a baseline change (docs/BROWSER_TESTS.md); it never widens past one cell.
 */
type Known = { family: string; state: string; rule: string; target: string; issue: string; reason: string };
const known: Known[] = [
  { family: "comments", state: "drawer", rule: "color-contrast", target: ".quote-text", issue: "#267", reason: "the quoted text of a thread is too light on the drawer background" },
  { family: "comments", state: "drawer", rule: "color-contrast", target: ".reply > .when", issue: "#267", reason: "the reply timestamp is too light on the drawer background" },
  { family: "repo", state: "search", rule: "color-contrast", target: ".repo-search-item-path", issue: "#267", reason: "#71717a on the #f4f4f5 active row is below 4.5:1" },
];

/** WCAG 2.1 A/AA rules; anything outside these tags is out of scope for this suite. */
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

for (const cell of cells) {
  testVisual(`axe — ${cell.family} — ${cell.state} — ${cell.width}`, async ({ page, visual }) => {
    await page.setViewportSize(sizeFor(cell.width));
    await applyTheme(page, cell.theme);
    await fixClock(page, visual.clockEpoch);
    const open = await openState(page, visual, cell.family, cell.state);
    try {
      await settleVisual(page);
      // The state must still be on screen after settling (a lost dialog would make the scan vacuous).
      if (cell.state === "dialog") await expect(page.locator("#project-dialog")).toBeVisible();
      const scan = await new AxeBuilder({ page }).withTags(tags).analyze();
      const entries = known.filter(entry => entry.family === cell.family && entry.state === cell.state);
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
