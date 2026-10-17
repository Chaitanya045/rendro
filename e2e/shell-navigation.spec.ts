import type { Page } from "@playwright/test";
import { test, expect } from "./shell-fixtures";
import { holdRequest } from "./auth-helpers";
import { api, desktop, heading, holdFirst, provision, settleFrames, shellReady, signInSeeded } from "./shell-helpers";

/** Main-frame document loads: a client-routed management transition must create none. */
function trackDocuments(page: Page) {
  const documents: string[] = [];
  page.on("request", request => {
    if (request.resourceType() === "document" && request.frame() === page.mainFrame()) documents.push(new URL(request.url()).pathname);
  });
  return documents;
}

test.describe("management shell and same-organization navigation", () => {
  test.use({ viewport: desktop });

  test("management shell keeps its chrome while ten routes mount through the client router", async ({ page, context, baseURL, seed, cspViolations }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    const projectBase = `${base}/projects/${seed.projectId}`;
    await page.goto(base);
    await shellReady(page);

    // Initial chrome: organization identity, home destination and exact sidebar grouping.
    await expect(page.locator("#cp-org-switcher [data-org-name]")).toHaveText("E2E primary");
    await expect(page.locator("#cp-org-switcher [data-org-mark]")).toHaveText("E");
    await expect(page.locator("a.cp-brand")).toHaveAttribute("href", base);
    await expect(page.locator(".cp-nav .cp-nav-label")).toHaveText(["Organization", "Developer"]);
    await expect(page.locator(".cp-nav-link > span:not(.material-symbols-outlined)")).toHaveText(["Overview", "Projects", "People", "Teams", "Settings", "API keys"]);
    await expect(page.locator(".cp-nav-link[aria-current=page]")).toHaveText(/Overview/);
    await expect(page.locator(".cp-nav-link.active")).toHaveCount(1);
    // The route envelope identifies user and organization; the versioned public bundle matches the shell.
    const envelope = await page.locator(".cp-main").evaluate(main => ({ user: main.getAttribute("data-cp-user-id"), organization: main.getAttribute("data-cp-organization-id"), project: main.getAttribute("data-cp-project-id"), version: main.getAttribute("data-cp-shell-version") }));
    expect(envelope).toMatchObject({ organization: seed.organizationId, project: "" });
    expect(envelope.user).toBeTruthy();
    expect(await page.locator('script[src^="/management-pages.js?v="]').getAttribute("src")).toBe(`/management-pages.js?v=${envelope.version}`);
    // The documentation link is hidden outside an authorized, deployed project.
    await expect(page.locator(".cp-topbar [data-cp-open-docs]")).toBeHidden();
    // The account menu carries the identity, Account security and sign-out.
    await page.locator("#cp-avatar").click();
    await expect(page.locator(".cp-account-email")).toHaveText("owner@example.test");
    await expect(page.locator("#cp-account-menu").getByRole("link", { name: "Account security" })).toHaveAttribute("href", "/account/security");
    await expect(page.locator("#cp-account-menu").getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.evaluate(() => {
      (document.querySelector(".cp-topbar") as HTMLElement & { shellMarker?: string }).shellMarker = "kept";
      (window as unknown as { documentMarker: number }).documentMarker = 1;
    });
    const documents = trackDocuments(page);
    const nav = page.locator(".cp-nav");
    const visit = async (link: string, path: string, active: string) => {
      await nav.getByRole("link", { name: link, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await shellReady(page);
      await expect(page.locator(".cp-nav-link[aria-current=page]")).toHaveText(new RegExp(active));
    };
    await visit("Projects", `${base}/projects`, "Projects");
    await expect(heading(page)).toHaveText("Projects");
    await page.locator(".cp-main").getByRole("link", { name: "Worker publication" }).first().click();
    await expect(page).toHaveURL(new RegExp(`${projectBase}$`));
    await shellReady(page);
    await expect(heading(page)).toHaveText("Worker publication");
    // The client router replaces the page state; the initial document's envelope is not rewritten.
    expect(await page.evaluate(() => (window as unknown as { __RENDRO_PAGE_STATE__: { projectId: string } }).__RENDRO_PAGE_STATE__.projectId)).toBe(seed.projectId);
    // Docs entry appears once the active project is observed as deployed, and only for this project.
    await expect(page.locator(".cp-topbar [data-cp-open-docs]")).toBeVisible();
    await expect(page.locator(".cp-topbar [data-cp-open-docs]")).toHaveAttribute("href", `${projectBase}/docs`);
    for (const [tab, suffix] of [["Deployments", "/deployments"], ["Publications", "/publications"], ["Private shares", "/shares"], ["Overview", ""]] as const) {
      await page.locator(".project-tabs").getByRole("link", { name: tab, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${projectBase}${suffix}$`));
      await shellReady(page);
      await expect(page.locator(".project-tabs a[aria-current=page]")).toHaveText(tab);
    }
    await visit("People", `${base}/people`, "People");
    await expect(heading(page)).toHaveText("People");
    await visit("Teams", `${base}/teams`, "Teams");
    await expect(heading(page)).toHaveText("Teams");
    await visit("Settings", `${base}/settings`, "Settings");
    await expect(heading(page)).toHaveText("Settings");
    await visit("API keys", `${base}/api-keys`, "API keys");
    await expect(heading(page)).toHaveText("API keys");
    await visit("Overview", base, "Overview");
    // The project docs entry belongs to the project route only.
    await expect(page.locator(".cp-topbar [data-cp-open-docs]")).toBeHidden();

    expect(documents, "no document request for any of the ten client-routed destinations").toEqual([]);
    expect(await page.evaluate(() => (document.querySelector(".cp-topbar") as HTMLElement & { shellMarker?: string }).shellMarker)).toBe("kept");
    expect(await page.evaluate(() => (window as unknown as { documentMarker: number }).documentMarker)).toBe(1);
    // Every scripted swap ran under the current document nonce.
    expect(cspViolations).toEqual([]);
  });

  test("client navigation inserts a destination skeleton immediately and swaps authorized data in place", async ({ page, context, baseURL, seed, cspViolations }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    await page.goto(base);
    await shellReady(page);
    await page.evaluate(() => { (document.querySelector(".cp-topbar") as HTMLElement & { shellMarker?: string }).shellMarker = "kept"; });
    const hold = await holdRequest(page, "/api/auth/organization/list-invitations*");
    const documents = trackDocuments(page);
    try {
      await page.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
      // Skeleton, URL, heading, actions and active navigation update before data arrives.
      await expect(page).toHaveURL(new RegExp(`${base}/people$`));
      const pending = page.locator(".cp-content.cp-navigation-pending[aria-busy=true]");
      await expect(pending).toHaveAttribute("aria-label", "Loading People");
      await expect(heading(page)).toHaveText("People");
      await expect(heading(page)).toBeFocused();
      await expect(page.locator(".cp-nav-link[aria-current=page]")).toHaveText(/People/);
      await expect(page.locator(".cp-nav-link.active")).toHaveCount(1);
      await expect(page.locator("#cp-org-switcher [data-org-name]")).toHaveText("E2E primary");
      await expect.poll(() => hold.count(), "the data read is still held while the skeleton shows").toBeGreaterThan(0);
      hold.release();
      // Real data replaces the skeleton in the same container; nothing generic stays behind.
      await expect(page.locator(".cp-content[aria-busy]")).toHaveCount(0);
    } finally {
      await hold.close();
    }
    await expect(page.locator(".loading-view, .skeleton-table-row")).toHaveCount(0);
    await expect(page.getByText("E2E member", { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(/People/);
    expect(await page.evaluate(() => (document.querySelector(".cp-topbar") as HTMLElement & { shellMarker?: string }).shellMarker)).toBe("kept");
    expect(documents).toEqual([]);
    expect(cspViolations).toEqual([]);
  });

  test("modified, targeted, download and cross-organization links keep native navigation", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    await page.goto(base);
    await shellReady(page);
    // Record what the shell's delegated handler decided without altering it.
    await page.evaluate(otherOrganizationId => {
      const w = window as unknown as { prevented: Record<string, boolean> };
      w.prevented = {};
      window.addEventListener("click", event => {
        const link = (event.target as Element).closest("a");
        if (link?.dataset.probe) w.prevented[link.dataset.probe + (event.ctrlKey ? "+ctrl" : "")] = event.defaultPrevented;
      });
      const host = document.querySelector(".cp-main") as HTMLElement;
      const add = (probe: string, href: string, attributes: Record<string, string> = {}) => {
        const link = document.createElement("a");
        link.href = href; link.textContent = probe; link.dataset.probe = probe;
        Object.entries(attributes).forEach(([name, value]) => link.setAttribute(name, value));
        link.style.display = "block";
        host.prepend(link);
      };
      add("plain", `${location.pathname}/people`);
      add("blank", `${location.pathname}/people`, { target: "_blank" });
      add("download", `${location.pathname}/people`, { download: "people.html" });
      add("external", `${location.pathname}/people`, { rel: "external" });
      add("onboarding", `${location.pathname}/onboarding`);
      add("cross", `/organizations/${otherOrganizationId}/people`);
      add("unsupported", `${location.pathname}/unsupported-route`);
    }, seed.otherOrganizationId);

    // A plain primary click is intercepted exactly once and stays a client transition.
    const documents = trackDocuments(page);
    await page.locator('a[data-probe="plain"]').click();
    await expect(page).toHaveURL(new RegExp(`${base}/people$`));
    await shellReady(page);
    expect(documents).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { prevented: Record<string, boolean> }).prevented.plain)).toBe(true);

    // Modified clicks are never claimed by the router. Engines that open a tab get a real second page.
    await page.goto(base);
    await shellReady(page);
    await page.evaluate(() => { document.querySelector<HTMLElement>(".cp-main")!.dataset.pristine = "yes"; });
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const opened = context.waitForEvent("page", { timeout: 4000 }).catch(() => null);
    await page.locator(".cp-nav").getByRole("link", { name: "Teams", exact: true }).click({ modifiers: [modifier] });
    const popup = await opened;
    if (popup) {
      await popup.waitForURL(new RegExp(`${base}/teams$`));
      await popup.close();
    }
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(page.locator(".cp-main")).toHaveAttribute("data-pristine", "yes");
    await expect(page.locator(".cp-navigation-pending")).toHaveCount(0);
    await page.locator(".cp-nav").getByRole("link", { name: "Teams", exact: true }).click({ button: "middle" });
    await context.pages().filter(candidate => candidate !== page).reduce(async (previous, other) => { await previous; await other.close(); }, Promise.resolve());
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(page.locator(".cp-navigation-pending")).toHaveCount(0);

    // Target, download, external, unsupported and onboarding links are left to the browser.
    await page.goto(base);
    await shellReady(page);
    await page.evaluate(() => {
      const w = window as unknown as { prevented: Record<string, boolean> };
      w.prevented = {};
      window.addEventListener("click", event => {
        const link = (event.target as Element).closest("a");
        if (link?.dataset.probe) { w.prevented[link.dataset.probe] = event.defaultPrevented; event.preventDefault(); }
      });
      const host = document.querySelector(".cp-main") as HTMLElement;
      const add = (probe: string, href: string, attributes: Record<string, string> = {}) => {
        const link = document.createElement("a");
        link.href = href; link.textContent = probe; link.dataset.probe = probe;
        Object.entries(attributes).forEach(([name, value]) => link.setAttribute(name, value));
        link.style.display = "block";
        host.prepend(link);
      };
      add("blank", `${location.pathname}/people`, { target: "_blank" });
      add("download", `${location.pathname}/people`, { download: "people.html" });
      add("external", `${location.pathname}/people`, { rel: "external" });
      add("onboarding", `${location.pathname}/onboarding`);
      add("unsupported", `${location.pathname}/unsupported-route`);
    });
    for (const probe of ["blank", "download", "external", "onboarding", "unsupported"]) await page.locator(`a[data-probe="${probe}"]`).click();
    expect(await page.evaluate(() => (window as unknown as { prevented: Record<string, boolean> }).prevented)).toEqual({
      blank: false, download: false, external: false, onboarding: false, unsupported: false,
    });
    // Cross-organization and account links perform real document navigations.
    await page.goto(base);
    await shellReady(page);
    const crossDocuments = trackDocuments(page);
    await page.locator("#cp-avatar").click();
    await page.locator("#cp-account-menu").getByRole("link", { name: "Account security" }).click();
    await expect(page).toHaveURL(/\/account\/security$/);
    await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeVisible();
    expect(crossDocuments).toContain("/account/security");
  });

  test("visiting an explicit organization URL does not change the active organization", async ({ page, pooled }) => {
    const [alpha, beta] = [pooled.organizations[2], pooled.organizations[3]];
    const active = async () => (await api<{ session: { activeOrganizationId?: string | null } }>(page, "/api/auth/get-session?disableCookieCache=true")).body.session.activeOrganizationId ?? null;
    await page.goto(`/organizations/${alpha.id}`);
    await shellReady(page);
    const before = await active();
    await page.goto(`/organizations/${beta.id}/people`);
    await expect(heading(page)).toHaveText("People");
    await page.goto(`/organizations/${alpha.id}/teams`);
    await expect(heading(page)).toHaveText("Teams");
    expect(await active()).toBe(before);
  });
});

test.describe("management navigation without JavaScript", () => {
  test.use({ viewport: desktop, javaScriptEnabled: false });

  test("HTML-only management navigation completes with plain links", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    await page.goto(base);
    await expect(heading(page)).toBeVisible();
    // The switcher is only an ordinary chooser link until scripts upgrade it.
    await expect(page.locator("a#cp-org-switcher")).toHaveAttribute("href", "/organizations?choose=1");
    const documents = trackDocuments(page);
    for (const [link, path] of [["People", "/people"], ["Teams", "/teams"], ["Settings", "/settings"], ["API keys", "/api-keys"], ["Projects", "/projects"]] as const) {
      await page.locator(".cp-nav").getByRole("link", { name: link, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${base}${path}$`));
      await expect(heading(page)).toHaveText(link);
      await expect(page.locator(".cp-nav-link[aria-current=page]")).toHaveText(new RegExp(link));
    }
    expect(documents).toEqual([`${base}/people`, `${base}/teams`, `${base}/settings`, `${base}/api-keys`, `${base}/projects`]);
    await page.locator("a#cp-org-switcher").click();
    await expect(page).toHaveURL(/\/organizations\?choose=1$/);
    await expect(page.locator("body")).toContainText("Your organizations");
  });
});

test.describe("management history, blockers and cancellation", () => {
  test.use({ viewport: { width: 1440, height: 300 } });

  test("Back and Forward restore route and fragment; heading focus does not steal later focus", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    await page.goto(base);
    await shellReady(page);
    const hold = await holdRequest(page, "/api/auth/organization/list-invitations*");
    try {
      await page.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
      await expect(heading(page)).toBeFocused();
      // Later user focus moves to another control; arriving data must not move it back.
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("H1");
      const focused = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? "");
      hold.release();
      await expect(page.locator(".cp-content[aria-busy]")).toHaveCount(0);
      expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? "")).toBe(focused);
    } finally {
      await hold.close();
    }
    // Same-document fragment: ordinary browser behavior, no route swap.
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "1200px";
      spacer.id = "tall-spacer";
      document.querySelector(".cp-content")!.append(spacer);
      const anchor = document.createElement("a");
      anchor.href = "#tall-spacer"; anchor.textContent = "jump"; anchor.id = "jump-link";
      document.querySelector(".cp-content")!.prepend(anchor);
      (document.querySelector(".cp-content") as HTMLElement).dataset.pristine = "yes";
    });
    await page.locator("#jump-link").click();
    await expect(page).toHaveURL(new RegExp(`${base}/people#tall-spacer$`));
    await expect(page.locator(".cp-content")).toHaveAttribute("data-pristine", "yes");
    await expect(page.locator(".cp-navigation-pending")).toHaveCount(0);

    await page.locator(".cp-nav").getByRole("link", { name: "Teams", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
    await shellReady(page);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${base}/people#tall-spacer$`));
    await expect(heading(page)).toHaveText("People");
    // Back-navigation focus: the heading is not claimed on history restoration.
    expect(await page.evaluate(() => document.activeElement === document.querySelector(".cp-page-heading"))).toBe(false);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${base}/people$`));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(page.locator(".cp-nav-link[aria-current=page]")).toHaveText(/Overview/);
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${base}/people$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${base}/people#tall-spacer$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
    await expect(heading(page)).toHaveText("Teams");
    await expect(page.locator(".cp-nav-link[aria-current=page]")).toHaveText(/Teams/);
  });

  test("Back restores the saved scroll offset of a client-routed page", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    await page.goto(`${base}/people`);
    await shellReady(page);
    await expect(page.getByText("E2E member", { exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 200));
    expect(await page.evaluate(() => window.scrollY)).toBe(200);
    await page.locator(".cp-nav").getByRole("link", { name: "Teams", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
    await shellReady(page);
    await page.goBack();
    await expect(page.getByText("E2E member", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 3000 }).toBe(200);
  });
});

test.describe("rapid, blocked and stale navigation", () => {
  test.use({ viewport: desktop });

  test("rapid navigation ignores the older response and a repeated destination retries in place", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    await page.goto(base);
    await shellReady(page);
    const nav = page.locator(".cp-nav");
    // Only People's first roster read is held; Teams' own read is not.
    const hold = await holdFirst(page, "**/api/auth/organization/get-full-organization*");
    try {
      await nav.getByRole("link", { name: "People", exact: true }).click();
      await expect(page.locator(".cp-content[aria-busy=true]")).toHaveAttribute("aria-label", "Loading People");
      await expect.poll(() => hold.held()).toBe(1);
      // Navigate again before People settles: Teams wins and People may not repaint later.
      await nav.getByRole("link", { name: "Teams", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
      await expect(page.getByText("Assign organization members")).toHaveCount(1);
      hold.release();
      await hold.delivered();
      await settleFrames(page);
      await expect(heading(page)).toHaveText("Teams");
      await expect(page.getByText("Pending invitations")).toHaveCount(0);
      await expect(page.getByText("USER", { exact: true })).toHaveCount(0);
      await expect(page.locator(".cp-nav-link[aria-current=page]")).toHaveText(/Teams/);
    } finally {
      await hold.close();
    }

    // The same destination, requested again while its first read is pending, replaces the entry.
    const again = await holdFirst(page, "**/api/auth/organization/get-full-organization*");
    try {
      await nav.getByRole("link", { name: "People", exact: true }).click();
      await expect(page.locator(".cp-content[aria-busy=true]")).toHaveAttribute("aria-label", "Loading People");
      await expect.poll(() => again.held()).toBe(1);
      const entries = await page.evaluate(() => history.length);
      await nav.getByRole("link", { name: "People", exact: true }).click();
      expect(await page.evaluate(() => history.length)).toBe(entries);
      again.release();
      await expect(page.locator(".cp-content[aria-busy]")).toHaveCount(0);
      await expect(page.locator(".cp-content").getByText("E2E member", { exact: true })).toHaveCount(1);
      await expect(page.locator(".cp-content")).toHaveCount(1);
      await expect(page).toHaveURL(new RegExp(`${base}/people$`));
    } finally {
      await again.close();
    }
  });

  test("an open dialog, a pending write and a stale-data notice block departure and refresh", async ({ page, pooled }) => {
    const base = `/organizations/${pooled.organizations[0].id}`;
    await page.goto(`${base}/teams`);
    await shellReady(page);
    await expect(page.getByText("Assign organization members")).toHaveCount(1);
    const programmaticNav = (name: string) => page.locator(".cp-nav").getByRole("link", { name, exact: true }).evaluate((link: HTMLElement) => link.click());

    // A second tab commits a change; this tab offers Refresh without disturbing its dialog or draft.
    await page.locator(".cp-page-actions").getByRole("button", { name: "Create team" }).click();
    const dialog = page.locator("#team-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Team name").fill("Draft kept");
    const other = await page.context().newPage();
    await other.goto(`${base}/teams`);
    await shellReady(other);
    await other.locator(".cp-page-actions").getByRole("button", { name: "Create team" }).click();
    await other.locator("#team-dialog").getByLabel("Team name").fill("Created elsewhere");
    await other.locator("#team-dialog").getByRole("button", { name: "Create team" }).click();
    await expect(other.getByRole("heading", { name: "Created elsewhere" })).toBeVisible();
    await expect(page.locator("#cp-refresh-notice")).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Team name")).toHaveValue("Draft kept");

    // Open dialog: route swaps, Back and manual refresh are all blocked.
    await programmaticNav("Overview");
    await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
    await page.locator("#cp-refresh-button").evaluate((button: HTMLElement) => button.click());
    await expect(page.locator("#cp-refresh-notice")).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("heading", { name: "Created elsewhere" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Without a blocker the same refresh replaces the entry with fresh data and hides the notice.
    const entries = await page.evaluate(() => history.length);
    await page.locator("#cp-refresh-button").click();
    await expect(page.getByRole("heading", { name: "Created elsewhere" })).toBeVisible();
    await expect(page.locator("#cp-refresh-notice")).toBeHidden();
    expect(await page.evaluate(() => history.length)).toBe(entries);
    await other.close();

    // A pending write blocks Cancel, Escape and departure; success releases them.
    const hold = await holdRequest(page, "/api/auth/organization/create-team");
    try {
      await page.locator(".cp-page-actions").getByRole("button", { name: "Create team" }).click();
      await dialog.getByLabel("Team name").fill("Pending team");
      await dialog.getByRole("button", { name: "Create team" }).click();
      await expect(dialog.locator("button[type=submit]")).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => hold.count()).toBe(1);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await programmaticNav("Settings");
      await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
      hold.release();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("heading", { name: "Pending team" })).toBeVisible();
    } finally {
      await hold.close();
    }
    await page.locator(".cp-nav").getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/settings$`));
  });

  test("blocked Back reverses to the current route and later Back works", async ({ page, pooled }) => {
    const base = `/organizations/${pooled.organizations[1].id}`;
    await page.goto(base);
    await shellReady(page);
    await page.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/people$`));
    await shellReady(page);
    await page.locator(".cp-nav").getByRole("link", { name: "Teams", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
    await shellReady(page);
    await page.locator(".cp-page-actions").getByRole("button", { name: "Create team" }).click();
    const dialog = page.locator("#team-dialog");
    await expect(dialog).toBeVisible();
    const index = await page.evaluate(() => (history.state as { __rendroManagementIndex: number }).__rendroManagementIndex);
    await page.goBack();
    await expect.poll(() => page.evaluate(() => (history.state as { __rendroManagementIndex: number }).__rendroManagementIndex)).toBe(index);
    await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
    await expect(dialog).toBeVisible();
    await expect(heading(page)).toHaveText("Teams");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${base}/people$`));
    await expect(heading(page)).toHaveText("People");
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${base}/teams$`));
  });

  test("a late response from a disposed page cannot repaint the destination", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const base = `/organizations/${seed.organizationId}`;
    await page.goto(`${base}/teams`);
    await shellReady(page);
    await expect(page.getByText("Assign organization members")).toHaveCount(1);
    const hold = await holdFirst(page, "**/api/auth/organization/get-full-organization*");
    try {
      await page.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
      await expect(page.locator(".cp-content[aria-busy=true]")).toBeVisible();
      await expect.poll(() => hold.held()).toBe(1);
      await page.locator(".cp-nav").getByRole("link", { name: "Settings", exact: true }).click();
      await expect(heading(page)).toHaveText("Settings");
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("E2E primary");
      hold.release();
      await hold.delivered();
      await settleFrames(page);
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("E2E primary");
      await expect(page.getByText("Pending invitations")).toHaveCount(0);
      await expect(page.locator(".cp-content").getByText("E2E member", { exact: true })).toHaveCount(0);
    } finally {
      await hold.close();
    }
  });
});

test.describe("organization departure and authorization freshness", () => {
  test.use({ viewport: desktop });

  test("dirty settings ask once before leaving for another organization and roll back when declined", async ({ page, pooled }) => {
    const [alpha, beta] = [pooled.organizations[2], pooled.organizations[3]];
    const dialogs: string[] = [];
    let answer: "accept" | "dismiss" = "dismiss";
    page.on("dialog", async dialog => {
      dialogs.push(`${dialog.type()}:${dialog.message()}`);
      if (answer === "accept") await dialog.accept(); else await dialog.dismiss();
    });
    await page.goto(`/organizations/${alpha.id}/settings`);
    await shellReady(page);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Pool C");
    await page.getByLabel("Name", { exact: true }).fill("Pool C edited");
    const trigger = page.locator("button#cp-org-switcher");
    const choose = async () => {
      await trigger.click();
      await page.getByRole("menuitem", { name: "Pool D", exact: true }).click();
    };

    // Declined: no navigation, label and focus restored, no leftover one-use hint.
    await choose();
    await expect(trigger).not.toHaveAttribute("aria-busy", "true");
    await expect(page).toHaveURL(new RegExp(`/organizations/${alpha.id}/settings$`));
    await expect(trigger.locator("[data-org-name]")).toHaveText("Pool C");
    await expect(trigger).toBeFocused();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Pool C edited");
    expect(await page.evaluate(() => sessionStorage.getItem("rendro-org-navigation-label"))).toBeNull();
    expect(dialogs).toEqual(["confirm:Discard unsaved organization changes?"]);

    // Accepted: exactly one discard prompt and no second native unload prompt.
    answer = "accept";
    await choose();
    await expect(page).toHaveURL(new RegExp(`/organizations/${beta.id}/settings$`));
    await shellReady(page);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Pool D");
    expect(dialogs).toEqual(["confirm:Discard unsaved organization changes?", "confirm:Discard unsaved organization changes?"]);
    await expect(trigger.locator("[data-org-name]")).toHaveText("Pool D");
  });

  test("revoked membership and a changed account are rejected instead of painting cached data", async ({ page, secondContext }, info) => {
    const owner = await provision(page, `fresh-owner-${info.project.name}`, { organizations: ["Fresh"] });
    const base = `/organizations/${owner.organizations[0].id}`;
    const memberPage = await secondContext.newPage();
    const member = await provision(memberPage, `fresh-member-${info.project.name}`);
    const invitation = await api<{ id: string }>(page, "/api/auth/organization/invite-member", { organizationId: owner.organizations[0].id, email: member.email, role: "member" });
    expect(invitation.status).toBe(200);
    expect((await api(memberPage, "/api/auth/organization/accept-invitation", { invitationId: invitation.body.id })).status).toBe(200);

    await memberPage.goto(base);
    await shellReady(memberPage);
    await memberPage.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
    await expect(memberPage.locator(".cp-content").getByText(owner.email, { exact: true })).toBeVisible();
    await memberPage.locator(".cp-nav").getByRole("link", { name: "Teams", exact: true }).click();
    await expect(memberPage.getByRole("heading", { name: "Teams" }).first()).toBeVisible();

    const removal = await api(page, "/api/auth/organization/remove-member", { memberIdOrEmail: member.email, organizationId: owner.organizations[0].id });
    expect(removal.status).toBe(200);
    // The People roster is still cached in the member's tab; fresh authorization must reject it.
    await memberPage.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
    await expect(memberPage.locator(".cp-content").getByText(owner.email, { exact: true })).toHaveCount(0);
    await expect(memberPage.locator(".cp-content")).not.toContainText("fresh-owner");
    await expect(memberPage.locator(".cp-content")).toContainText(/Unable to/);

    // A different signed-in account in the same tab never reads the previous account's cache.
    const stranger = await api(memberPage, "/api/auth/sign-in/email", { email: owner.email, password: "Local fixture password 109!" });
    expect(stranger.status).toBe(200);
    await memberPage.goto(`${base}/teams`);
    await shellReady(memberPage);
    await memberPage.locator(".cp-nav").getByRole("link", { name: "Settings", exact: true }).click();
    await expect(memberPage.getByLabel("Name", { exact: true })).toHaveValue("Fresh");
    const swap = await api(memberPage, "/api/auth/sign-in/email", { email: member.email, password: "Local fixture password 109!" });
    expect(swap.status).toBe(200);
    await memberPage.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
    await expect(memberPage.locator(".cp-content").getByText(owner.email, { exact: true })).toHaveCount(0);
    await expect(memberPage.locator(".cp-content")).toContainText(/Unable to/);
    await expect(memberPage.locator(".cp-content")).not.toContainText("Fresh");
  });
});

test.describe("authenticated HTML fallback", () => {
  test.use({ viewport: desktop });

  test("an unavailable public page bundle falls back to authenticated HTML under the document nonce without persisting it", async ({ page, context, baseURL, seed, cspViolations }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    await page.route("**/management-pages.js*", route => route.abort());
    const base = `/organizations/${seed.organizationId}`;
    const fetched: Array<{ path: string; cache: string | undefined }> = [];
    page.on("response", response => {
      const request = response.request();
      if (request.resourceType() === "fetch" && request.headers().accept?.includes("text/html")) fetched.push({ path: new URL(response.url()).pathname, cache: response.headers()["cache-control"] });
    });
    const initial = await page.goto(base);
    const nonce = initial?.headers()["content-security-policy"]?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    await shellReady(page);
    const documents = trackDocuments(page);
    await page.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/people$`));
    await expect(page.locator(".cp-content").getByText("E2E member", { exact: true })).toBeVisible();
    await expect(page.locator(".cp-content[aria-busy]")).toHaveCount(0);
    // A real HTML fetch, accepted only for the same route/organization/user, executed under the document nonce.
    expect(fetched.map(entry => entry.path)).toEqual([`${base}/people`]);
    expect(fetched[0].cache).toMatch(/no-store/);
    expect(documents).toEqual([]);
    expect(await page.locator("script[data-cp-page-script]").evaluate(script => (script as HTMLScriptElement).nonce)).toBe(nonce);
    // Private HTML is not written to web storage or the Cache API.
    const stored = await page.evaluate(async () => ({
      local: Object.values(localStorage).concat(Object.values(sessionStorage)).join("\n"),
      caches: typeof caches === "undefined" ? [] : await caches.keys(),
    }));
    expect(stored.local).not.toContain("data-cp-user-id");
    expect(stored.local).not.toContain("cp-main");
    expect(stored.caches).toEqual([]);
    expect(cspViolations).toEqual([]);
  });

  test("invalid, mismatched or stalled authenticated HTML falls back to a full navigation", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    await page.route("**/management-pages.js*", route => route.abort());
    const base = `/organizations/${seed.organizationId}`;
    let mode: "invalid" | "mismatch" | "stall" = "invalid";
    const stalled: Array<() => void> = [];
    await page.route(`**${base}/**`, async route => {
      const request = route.request();
      if (request.resourceType() !== "fetch" || !request.headers().accept?.includes("text/html")) return route.continue();
      if (mode === "invalid") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>x</title><main>not a management document</main>" });
      if (mode === "mismatch") {
        const real = await route.fetch();
        return route.fulfill({ response: real, body: (await real.text()).replace(/data-cp-organization-id="[^"]*"/, 'data-cp-organization-id="other-organization"') });
      }
      return new Promise<void>(resolve => { stalled.push(resolve); });
    });
    await page.clock.install();
    await page.goto(base);
    await shellReady(page);
    for (const [link, path] of [["People", "/people"], ["Teams", "/teams"]] as const) {
      mode = path === "/people" ? "invalid" : "mismatch";
      const documents = trackDocuments(page);
      await page.locator(".cp-nav").getByRole("link", { name: link, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${base}${path}$`));
      await expect.poll(() => documents).toContain(`${base}${path}`);
      await expect(heading(page)).toHaveText(link);
      await shellReady(page);
    }
    // A response that never arrives is abandoned after 15 seconds and the page navigates natively.
    mode = "stall";
    const documents = trackDocuments(page);
    await page.locator(".cp-nav").getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.locator(".cp-content[aria-busy=true]")).toBeVisible();
    await page.clock.fastForward(16_000);
    await expect.poll(() => documents).toContain(`${base}/settings`);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("E2E primary");
    stalled.forEach(resolve => resolve());
  });
});
