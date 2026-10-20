import type { BrowserContext, Page } from "@playwright/test";
import { test as base, expect, guardContext } from "./fixtures";
import { provision, signInSeeded, type Workspace } from "./shell-helpers";

export type Actor = Workspace & { context: BrowserContext; page: Page; label: string; name: string };
type Options = { signedOut?: boolean };

/**
 * Journeys here involve several people at once (an author, a second reader, a revoked session). Each actor is an
 * independent browser context with its own cookies and ingress address, provisioned through the real signup and mail
 * verification, and closed (with the external-request guard asserted) when the test ends. A signed-out actor skips
 * provisioning for journeys that begin at a mailed link.
 */
export type SeededRole = "owner" | "admin" | "member" | "outsider";
export const test = base.extend<{ actor: (label: string, options?: Options) => Promise<Actor>; seeded: (role: SeededRole) => Promise<Page> }>({
  /** A page signed in as one of the globally seeded users, in its own guarded context. Read-only and denial journeys only. */
  seeded: async ({ browser, baseURL, seed }, use, info) => {
    const opened: Array<{ context: BrowserContext; unexpected: Set<string> }> = [];
    try {
      await use(async role => {
        const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
        const unexpected = await guardContext(context, baseURL, `${info.testId}-${info.retry}-seeded-${role}`);
        opened.push({ context, unexpected });
        await signInSeeded(context, baseURL, seed, role);
        const page = await context.newPage();
        await page.goto("/home");
        return page;
      });
    } finally {
      for (const { context } of opened) await context.close();
      expect(opened.flatMap(({ unexpected }) => [...unexpected]), "Unexpected external requests from seeded pages").toEqual([]);
    }
  },
  actor: async ({ browser, baseURL }, use, info) => {
    const opened: Array<{ context: BrowserContext; unexpected: Set<string> }> = [];
    try {
      await use(async (label, options = {}) => {
        const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
        const unexpected = await guardContext(context, baseURL, `${info.testId}-${info.retry}-${label}-${opened.length}`);
        opened.push({ context, unexpected });
        const page = await context.newPage();
        const workspace = options.signedOut
          ? { email: `${label}-${Math.random().toString(16).slice(2, 8)}@example.test` }
          : await provision(page, label);
        return { ...workspace, context, page, label, name: `Shell ${workspace.email.split("@")[0]}` };
      });
    } finally {
      for (const { context } of opened) await context.close();
      expect(opened.flatMap(({ unexpected }) => [...unexpected]), "Unexpected external requests from actors").toEqual([]);
    }
  },
});

export { expect };
