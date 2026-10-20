import type { Page } from "@playwright/test";
import { test, expect, stopNavigation } from "./org-fixtures";
import { holdRequest } from "./auth-helpers";
import { api, signInSeeded } from "./shell-helpers";

/** A page-issued request that completes after every earlier one, so "no request happened" can be asserted without a sleep. */
const barrier = (page: Page) => page.evaluate(() => fetch("/health", { cache: "no-store" }).then(response => response.status));
const steps = (page: Page) => page.getByLabel("Setup progress").locator(".step");

test.describe("onboarding", () => {
  test("an owner creates the first project with slug validation and a duplicate refused, then continues to it", async ({ actor }) => {
    const owner = await actor("onboard", { organizations: ["Onboard Org"] });
    const { page } = owner;
    const [organization] = owner.organizations;
    const occupied = await api(page, "/api/rendro/projects", { organizationId: organization.id, name: "Occupied", slug: "occupied-docs" });
    expect(occupied.status).toBe(201);

    // Project stage: two steps, Organization completed and Project current.
    await page.goto(`/organizations/${organization.id}/onboarding`);
    await expect(page.getByRole("heading", { name: "Create your first project", level: 2 })).toBeVisible();
    await expect(steps(page)).toHaveCount(2);
    await expect(steps(page).nth(0)).toHaveClass(/complete/);
    await expect(steps(page).nth(0).locator(".sr-only")).toHaveText("completed");
    await expect(steps(page).nth(1)).toHaveAttribute("aria-current", "step");
    await expect(steps(page).nth(1)).toHaveClass(/active/);
    await expect(page.getByRole("link", { name: "Finish later", exact: true })).toHaveAttribute("href", `/organizations/${organization.id}`);

    const name = page.getByLabel("Project name", { exact: true }), slug = page.getByLabel("Project slug", { exact: true });
    const submit = page.getByRole("button", { name: "Create project", exact: true });
    const failure = page.locator("#project-error");
    await name.fill("Docs Portal 2!");
    await expect(slug).toHaveValue("docs-portal-2");
    await slug.fill("manual-slug");
    await name.fill("Another Portal");
    await expect(slug).toHaveValue("manual-slug");

    const create = await holdRequest(page, "/api/rendro/projects");
    try {
      await name.fill("");
      await submit.click();
      await expect(name).toBeFocused();
      await slug.fill("Not A Slug");
      await name.fill("Portal");
      await submit.click();
      await expect(slug).toBeFocused();
      await barrier(page);
      expect(create.count()).toBe(0);
      // The project slug is already used in this organization: rejected, draft retained, controls restored.
      await slug.fill("occupied-docs");
      await submit.click();
      await expect(submit).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => create.count()).toBe(1);
      create.release();
      await expect(failure).not.toBeEmpty();
      await expect(failure).toHaveAttribute("role", "alert");
      await expect(submit).toBeEnabled();
      await expect(submit).not.toHaveAttribute("aria-busy", "true");
      await expect(name).toHaveValue("Portal");
      await expect(slug).toHaveValue("occupied-docs");
    } finally {
      await create.close();
    }
    const projectSlug = `portal-${Date.now().toString(36)}`;
    await slug.fill(projectSlug);
    const stop = await stopNavigation(page, /\/projects\/[^/?]+$/);
    await submit.click();
    await expect.poll(() => stop.seen()).toBe(1);
    await expect(page.locator("#project-form [role=status]")).toHaveText("Created. Continue to your project.");
    await stop.resume();
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${organization.id}/projects/[^/?]+$`));
    const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.locator(".cp-page-heading")).toHaveText("Portal");
    const projects = await api<{ projects: Array<{ _id: string; slug: string; name: string }> }>(page, `/api/rendro/projects?organizationId=${organization.id}`);
    expect(projects.body.projects.map(project => project.slug).sort()).toEqual(["occupied-docs", projectSlug].sort());
    expect(projects.body.projects.find(project => project._id === projectId)).toMatchObject({ slug: projectSlug, name: "Portal" });
  });

  test("setup initialization failure recovers with Try again, and Finish later leaves setup", async ({ actor }) => {
    const owner = await actor("setup", { organizations: ["Setup One"] });
    const { page } = owner;
    const [one] = owner.organizations;

    let reads = 0;
    await page.route("**/api/rendro/management/access?*", async route => {
      if (reads++ === 0) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Setup service unavailable" }) });
      else await route.continue();
    });
    // Without the server's initial access data the page reads access itself, and that first read fails.
    await page.route(`**/organizations/${one.id}/onboarding`, async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/<script[^>]*data-cp-initial-data[^>]*>[\s\S]*?<\/script>/, "");
      await route.fulfill({ response, body });
    }, { times: 1 });
    await page.goto(`/organizations/${one.id}/onboarding`);
    await expect(page.getByRole("heading", { name: "Unable to load setup", level: 2 })).toBeVisible();
    await expect(page.locator("#onboarding-stage .empty p")).toHaveText("Setup service unavailable");
    await expect(page.locator("#project-form")).toHaveCount(0);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create your first project", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unable to load setup" })).toHaveCount(0);
    expect(reads).toBe(2);

    // Finish later leaves setup for the organization overview without creating a project.
    await page.goto(`/organizations/${one.id}/onboarding`);
    await page.getByRole("link", { name: "Finish later", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${one.id}$`));
    await expect(page.getByRole("heading", { name: "Workspace status" })).toBeVisible();
  });

  test("an ordinary member sees setup restricted to admins, and the APIs refuse them", async ({ page, context, baseURL, seed, seeded }, info) => {
    // Owners and admins get the setup form; only ordinary members are restricted.
    for (const role of ["owner", "admin"] as const) {
      const privileged = await seeded(role);
      await privileged.goto(`/organizations/${seed.organizationId}/onboarding`);
      await expect(privileged.getByRole("heading", { name: "Create your first project", level: 2 })).toBeVisible();
      await expect(privileged.locator("#project-form")).toBeVisible();
      await expect(privileged.getByRole("heading", { name: "Setup is managed by organization admins" })).toHaveCount(0);
    }
    await signInSeeded(context, baseURL, seed, "member");
    await page.goto(`/organizations/${seed.organizationId}/onboarding`);
    await expect(page.getByRole("heading", { name: "Setup is managed by organization admins", level: 2 })).toBeVisible();
    await expect(page.getByText("only an owner or admin can create projects")).toBeVisible();
    await expect(page.locator("#project-form")).toHaveCount(0);
    await expect(steps(page)).toHaveCount(2);
    await expect(page.getByRole("link", { name: "Return to overview", exact: true })).toHaveAttribute("href", `/organizations/${seed.organizationId}`);
    const project = await api(page, "/api/rendro/projects", { organizationId: seed.organizationId, name: "Denied", slug: `denied-${info.project.name}` });
    expect(project.status).toBe(403);
    const credential = await api(page, "/api/rendro/credentials", { organizationId: seed.organizationId, projectId: seed.projectId, name: "Denied", scopes: ["docs:read"] });
    expect(credential.status).toBe(403);
    await page.getByRole("link", { name: "Return to overview", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${seed.organizationId}$`));
  });
});
