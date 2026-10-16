import type { Cookie } from "@playwright/test";
import { test as base, expect, guardContext } from "./fixtures";
import { provision, type Workspace } from "./shell-helpers";

export type Pool = Workspace & { cookies: Cookie[] };
type Shared = { general: Promise<Pool>; switcher: Promise<Pool> };

/**
 * One verified disposable user per worker (and per purpose) instead of one per test: signup, mail
 * verification and organization creation are real backend calls, but their cost is paid once. Tests
 * that sign out, change membership or need an exact organization list provision their own users.
 */
export const test = base.extend<{ pooled: Pool; switcherPool: Pool }, { shared: Shared }>({
  shared: [async ({ browser }, use, info) => {
    const origin = process.env.RENDRO_E2E_ORIGIN;
    if (!origin) throw new Error("Missing local Worker origin");
    const nonce = `${info.workerIndex}-${Date.now().toString(36)}-${info.project.name}`;
    const create = async (label: string, organizations: string[], project: boolean) => {
      const context = await browser.newContext({ baseURL: origin, serviceWorkers: "block" });
      const unexpected = await guardContext(context, origin, `shell-${label}-${nonce}`);
      try {
        const page = await context.newPage();
        const workspace = await provision(page, `${label}-${nonce}`, { organizations, project });
        expect([...unexpected], "Unexpected external requests while provisioning").toEqual([]);
        return { ...workspace, cookies: await context.cookies() };
      } finally {
        await context.close();
      }
    };
    // Lazy: each pool is created only by the first test that asks for it.
    let general: Promise<Pool> | undefined, switcher: Promise<Pool> | undefined;
    await use({
      get general() { return (general ??= create("pool", ["Pool A", "Pool B", "Pool C", "Pool D", "Pool E", "Pool F", "Pool G", "Pool H"], true)); },
      get switcher() { return (switcher ??= create("switch", ["Alpha", "Beta", "Gamma", "Gadget", `Zed <b>bold</b> & "co"`], false)); },
    });
  }, { scope: "worker", timeout: 120_000 }],
  pooled: async ({ context, shared }, use) => {
    const pool = await shared.general;
    await context.addCookies(pool.cookies);
    await use(pool);
  },
  switcherPool: async ({ context, shared }, use) => {
    const pool = await shared.switcher;
    await context.addCookies(pool.cookies);
    await use(pool);
  },
});

export { expect };
