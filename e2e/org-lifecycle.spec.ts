import { test, expect, fullOrganization, organizationList, roles, toasts, openSection, join, stopNavigation } from "./org-fixtures";
import { holdRequest } from "./auth-helpers";
import { api, holdFirst, settleFrames, heading } from "./shell-helpers";

test.describe("organization chooser", () => {
  test("a user without an organization creates the first one: slug derivation, validation, pending, conflict and retry", async ({ actor }) => {
    const taken = await actor("taken", { organizations: ["Already Taken"] });
    const user = await actor("zero");
    const { page } = user;

    // Skeleton while the list read is pending, then the zero-organization creation form.
    const list = await holdFirst(page, "**/api/auth/organization/list");
    await page.goto("/organizations");
    await expect(page.locator("#organization-state .loading-view[aria-busy=true]")).toContainText("Loading organizations");
    await expect.poll(() => list.held()).toBe(1);
    await list.close();
    await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/organizations");
    const steps = page.getByLabel("Setup progress").locator(".step");
    await expect(steps).toHaveText(["1Organization", "2Project", "3First deployment"]);
    await expect(steps.nth(0)).toHaveAttribute("aria-current", "step");
    await expect(page.locator(".step[aria-current=step]")).toHaveCount(1);

    const name = page.getByLabel("Organization name", { exact: true });
    const slug = page.getByRole("textbox", { name: /^Organization slug/ });
    const submit = page.getByRole("button", { name: "Create organization", exact: true });
    const error = page.locator("#organization-error");
    // The slug follows the name until its first manual edit, and then stays put.
    await name.fill("Acme  Docs & Co!");
    await expect(slug).toHaveValue("acme-docs-co");
    await slug.fill("custom-slug");
    await name.fill("Different Name");
    await expect(slug).toHaveValue("custom-slug");
    // Length limits apply while typing: 80 characters of name, 48 of slug.
    await name.fill("");
    await name.pressSequentially("n".repeat(85));
    await expect(name).toHaveValue("n".repeat(80));
    await slug.fill("");
    await slug.pressSequentially("s".repeat(60));
    await expect(slug).toHaveValue("s".repeat(48));
    await slug.fill("custom-slug");

    const create = await holdRequest(page, "/api/auth/organization/create");
    try {
      // Native validation stops both an empty name and a non-conforming slug before any request, and focuses the field.
      await name.fill("");
      await submit.click();
      await expect(name).toBeFocused();
      expect(await name.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
      await name.fill("Zero Org");
      await slug.fill("Not A Slug");
      await submit.click();
      await expect(slug).toBeFocused();
      expect(await slug.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
      await settleFrames(page);
      expect(create.count()).toBe(0);

      // A whitespace-only name passes the native check and is rejected by the server; nothing is created and the form stays usable.
      await name.fill("   ");
      await slug.fill(`ws-${Date.now().toString(36)}`);
      const whitespace = submit.click();
      await expect.poll(() => create.count()).toBe(1);
      create.release();
      await whitespace;
      await expect(error).not.toBeEmpty();
      await expect(error).toHaveAttribute("role", "alert");
      await expect(submit).toBeEnabled();
      await expect(submit).not.toHaveAttribute("aria-busy", "true");
      expect(await organizationList(page)).toEqual([]);
    } finally {
      await create.close();
    }

    // Conflict with another organization's slug: pending state excludes a second submission, failure keeps the inputs.
    const pending = await holdRequest(page, "/api/auth/organization/create");
    try {
      await name.fill("  Zero Org  ");
      await slug.fill(taken.organizations[0].slug);
      await submit.click();
      await expect(submit).toHaveAttribute("aria-busy", "true");
      await expect(submit).toBeDisabled();
      await name.press("Enter");
      await settleFrames(page);
      expect(pending.count()).toBe(1);
      pending.release();
      await expect(error).toHaveText("Organization already exists");
      await expect(submit).toBeEnabled();
      await expect(submit).not.toHaveAttribute("aria-busy", "true");
      await expect(name).toHaveValue("  Zero Org  ");
      await expect(slug).toHaveValue(taken.organizations[0].slug);
      expect(await organizationList(page)).toEqual([]);
    } finally {
      await pending.close();
    }

    // Correct the slug and retry: the completed state is announced, offers a link, and lands on onboarding.
    const unique = `zero-${Date.now().toString(36)}`;
    await slug.fill(unique);
    const stop = await stopNavigation(page, "**/organizations/*/onboarding");
    await submit.click();
    await expect.poll(() => stop.seen()).toBe(1);
    await expect(page.locator("#organization-form [role=status]")).toHaveText("Created. Continue to project setup.");
    const proceed = page.getByRole("link", { name: "Continue", exact: true });
    await expect(proceed).toHaveAttribute("href", /\/onboarding$/);
    await expect(submit).toBeDisabled();
    expect(new URL(page.url()).pathname).toBe("/organizations");
    // The recovery link completes the interrupted navigation without creating anything again.
    await stop.resume();
    await proceed.click();
    await expect(page).toHaveURL(/\/organizations\/[^/]+\/onboarding$/);
    const created = await organizationList(page);
    expect(created).toEqual([expect.objectContaining({ name: "Zero Org", slug: unique })]);
    expect(page.url()).toContain(`/organizations/${created[0].id}/onboarding`);
    expect(await roles(page, created[0].id)).toEqual({ [user.email]: "owner" });
    await expect(page.getByRole("heading", { name: "Create your first project", level: 2 })).toBeVisible();
  });

  test("one organization redirects without a history entry; the forced chooser lists cards and a second creation lands on its overview", async ({ actor }) => {
    const user = await actor("solo", { organizations: ["Solo Org"] });
    const { page } = user;
    const [solo] = user.organizations;
    await page.goto("/account/security");
    await page.goto("/organizations");
    await expect(page).toHaveURL(new RegExp(`/organizations/${solo.id}$`));
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/account/security");

    // choose=1 keeps the chooser: one card with mark, name, slug and an Open affordance.
    await page.goto("/organizations?choose=1");
    await expect(page.getByRole("heading", { name: "Your organizations" })).toBeVisible();
    const card = page.locator("#organization-list .organization-card");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("href", `/organizations/${solo.id}`);
    await expect(card.locator(".cp-org-mark")).toHaveText("S");
    await expect(card.locator("strong")).toHaveText("Solo Org");
    await expect(card.locator(".cell-secondary")).toHaveText(solo.slug);
    await expect(card.locator(".organization-arrow")).toHaveText("Open");
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/organizations?choose=1");

    // New organization replaces the chooser with the form; the second organization goes to its overview, not onboarding.
    await page.getByRole("button", { name: "New organization", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
    await expect(page.locator("#organization-list")).toHaveCount(0);
    await page.getByLabel("Organization name", { exact: true }).fill("Second Org");
    const secondSlug = `second-${Date.now().toString(36)}`;
    await page.getByRole("textbox", { name: /^Organization slug/ }).fill(secondSlug);
    const stop = await stopNavigation(page, "**/organizations/*");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect.poll(() => stop.seen()).toBe(1);
    await expect(page.locator("#organization-form [role=status]")).toHaveText("Created. Continue to your organization.");
    await stop.resume();
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    const second = (await organizationList(page)).find(candidate => candidate.slug === secondSlug)!;
    await expect(page).toHaveURL(new RegExp(`/organizations/${second.id}$`));
    await expect(page.locator("[data-org-name]").first()).toHaveText("Second Org");
    expect(await roles(page, second.id)).toEqual({ [user.email]: "owner" });

    // Many organizations never auto-redirect; hostile names are text; a card opens its organization by keyboard.
    const hostile = `Zed <b>bold</b> & "co"`;
    expect((await api(page, "/api/auth/organization/create", { name: hostile, slug: `hostile-${Date.now().toString(36)}` })).status).toBe(200);
    await page.goto("/organizations");
    const cards = page.locator("#organization-list .organization-card");
    await expect(cards).toHaveCount(3);
    expect(new URL(page.url()).pathname).toBe("/organizations");
    expect((await cards.locator("strong").allInnerTexts()).sort()).toEqual(["Second Org", "Solo Org", hostile].sort());
    await expect(cards.locator("b")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await cards.filter({ hasText: "Second Org" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/organizations/${second.id}$`));
  });

  test("a failed organization list shows a recoverable error and Try again lists the organizations", async ({ actor }) => {
    const user = await actor("flaky", { organizations: ["Flaky One", "Flaky Two"] });
    const { page } = user;
    let reads = 0;
    await page.route("**/api/auth/organization/list", async route => {
      if (reads++ === 0) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Organization service is down" }) });
      else await route.continue();
    });
    await page.goto("/organizations");
    await expect(page.getByRole("heading", { name: "Unable to load organizations" })).toBeVisible();
    await expect(page.locator("#organization-state .empty p")).toHaveText("Organization service is down");
    await expect(page.locator("#organization-list")).toHaveCount(0);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.locator("#organization-list .organization-card strong")).toHaveText(["Flaky One", "Flaky Two"]);
    await expect(page.getByRole("heading", { name: "Unable to load organizations" })).toHaveCount(0);
    expect(reads).toBe(2);
  });
});

test.describe("organization settings and deletion", () => {
  test("settings guard unsaved edits, save canonical values to the chrome and server, and report a slug conflict without losing edits", async ({ actor }) => {
    const rival = await actor("rival", { organizations: ["Rival Org"] });
    const owner = await actor("rename", { organizations: ["Rename Me"] });
    const { page } = owner;
    const [organization] = owner.organizations;
    const dialogs: string[] = [];
    let answer: "accept" | "dismiss" = "dismiss";
    page.on("dialog", dialog => { dialogs.push(dialog.message()); void (answer === "accept" ? dialog.accept() : dialog.dismiss()); });
    await openSection(page, organization.id, "settings");
    const name = page.getByLabel("Name", { exact: true }), slug = page.getByLabel("Slug", { exact: true });
    const save = page.getByRole("button", { name: "Save changes", exact: true });
    await expect(name).toHaveValue("Rename Me");
    await expect(slug).toHaveValue(organization.slug);

    // Each field alone makes the form dirty and guarded.
    const people = page.locator(".cp-nav").getByRole("link", { name: "People", exact: true });
    await name.fill("Name only");
    await people.click();
    await expect.poll(() => dialogs.length).toBe(1);
    await name.fill("Rename Me");
    await slug.fill("slug-only-edit");
    await people.click();
    await expect.poll(() => dialogs.length).toBe(2);
    await slug.fill(organization.slug);
    await expect(page).toHaveURL(new RegExp(`/organizations/${organization.id}/settings$`));
    dialogs.length = 0;

    // A dirty form asks before leaving; declining keeps the page and the edits, accepting leaves.
    const newSlug = `renamed-${Date.now().toString(36)}`;
    await name.fill("  Renamed Org  ");
    await slug.fill(newSlug);
    await page.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
    await expect.poll(() => dialogs).toEqual(["Discard unsaved organization changes?"]);
    await expect(page).toHaveURL(new RegExp(`/organizations/${organization.id}/settings$`));
    await expect(name).toHaveValue("  Renamed Org  ");
    await expect(slug).toHaveValue(newSlug);

    // Pending save disables the control; a slug owned by another organization is rejected and the edits survive.
    const update = await holdRequest(page, "/api/auth/organization/update");
    try {
      await slug.fill(rival.organizations[0].slug);
      await save.click();
      await expect(save).toHaveAttribute("aria-busy", "true");
      await expect(save).toBeDisabled();
      await expect.poll(() => update.count()).toBe(1);
      update.release();
      await expect(page.locator("#settings-error")).not.toBeEmpty();
      await expect(page.locator("#settings-error")).toHaveAttribute("role", "alert");
      await expect(save).toBeEnabled();
      await expect(save).not.toHaveAttribute("aria-busy", "true");
      await expect(name).toHaveValue("  Renamed Org  ");
      await expect(slug).toHaveValue(rival.organizations[0].slug);
      expect((await fullOrganization(page, organization.id)).body).toMatchObject({ name: "Rename Me", slug: organization.slug });
    } finally {
      await update.close();
    }

    // Correct and save: canonical (trimmed) values replace the fields, the chrome follows, the guard is cleared.
    await slug.fill(newSlug);
    await save.click();
    await expect(toasts(page)).toHaveText(["Organization settings saved."]);
    await expect(name).toHaveValue("Renamed Org");
    await expect(slug).toHaveValue(newSlug);
    await expect(page.locator("[data-org-name]").first()).toHaveText("Renamed Org");
    await expect(page.locator("[data-org-mark]").first()).toHaveText("R");
    await expect(page.locator("#settings-error")).toBeEmpty();
    expect((await fullOrganization(page, organization.id)).body).toMatchObject({ name: "Renamed Org", slug: newSlug });
    dialogs.length = 0;
    await page.locator(".cp-nav").getByRole("link", { name: "People", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${organization.id}/people$`));
    expect(dialogs).toEqual([]);
    await expect(page.locator("[data-org-name]").first()).toHaveText("Renamed Org");

    // Confirmed discard leaves with the edits dropped.
    await page.locator(".cp-nav").getByRole("link", { name: "Settings", exact: true }).click();
    await expect(name).toHaveValue("Renamed Org");
    await name.fill("Unsaved");
    answer = "accept";
    await page.locator(".cp-nav").getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${organization.id}$`));
    expect(dialogs).toEqual(["Discard unsaved organization changes?"]);
    await expect(heading(page)).toBeVisible();
    expect((await fullOrganization(page, organization.id)).body.name).toBe("Renamed Org");
  });

  test("only an owner can delete an organization; deletion revokes every member's access", async ({ actor }) => {
    test.setTimeout(120_000);
    const owner = await actor("doomed-owner", { organizations: ["Doomed Org"] });
    const admin = await actor("doomed-admin");
    const member = await actor("doomed-member");
    const [organization] = owner.organizations;
    await join(owner, organization.id, admin, "admin");
    await join(owner, organization.id, member, "member");

    for (const [who, role] of [[admin, "admin"], [member, "member"]] as const) {
      const denied = await api<{ code: string }>(who.page, "/api/auth/organization/delete", { organizationId: organization.id });
      expect(denied, role).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION" } });
    }
    expect((await fullOrganization(owner.page, organization.id)).status).toBe(200);

    await openSection(owner.page, organization.id, "people");
    await openSection(member.page, organization.id, "");
    const deleted = await api(owner.page, "/api/auth/organization/delete", { organizationId: organization.id });
    expect(deleted.status).toBe(200);
    for (const who of [owner, admin, member]) {
      expect(await organizationList(who.page)).toEqual([]);
      expect((await api(who.page, `/api/rendro/management/access?organizationId=${organization.id}`)).status).toBe(403);
      expect((await fullOrganization(who.page, organization.id)).status).toBe(400);
    }
    // A reload of an organization page no longer discloses it: the shared not-found document with a way back.
    for (const who of [owner, member]) {
      await who.page.goto(`/organizations/${organization.id}/people`);
      await expect(who.page.getByText("Page not found")).toBeVisible();
      await expect(who.page.getByRole("link", { name: "Manage organizations", exact: true })).toHaveAttribute("href", "/organizations?choose=1");
    }
    await owner.page.getByRole("link", { name: "Manage organizations", exact: true }).click();
    await expect(owner.page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
  });

  // Known bug: Organization create/update accept any slug; only the browser pattern attribute enforces lowercase hyphenated slugs.
  test.fail("the API rejects an organization slug that violates the documented pattern (known bug)", async ({ actor }) => {
    const owner = await actor("slug", { organizations: ["Slug Org"] });
    // Unique, so a repeated run cannot be refused for a duplicate instead of for the pattern.
    const unique = Date.now().toString(36);
    const created = await api(owner.page, "/api/auth/organization/create", { name: "Bad Slug Org", slug: `Not A Valid Slug ${unique}` });
    expect(created.status).toBeGreaterThanOrEqual(400);
    const updated = await api(owner.page, "/api/auth/organization/update", { organizationId: owner.organizations[0].id, data: { slug: `Also Not Valid ${unique}` } });
    expect(updated.status).toBeGreaterThanOrEqual(400);
  });
});
