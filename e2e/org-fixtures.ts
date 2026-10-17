import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import { test as base, expect, guardContext } from "./fixtures";
import { mailLink } from "./auth-helpers";
import { api, provision, signInSeeded, type Workspace } from "./shell-helpers";

export type Actor = Workspace & { context: BrowserContext; page: Page; label: string; name: string };
type Options = { organizations?: string[]; project?: boolean; signedOut?: boolean };

/**
 * Journeys here involve several people at once (an owner, the person they invite, a removed member). Each actor is an
 * independent browser context with its own cookies and ingress address, provisioned through the real signup, mail
 * verification and organization APIs exactly like the shell fixtures, and closed (with the external-request guard
 * asserted) when the test ends. A signed-out actor skips provisioning for journeys that begin at a mailed link.
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
        await page.goto("/organizations?choose=1");
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
          ? { email: `${label}-${Math.random().toString(16).slice(2, 8)}@example.test`, organizations: [], projects: [] }
          : await provision(page, label, options);
        return { ...workspace, context, page, label, name: `Shell ${workspace.email.split("@")[0]}` };
      });
    } finally {
      for (const { context } of opened) await context.close();
      expect(opened.flatMap(({ unexpected }) => [...unexpected]), "Unexpected external requests from actors").toEqual([]);
    }
  },
});

export { expect };

type Member = { id: string; userId: string; role: string; user: { name: string; email: string } };
export type FullOrganization = { id: string; name: string; slug: string; members: Member[]; teams: Array<{ id: string; name: string }> };

/** Authoritative server state, fetched with the actor's own session. */
export async function fullOrganization(page: Page, organizationId: string) {
  await ensureOrigin(page);
  return api<FullOrganization>(page, `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(organizationId)}`);
}
export async function roles(page: Page, organizationId: string) {
  const { body } = await fullOrganization(page, organizationId);
  return Object.fromEntries(body.members.map(member => [member.user.email, member.role]));
}
export async function organizationList(page: Page) {
  await ensureOrigin(page);
  return (await api<Array<{ id: string; name: string; slug: string }>>(page, "/api/auth/organization/list")).body;
}
export async function invitations(page: Page, organizationId: string) {
  await ensureOrigin(page);
  return api<Array<{ id: string; email: string; role: string; status: string }>>(page, `/api/auth/organization/list-invitations?organizationId=${encodeURIComponent(organizationId)}`);
}
/** A page must be on the Worker origin for same-origin API calls. */
async function ensureOrigin(page: Page) {
  if (!page.url().startsWith(process.env.RENDRO_E2E_ORIGIN ?? "\0")) await page.goto("/organizations?choose=1");
}

/** Absolute invitation URL from the captured mail, restricted to the local Worker. */
export const invitationLink = (email: string, organizationName: string) =>
  mailLink(email, new RegExp(`^Join ${organizationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} on Rendro$`));

export const toasts = (page: Page) => page.locator("#cp-toasts .toast");
export const confirmDialog = (page: Page) => page.locator("#cp-confirm-dialog");

/** Open the shell page of an organization section and wait until it finished mounting. */
export async function openSection(page: Page, organizationId: string, section: "" | "people" | "teams" | "settings") {
  await page.goto(`/organizations/${organizationId}${section ? `/${section}` : ""}`);
  await expect(page.locator("button#cp-org-switcher")).toBeVisible();
  await expect(page.locator(".cp-content[aria-busy=true]")).toHaveCount(0);
  await expect(page.locator("#organization-content .loading-view, #organization-content [aria-busy=true]")).toHaveCount(0);
}

/** Owner invites and the person accepts, through the real authorization paths, to keep setup out of the journey under test. */
export async function join(owner: { page: Page }, organizationId: string, who: { page: Page; email: string }, role: "member" | "admin") {
  await ensureOrigin(owner.page);
  const invitation = await api<{ id: string }>(owner.page, "/api/auth/organization/invite-member", { organizationId, email: who.email, role });
  expect(invitation.status).toBe(200);
  await ensureOrigin(who.page);
  const accepted = await api(who.page, "/api/auth/organization/accept-invitation", { invitationId: invitation.body.id });
  expect(accepted.status).toBe(200);
}

/**
 * Cancel the destination navigation as a user pressing Stop would: the current document stays, so the page that completed
 * a write remains observable. `resume` restores real navigation, which
 * a recovery link then exercises.
 */
export async function stopNavigation(page: Page, glob: string | RegExp) {
  let seen = 0;
  const handler = async (route: Route) => {
    if (!route.request().isNavigationRequest()) { await route.continue(); return; }
    seen++;
    await route.abort("aborted");
  };
  await page.route(glob, handler);
  return { seen: () => seen, resume: () => page.unroute(glob, handler) };
}

/** Choose an option of an enhanced select by its accessible name; the popup closes on selection. */
export async function choose(page: Page, comboboxName: string | RegExp, option: string, within: Page | Locator = page) {
  const trigger = within.getByRole("combobox", { name: comboboxName });
  // A popup closes when the page scrolls, so bring the trigger into view before (not while) opening it.
  await trigger.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

/** The options of an enhanced select with their disabled state, read from the open popup and closed again. */
export async function optionsOf(page: Page, comboboxName: string | RegExp, within: Page | Locator = page) {
  const trigger = within.getByRole("combobox", { name: comboboxName });
  await trigger.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const listbox = page.getByRole("listbox", { name: comboboxName });
  await expect(listbox).toBeVisible();
  const options = await listbox.getByRole("option").evaluateAll(nodes => nodes.map(node => ({ text: node.textContent?.trim() ?? "", disabled: node.getAttribute("aria-disabled") === "true" })));
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  return options;
}

/**
 * Delay one matching response without delaying its content: the request is served immediately (a snapshot of the
 * server state at that moment) but handed to the page only on release. Proves a late, outdated response is ignored.
 */
export async function delayedSnapshot(page: Page, glob: string | RegExp) {
  let release!: () => void, held = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handler = async (route: Route) => {
    if (held++ > 0) { await route.continue(); return; }
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  };
  await page.route(glob, handler);
  return { release, held: () => held, close: async () => { release(); await page.unroute(glob, handler); } };
}

/** Fail the next matching request only, then let later ones through. */
export async function failOnce(page: Page, glob: string | RegExp, message: string, status = 500) {
  let failures = 0;
  const handler = async (route: Route) => {
    if (failures++ === 0) await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ message }) });
    else await route.continue();
  };
  await page.route(glob, handler);
  return { failures: () => Math.min(failures, 1), seen: () => failures, close: () => page.unroute(glob, handler) };
}
