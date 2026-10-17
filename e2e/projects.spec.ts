import type { Page } from "@playwright/test";
import { test, expect, failOnce, join } from "./org-fixtures";
import { holdRequest } from "./auth-helpers";
import { api, heading } from "./shell-helpers";
import { barrier, openManagement, watch } from "./project-helpers";

type Project = { _id: string; name: string; slug: string; organizationId: string; activeDeploymentId?: string; createdAt: number };
const listProjects = async (page: Page, organizationId: string) => (await api<{ projects: Project[] }>(page, `/api/rendro/projects?organizationId=${organizationId}`)).body.projects;
const dialog = (page: Page) => page.locator("#project-dialog");
const insideDialog = (page: Page) => page.evaluate(() => document.querySelector("#project-dialog")!.contains(document.activeElement));

test.describe("projects", () => {
  test("an owner creates projects with validation, a slug conflict and a retained draft, then lands on the new project", async ({ actor }) => {
    test.setTimeout(90_000);
    const owner = await actor("projects", { organizations: ["Projects Org", "Projects Other"] });
    const { page } = owner;
    const [organization, other] = owner.organizations;
    const base = `/organizations/${organization.id}/projects`;
    const requests = watch(page, "/api/rendro/projects");

    // Empty state: the page says so, and offers the create action in the header and in the empty state.
    await openManagement(page, base);
    await expect(heading(page)).toHaveText("Projects");
    await expect(page.getByRole("heading", { name: "No projects yet", level: 2 })).toBeVisible();
    await expect(page.getByText("Create the first documentation product for this organization.")).toBeVisible();
    const headerCreate = page.locator("#project-create");
    await expect(headerCreate).toBeEnabled();
    await expect(page.locator("#project-list").getByRole("button", { name: "Create project", exact: true })).toBeVisible();
    await expect(dialog(page)).toBeHidden();

    // The empty-state action opens the modal create dialog with focus inside it.
    await page.locator("#project-list").getByRole("button", { name: "Create project", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    expect(await dialog(page).evaluate(element => element.matches(":modal"))).toBe(true);
    expect(await insideDialog(page)).toBe(true);
    const name = dialog(page).locator("input[name=name]"), slug = dialog(page).locator("input[name=slug]");
    const submit = dialog(page).getByRole("button", { name: "Create project", exact: true });
    const failure = page.locator("#project-error");

    // The slug follows the name until it is edited by hand; native validation blocks invalid input before any request.
    await name.fill("Alpha Docs!");
    await expect(slug).toHaveValue("alpha-docs");
    await slug.fill("alpha-guide");
    await name.fill("Alpha Docs");
    await expect(slug).toHaveValue("alpha-guide");
    await name.fill("");
    await submit.click();
    await expect(name).toBeFocused();
    await name.fill("Alpha Docs");
    await slug.fill("Not A Slug");
    await submit.click();
    await expect(slug).toBeFocused();
    await barrier(page);
    expect(requests.filter(entry => entry.startsWith("POST"))).toEqual([]);
    expect(await listProjects(page, organization.id)).toEqual([]);
    await slug.fill("alpha-docs");

    // Success: the dialog closes and the same shell (no new document) opens the new project.
    await page.evaluate(() => { (window as unknown as { __sameShell?: string }).__sameShell = "yes"; });
    await submit.click();
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`${base}/[a-z0-9]+$`));
    const [alpha] = await listProjects(page, organization.id);
    expect(alpha).toMatchObject({ name: "Alpha Docs", slug: "alpha-docs", organizationId: organization.id });
    expect(alpha.activeDeploymentId).toBeUndefined();
    await expect(page).toHaveURL(`${base}/${alpha._id}`);
    await expect(heading(page)).toHaveText("Alpha Docs");
    await expect(page.locator(".cp-page-description")).toHaveText("Immutable deployments and publication controls for alpha-docs.");
    await expect(page.locator(".project-overview .badge")).toHaveText("Not deployed");
    expect(await page.evaluate(() => (window as unknown as { __sameShell?: string }).__sameShell)).toBe("yes");
    await expect(page.locator("#project-slug")).toHaveText("alpha-docs");
    await expect(page.locator("#project-created")).toHaveText(await page.evaluate(time => new Date(time).toLocaleDateString(), alpha.createdAt));
    await expect(page.locator("#active-deployment")).toHaveText("None yet");
    await expect(page.getByText("Waiting for first deployment")).toBeVisible();
    await expect(page.locator(".project-actions").getByRole("link", { name: "View deployments", exact: true })).toHaveAttribute("href", `${base}/${alpha._id}/deployments`);
    await expect(page.locator(".project-actions").getByRole("link", { name: "Manage publications", exact: true })).toHaveAttribute("href", `${base}/${alpha._id}/publications`);
    const tabs = page.getByRole("navigation", { name: "Project sections" });
    await expect(tabs.getByRole("link")).toHaveText(["Overview", "Deployments", "Publications", "Private shares"]);
    await expect(tabs.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    for (const [label, suffix] of [["Deployments", "/deployments"], ["Publications", "/publications"], ["Private shares", "/shares"]]) {
      await expect(tabs.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", `${base}/${alpha._id}${suffix}`);
    }
    // Nothing offers a documentation entry before the first deployment.
    await expect(page.getByRole("link", { name: "Open documentation" })).toHaveCount(0);

    // The list shows the project as a link with its release state; a second create with the same slug is refused and keeps the draft.
    await page.getByRole("link", { name: "All projects", exact: true }).click();
    await expect(page).toHaveURL(base);
    const row = page.locator(".project-row", { hasText: "Alpha Docs" });
    await expect(row).toHaveAttribute("href", `${base}/${alpha._id}`);
    await expect(row.locator(".cell-secondary")).toHaveText("alpha-docs");
    await expect(row.locator(".badge")).toHaveText("Not deployed");
    await headerCreate.click();
    await name.fill("Alpha Again");
    await slug.fill("alpha-docs");
    const hold = await holdRequest(page, "/api/rendro/projects");
    try {
      await submit.click();
      await expect(submit).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => hold.count()).toBe(1);
      // A pending write cannot be dismissed and cannot be repeated.
      await submit.click({ force: true });
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeVisible();
      hold.release();
      await expect(failure).toHaveText("A project with this slug already exists");
      await expect(failure).toHaveAttribute("role", "alert");
    } finally {
      await hold.close();
    }
    expect(hold.count()).toBe(1);
    await expect(submit).toBeEnabled();
    await expect(submit).not.toHaveAttribute("aria-busy", "true");
    await expect(name).toHaveValue("Alpha Again");
    await expect(slug).toHaveValue("alpha-docs");
    expect((await listProjects(page, organization.id)).map(project => project.slug)).toEqual(["alpha-docs"]);
    // Correcting the slug succeeds and the failure is gone on the next visit of the dialog.
    await slug.fill("alpha-again");
    await submit.click();
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`${base}/[a-z0-9]+$`));
    await expect(heading(page)).toHaveText("Alpha Again");
    expect((await listProjects(page, organization.id)).map(project => project.slug).sort()).toEqual(["alpha-again", "alpha-docs"]);
    await page.getByRole("link", { name: "All projects", exact: true }).click();
    await expect(page.locator(".project-row")).toHaveCount(2);
    await headerCreate.click();
    await expect(failure).toBeEmpty();
    await expect(name).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(headerCreate).toBeFocused();

    // Slugs are unique within an organization only; the same slug works in another organization of the same owner.
    const sameSlug = await api<{ project: Project }>(page, "/api/rendro/projects", { organizationId: other.id, name: "Alpha Docs", slug: "alpha-docs" });
    expect(sameSlug.status).toBe(201);
    expect(sameSlug.body.project.organizationId).toBe(other.id);
    expect((await listProjects(page, organization.id)).map(project => project.organizationId)).toEqual([organization.id, organization.id]);
  });

  test("the project API normalizes and refuses invalid input without creating anything", async ({ actor }) => {
    test.setTimeout(90_000);
    const owner = await actor("project-api", { organizations: ["Project API"] });
    const { page } = owner;
    const [organization] = owner.organizations;
    const create = (data: unknown) => api<{ project?: Project; error?: string }>(page, "/api/rendro/projects", data);
    const valid = { organizationId: organization.id, name: "Valid", slug: "valid" };

    const refused: Array<[string, unknown]> = [
      ["a blank name", { ...valid, name: "   " }],
      ["a name over 80 characters", { ...valid, name: "x".repeat(81) }],
      ["a slug with spaces", { ...valid, slug: "bad slug" }],
      ["a slug with a leading hyphen", { ...valid, slug: "-lead" }],
      ["a slug with a double hyphen", { ...valid, slug: "a--b" }],
      ["a slug over 48 characters", { ...valid, slug: "a".repeat(49) }],
      ["an empty slug", { ...valid, slug: "" }],
      ["a missing name", { organizationId: organization.id, slug: "valid" }],
      ["a non-string slug", { ...valid, slug: 5 }],
      ["a missing organization", { name: "Valid", slug: "valid" }],
    ];
    for (const [label, body] of refused) {
      const response = await create(body);
      expect(response.status, label).toBeGreaterThanOrEqual(400);
      expect(response.status, label).toBeLessThan(500);
    }
    // A body that is not JSON is a client error too.
    const notJson = await page.evaluate(async () => (await fetch("/api/rendro/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status);
    expect(notJson).toBe(400);
    expect(await listProjects(page, organization.id)).toEqual([]);

    // Surrounding whitespace is trimmed and the slug is stored in lower case; exact boundary lengths are accepted.
    const normalized = await create({ organizationId: organization.id, name: `  ${"n".repeat(80)}  `, slug: "  Mixed-Case  " });
    expect(normalized.status).toBe(201);
    expect(normalized.body.project).toMatchObject({ name: "n".repeat(80), slug: "mixed-case" });
    const longest = await create({ organizationId: organization.id, name: "Longest", slug: "a".repeat(48) });
    expect(longest.status).toBe(201);
    // The conflict is decided on the normalized slug.
    const duplicate = await create({ organizationId: organization.id, name: "Dup", slug: "MIXED-case" });
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(duplicate.status).toBeLessThan(500);
    expect(JSON.stringify(duplicate.body)).toContain("A project with this slug already exists");
    expect((await listProjects(page, organization.id)).map(project => project.slug).sort()).toEqual(["a".repeat(48), "mixed-case"]);

    // The organization path parameter cannot be swapped for a project of another organization.
    const foreign = await api(page, `/api/rendro/projects/get?organizationId=${organization.id}&projectId=${"k".repeat(32)}`);
    expect(foreign.status).toBe(404);
  });

  test("a failed project read recovers with Try again, and another organization's project is a 404", async ({ actor }) => {
    test.setTimeout(90_000);
    const owner = await actor("project-read", { organizations: ["Read One", "Read Two"], project: true });
    const { page } = owner;
    const [one, two] = owner.organizations;
    const [, projectTwo] = owner.projects;
    const base = `/organizations/${one.id}/projects`;

    // The list read fails once: an error with the server's text and one retry that restores the page.
    const outage = await failOnce(page, "**/api/rendro/projects?*", "Projects are unavailable right now");
    await page.goto(base);
    await expect(page.getByRole("heading", { name: "Unable to load projects", level: 2 })).toBeVisible();
    await expect(page.locator("#project-content .empty p")).toHaveText("Projects are unavailable right now");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.locator(".project-row")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Unable to load projects" })).toHaveCount(0);
    expect(outage.failures()).toBe(1);
    await outage.close();

    // A project read that fails shows the same recovery on the detail page (entered from the list, so the read is a request).
    const detail = await failOnce(page, "**/api/rendro/projects/get?*", "Project temporarily unavailable");
    await page.locator(".project-row").click();
    await expect(page.locator("#project-content .empty p")).toHaveText("Project temporarily unavailable");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(heading(page)).toHaveText("Read One docs");
    await detail.close();

    // A project that belongs to another organization is a not-found page, never rendered under this organization.
    const foreign = await page.goto(`${base}/${projectTwo.id}`);
    expect(foreign!.status()).toBe(404);
    await expect(page.getByText("Page not found")).toBeVisible();
    await expect(page.locator(".project-overview")).toHaveCount(0);
    const mixed = await api(page, `/api/rendro/projects/get?organizationId=${one.id}&projectId=${projectTwo.id}`);
    expect(mixed.status).toBe(404);
    expect((await api<{ project: Project }>(page, `/api/rendro/projects/get?organizationId=${two.id}&projectId=${projectTwo.id}`)).status).toBe(200);
    // The deployments of a project are only listed under its own organization.
    expect((await api(page, `/api/rendro/deployments?organizationId=${one.id}&projectId=${projectTwo.id}`)).status).toBeGreaterThanOrEqual(400);
  });

  test("owner, admin, member and outsider get the controls and API access of their role", async ({ actor }) => {
    test.setTimeout(120_000);
    const owner = await actor("roles-owner", { organizations: ["Roles Org"], project: true });
    const admin = await actor("roles-admin");
    const member = await actor("roles-member");
    const outsider = await actor("roles-outsider", { organizations: ["Roles Elsewhere"] });
    const [organization] = owner.organizations;
    const [project] = owner.projects;
    await join(owner, organization.id, admin, "admin");
    await join(owner, organization.id, member, "member");
    const base = `/organizations/${organization.id}/projects`;

    // Owner and admin create from the header; the admin's project is real and visible to the owner.
    for (const person of [owner, admin]) {
      await openManagement(person.page, base);
      await expect(person.page.locator("#project-create")).toBeVisible();
      await expect(person.page.locator("#project-create")).toBeEnabled();
      await expect(person.page.locator(".project-row")).toHaveCount(1);
    }
    await admin.page.locator("#project-create").click();
    await dialog(admin.page).locator("input[name=name]").fill("Admin Docs");
    await dialog(admin.page).getByRole("button", { name: "Create project", exact: true }).click();
    await expect(admin.page).toHaveURL(new RegExp(`${base}/[a-z0-9]+$`));
    await expect(heading(admin.page)).toHaveText("Admin Docs");
    expect((await listProjects(owner.page, organization.id)).map(entry => entry.slug).sort()).toEqual(["admin-docs", "docs"]);

    // A member reads the list and project pages with the write controls gone, and every write is refused.
    const memberWrites = watch(member.page, "/api/rendro/projects");
    await openManagement(member.page, base);
    await expect(member.page.locator(".project-row")).toHaveCount(2);
    await expect(member.page.locator("#project-create")).toBeHidden();
    await expect(member.page.locator("#project-create")).toBeDisabled();
    await expect(dialog(member.page).locator("input, button[type=submit]")).toHaveCount(3);
    for (const control of await dialog(member.page).locator("input, button[type=submit]").all()) await expect(control).toBeDisabled();
    await member.page.locator(".project-row", { hasText: "Roles Org docs" }).click();
    await expect(member.page).toHaveURL(new RegExp(`${base}/[a-z0-9]+$`));
    await expect(member.page.locator(".project-actions").getByRole("link", { name: "View publications", exact: true })).toBeVisible();
    await expect(member.page.locator(".project-actions").getByRole("link", { name: "Manage publications" })).toHaveCount(0);
    await openManagement(owner.page, `${base}/${project.id}`);
    await expect(owner.page.locator(".project-actions").getByRole("link", { name: "Manage publications", exact: true })).toBeVisible();
    await expect(member.page.locator(".access-note")).toHaveText("You have read-only project access. Owners and admins manage publications and revoke private shares.");
    expect(memberWrites.filter(entry => entry.startsWith("POST"))).toEqual([]);
    const denied = await api(member.page, "/api/rendro/projects", { organizationId: organization.id, name: "Member Docs", slug: "member-docs" });
    expect(denied.status).toBe(403);
    expect((await listProjects(owner.page, organization.id)).map(entry => entry.slug).sort()).toEqual(["admin-docs", "docs"]);

    // An outsider has no page, no list, no project and no write; the other organization's own pages still work for them.
    for (const path of [base, `${base}/${project.id}`, `${base}/${project.id}/deployments`, `${base}/${project.id}/publications`, `${base}/${project.id}/shares`, `/organizations/${organization.id}/api-keys`]) {
      const response = await outsider.page.goto(path);
      expect(response!.status(), path).toBe(404);
      await expect(outsider.page.getByText("Page not found")).toBeVisible();
    }
    for (const path of [`/api/rendro/projects?organizationId=${organization.id}`, `/api/rendro/projects/get?organizationId=${organization.id}&projectId=${project.id}`,
      `/api/rendro/deployments?organizationId=${organization.id}&projectId=${project.id}`, `/api/rendro/shares?organizationId=${organization.id}&projectId=${project.id}`,
      `/api/rendro/publications?organizationId=${organization.id}&projectId=${project.id}`]) {
      expect((await api(outsider.page, path)).status, path).toBe(403);
    }
    expect((await api(outsider.page, "/api/rendro/projects", { organizationId: organization.id, name: "Outsider", slug: "outsider" })).status).toBe(403);
    expect((await listProjects(owner.page, organization.id)).map(entry => entry.slug).sort()).toEqual(["admin-docs", "docs"]);
    expect((await api(outsider.page, `/api/rendro/projects?organizationId=${outsider.organizations[0].id}`)).status).toBe(200);
  });

  test("anonymous visitors are sent to sign in and the API refuses them", async ({ actor, secondContext }) => {
    test.setTimeout(90_000);
    const owner = await actor("anon-projects", { organizations: ["Anon Org"], project: true });
    const [organization] = owner.organizations;
    const [project] = owner.projects;
    const visitor = await secondContext.newPage();
    for (const section of ["", "/deployments", "/publications", "/shares"]) {
      const path = `/organizations/${organization.id}/projects/${project.id}${section}`;
      await visitor.goto(path);
      await expect(visitor).toHaveURL(`/sign-in?returnTo=${encodeURIComponent(path)}`);
      await expect(visitor.getByRole("heading", { name: /sign in/i })).toBeVisible();
    }
    await visitor.goto(`/organizations/${organization.id}/projects`);
    await expect(visitor).toHaveURL(`/sign-in?returnTo=${encodeURIComponent(`/organizations/${organization.id}/projects`)}`);
    await visitor.goto("/sign-in");
    for (const path of [`/api/rendro/projects?organizationId=${organization.id}`, `/api/rendro/projects/get?organizationId=${organization.id}&projectId=${project.id}`]) {
      const status = await visitor.evaluate(async url => (await fetch(url)).status, path);
      expect([401, 403], path).toContain(status);
    }
    const write = await api(visitor, "/api/rendro/projects", { organizationId: organization.id, name: "Anon", slug: "anon" });
    expect([401, 403]).toContain(write.status);
    expect(await listProjects(owner.page, organization.id)).toHaveLength(1);
  });

  // Expected failure: the Worker proxies the body to the backend, which cannot store a lone surrogate. The caller sent
  // invalid text, yet gets a 502 "Backend unavailable" (and the Worker logs a transport error) rather than a 400.
  test.fail("invalid Unicode in a project name is a client error, not a backend outage (known bug)", async ({ actor }) => {
    test.setTimeout(90_000);
    const owner = await actor("project-unicode", { organizations: ["Project Unicode"] });
    const { page } = owner;
    const [organization] = owner.organizations;
    const response = await api(page, "/api/rendro/projects", { organizationId: organization.id, name: "a\ud800b", slug: "unicode" });
    expect(response.status).toBe(400);
  });
});
