import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { publicationSlug } from "./services";
import { api, desktop, heading, mobile, provision, shellReady, signInSeeded } from "./shell-helpers";

async function notFound(page: Page, cspViolations: string[], viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const response = await page.goto("/definitely-missing/page");
  expect(response?.status()).toBe(404);
  expect(response?.headers()["content-type"]).toContain("text/html");
  expect(response?.headers()["cache-control"]).toMatch(/no-store/);
  const policy = response?.headers()["content-security-policy"] ?? "";
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(policy).toContain("frame-ancestors");
  // Every inline script and style the error page ships carries the response nonce.
  expect(await page.locator("script:not([src]), style").evaluateAll((nodes, expected) => nodes.every(node => (node as HTMLElement).nonce === expected), nonce)).toBe(true);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.locator(".eyebrow")).toHaveText("Error 404");
  await expect(page.locator(".path")).toHaveText("/definitely-missing/page");
  await expect(page.locator("a.brand")).toBeVisible();
  expect(cspViolations).toEqual([]);
  // Recovery link leaves the error page for a usable destination.
  await page.getByRole("link", { name: "Go to Rendro" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
  // Go back returns to the previous document when one exists.
  await page.goto("/definitely-missing/other");
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("direct entry", () => {
  test.use({ viewport: desktop });

  test("authenticated root, chooser, project and docs URLs load without a server error", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "owner");
    const statuses: number[] = [];
    page.on("response", response => { if (response.request().resourceType() === "document" && response.request().frame() === page.mainFrame()) statuses.push(response.status()); });
    const base = `/organizations/${seed.organizationId}`;
    // The signed-in root and the chooser redirect a single-organization user into the organization.
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await shellReady(page);
    await page.goto("/organizations");
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    // The explicit chooser never redirects.
    await page.goto("/organizations?choose=1");
    await expect(page).toHaveURL(/\/organizations\?choose=1$/);
    await expect(page.locator(".organization-card", { hasText: "E2E primary" })).toBeVisible();
    await page.goto(`${base}/projects`);
    await expect(heading(page)).toHaveText("Projects");
    await page.goto(`${base}/projects/${seed.projectId}`);
    await expect(heading(page)).toHaveText("Worker publication");
    await page.goto(`${base}/projects/${seed.projectId}/docs`);
    await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Publication from local storage" })).toBeVisible();
    expect(statuses.every(status => status < 400 || [301, 302, 303, 307].includes(status)), JSON.stringify(statuses)).toBe(true);
    expect(statuses).not.toContain(503);
  });

  test("anonymous management URLs redirect to sign-in and preserve the destination", async ({ page, seed }) => {
    const base = `/organizations/${seed.organizationId}`;
    for (const path of [base, `${base}/people`, `${base}/api-keys`, `${base}/projects/${seed.projectId}`]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in\?/);
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(path);
      await expect(page.getByRole("heading", { name: "Sign in to Rendro" })).toBeVisible();
    }
  });
});

test.describe("focused layouts", () => {
  test.use({ viewport: desktop });

  test("chooser, onboarding and invitation use focused layouts and omit the organization switcher where specified", async ({ page, secondContext }, info) => {
    const owner = await provision(page, `focus-owner-${info.project.name}`, { organizations: ["Focus"] });
    const organization = owner.organizations[0];
    const focused = async (target: Page) => {
      await expect(target.locator(".cp-main.focused")).toBeVisible();
      await expect(target.locator(".cp-sidebar, #cp-menu, #cp-backdrop")).toHaveCount(0);
      await expect(target.locator("body")).toHaveClass(/focused-layout/);
    };
    await page.goto("/organizations?choose=1");
    await expect(page.locator(".organization-card", { hasText: "Focus" })).toBeVisible();
    await focused(page);
    await expect(page.locator("#cp-org-switcher, #cp-org-menu")).toHaveCount(0);

    await page.goto(`/organizations/${organization.id}/onboarding`);
    await expect(page.getByRole("heading", { name: "Create your first project" }).first()).toBeVisible();
    await focused(page);

    const memberPage = await secondContext.newPage();
    const member = await provision(memberPage, `focus-member-${info.project.name}`);
    const invitation = await api<{ id: string }>(page, "/api/auth/organization/invite-member", { organizationId: organization.id, email: member.email, role: "member" });
    expect(invitation.status).toBe(200);
    await memberPage.goto(`/accept-invitation/${invitation.body.id}`);
    await focused(memberPage);
    await expect(memberPage.locator("#cp-org-switcher, #cp-org-menu")).toHaveCount(0);
    await expect(memberPage.locator("body")).toContainText("Focus");
  });
});

test.describe("error surfaces", () => {
  test("standalone not-found page renders under the nonce policy and recovers by link and Go back at 1440", async ({ page, cspViolations }) => {
    await notFound(page, cspViolations, desktop);
  });

  test("standalone not-found page renders under the nonce policy and recovers by link and Go back at 375", async ({ page, cspViolations }) => {
    await notFound(page, cspViolations, mobile);
  });

  test("a missing document inside the viewer frame hides the wordmark and recovers in the top window", async ({ page }) => {
    await page.setViewportSize(desktop);
    await page.goto("/sign-in");
    await page.evaluate(path => {
      const frame = document.createElement("iframe");
      frame.id = "error-frame"; frame.src = path; frame.style.cssText = "width:800px;height:600px";
      document.body.append(frame);
    }, `/p/${publicationSlug}/files/missing.html`);
    const frame = page.frameLocator("#error-frame");
    await expect(frame.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(frame.locator("html")).toHaveClass(/framed/);
    await expect(frame.locator("a.brand")).toBeHidden();
    const recovery = frame.getByRole("link", { name: "Go to Rendro" });
    await expect(recovery).toHaveAttribute("target", "_top");
    await recovery.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#error-frame")).toHaveCount(0);
  });

  test("asset errors stay plain and error pages are never cached", async ({ page, baseURL }) => {
    await page.goto("/sign-in");
    for (const path of ["/missing-image.png", `/p/${publicationSlug}/files/nothing.svg`, "/p/unknown-publication/files/a.css"]) {
      const result = await page.evaluate(async url => {
        const response = await fetch(url);
        return { status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), body: await response.text() };
      }, `${baseURL}${path}`);
      expect(result.status, path).toBe(404);
      expect(result.type, path).toBeNull();
      expect(result.body, path).toBe("");
      expect(result.cache ?? "", path).toMatch(/no-store/);
    }
    const document = await page.request.get(`/p/${publicationSlug}/files/missing.html`);
    expect(document.status()).toBe(404);
    expect(document.headers()["cache-control"]).toMatch(/no-store/);
    expect(document.headers()["content-type"]).toContain("text/html");
  });
});
