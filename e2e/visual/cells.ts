import type { Theme, Width } from "./states";

/**
 * The cells of the visual baselines and the axe scans (#120), as plain data. The two specs declare one test per entry, and
 * tests/ui-transitions.test.ts reads the same lists, so the registry can cite a cell by its title (#319).
 */

/** `widths` narrows or extends the default 375/768/1440 of the baselines (a card page is the same at 768 and 1440; the shell is also read at 320). */
export type Cell = { family: string; state: string; widths?: Width[] };

const cards: Width[] = [375, 1440];
const shell: Width[] = [320, 375, 768, 1440];
/** The auth card's layout changes at each of these: the 520px phone padding, the 820px single column, the desktop context column. */
const forms: Width[] = [320, 375, 768, 1440];

/**
 * Every page family and its loading/empty/error/dialog/menu state at 375/768/1440px in light and dark. Every rendered
 * string is seeded or pinned fixed text, so no cell needs a mask.
 */
export const baselineCells: Cell[] = [
  { family: "landing", state: "default" },
  { family: "landing", state: "workflow" },
  { family: "landing", state: "product" },
  { family: "landing", state: "security" },
  { family: "sign-in", state: "default" },
  // Slice 3 (#319): the sign-in and sign-up errors, account recovery, email verification, account security and the 404.
  { family: "sign-in", state: "validation", widths: forms },
  { family: "sign-in", state: "invalid-credentials", widths: forms },
  { family: "sign-in", state: "rate-limited", widths: cards },
  { family: "sign-in", state: "oauth-access-denied", widths: cards },
  { family: "sign-in", state: "oauth-state-mismatch", widths: cards },
  { family: "sign-in", state: "oauth-account-not-linked", widths: cards },
  { family: "sign-in", state: "oauth-unknown", widths: cards },
  { family: "sign-up", state: "default" },
  { family: "sign-up", state: "validation", widths: forms },
  { family: "sign-up", state: "rate-limited", widths: cards },
  { family: "forgot-password", state: "default", widths: forms },
  { family: "forgot-password", state: "sent", widths: cards },
  { family: "forgot-password", state: "error", widths: cards },
  { family: "reset-password", state: "form", widths: forms },
  { family: "reset-password", state: "invalid", widths: cards },
  { family: "verify-email", state: "verified", widths: cards },
  { family: "verify-email", state: "invalid", widths: cards },
  { family: "security", state: "loading", widths: cards },
  { family: "security", state: "credential", widths: forms },
  { family: "security", state: "no-password", widths: forms },
  { family: "security", state: "failure", widths: cards },
  { family: "security", state: "change-error", widths: cards },
  { family: "security", state: "add-mismatch", widths: cards },
  { family: "not-found", state: "default", widths: cards },
  { family: "home", state: "default", widths: cards },
  { family: "viewer", state: "tree" },
  { family: "viewer", state: "loading" },
  { family: "viewer", state: "menu", widths: [375] },
  { family: "comments", state: "drawer" },
  { family: "comments", state: "resolved" },
  { family: "comments", state: "reply" },
  { family: "comments", state: "deleted" },
  { family: "comments", state: "offline" },
  { family: "comments", state: "refused" },
  { family: "repo", state: "home" },
  { family: "repo", state: "search" },
  { family: "repo", state: "search-empty" },
  { family: "repo", state: "search-error" },
  { family: "repo", state: "search-limited", widths: cards },
  { family: "repo", state: "not-found" },
  { family: "repo", state: "denied", widths: cards },
  { family: "repo", state: "unavailable", widths: cards },
  { family: "repo", state: "preparing", widths: cards },
  { family: "repo", state: "prepare-failed", widths: cards },
  { family: "repo", state: "private" },
  { family: "repo", state: "markdown", widths: shell },
  { family: "repo", state: "long-title", widths: shell },
  { family: "repo", state: "large" },
  { family: "repo", state: "tree-expanded", widths: shell },
  { family: "repo", state: "doc-error" },
  { family: "repo", state: "link-confirm", widths: shell },
];

export const baselineTitle = (cell: Cell) => `${cell.family} — ${cell.state}`;

export type Scanned = Cell & { width: Width; theme: Theme };
const both: Theme[] = ["light", "dark"];
const at = (family: string, state: string, ...sizes: Width[]): Scanned[] => sizes.flatMap(width => both.map(theme => ({ family, state, width, theme })));

/** Every state is scanned in both appearances (#268): a contrast or focus failure can belong to the dark theme alone. */
export const axeCells: Scanned[] = [
  ...at("landing", "default", 1440),
  ...at("landing", "security", 375),
  ...at("sign-in", "default", 1440),
  ...at("sign-in", "validation", 1440, 375),
  ...at("sign-in", "invalid-credentials", 1440),
  ...at("sign-in", "rate-limited", 1440),
  ...at("sign-in", "oauth-access-denied", 1440),
  ...at("sign-in", "oauth-state-mismatch", 1440),
  ...at("sign-in", "oauth-account-not-linked", 1440),
  ...at("sign-in", "oauth-unknown", 1440),
  ...at("sign-up", "default", 1440),
  ...at("sign-up", "validation", 1440, 375),
  ...at("sign-up", "rate-limited", 1440),
  ...at("forgot-password", "default", 1440, 375),
  ...at("forgot-password", "sent", 1440),
  ...at("forgot-password", "error", 1440),
  ...at("reset-password", "form", 1440, 375),
  ...at("reset-password", "invalid", 1440),
  ...at("verify-email", "verified", 1440),
  ...at("verify-email", "invalid", 1440),
  ...at("security", "loading", 1440),
  ...at("security", "credential", 1440, 375),
  ...at("security", "no-password", 1440, 375),
  ...at("security", "failure", 1440),
  ...at("security", "change-error", 1440),
  ...at("security", "add-mismatch", 1440),
  ...at("not-found", "default", 1440, 375),
  ...at("home", "default", 1440, 375),
  ...at("viewer", "tree", 1440),
  ...at("viewer", "menu", 375),
  ...at("comments", "drawer", 1440, 375),
  ...at("comments", "resolved", 1440),
  ...at("comments", "reply", 1440),
  ...at("comments", "deleted", 1440),
  ...at("comments", "offline", 375),
  ...at("comments", "refused", 1440, 375),
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

export const axeTitle = (cell: Scanned) => `axe — ${cell.family} — ${cell.state} — ${cell.width} — ${cell.theme}`;
