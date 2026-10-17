import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, stopNavigation, toasts } from "./org-fixtures";
import { holdRequest } from "./auth-helpers";
import { api, clipboard, fakeClipboard, signInSeeded } from "./shell-helpers";
import { root } from "./backend";
import { pushDocuments } from "./seed";

/** A page-issued request that completes after every earlier one, so "no request happened" can be asserted without a sleep. */
const barrier = (page: Page) => page.evaluate(() => fetch("/health", { cache: "no-store" }).then(response => response.status));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const steps = (page: Page) => page.getByLabel("Setup progress").locator(".step");

test.describe("onboarding", () => {
  test("an owner goes from project to key to a real CLI deployment with polling, outage recovery and one-time secret handling", async ({ actor, baseURL }) => {
    test.setTimeout(150_000);
    const owner = await actor("onboard", { organizations: ["Onboard Org"] });
    const { page } = owner;
    const [organization] = owner.organizations;
    const occupied = await api(page, "/api/rendro/projects", { organizationId: organization.id, name: "Occupied", slug: "occupied-docs" });
    expect(occupied.status).toBe(201);
    await fakeClipboard(page);
    await page.clock.install();
    const deploymentReads: string[] = [];
    page.on("request", request => { if (request.url().includes("/api/rendro/deployments?")) deploymentReads.push(request.url()); });

    // Project stage: three steps, Organization completed and Project current.
    await page.goto(`/organizations/${organization.id}/onboarding`);
    await expect(page.getByRole("heading", { name: "Create your first project", level: 2 })).toBeVisible();
    await expect(steps(page)).toHaveCount(3);
    await expect(steps(page).nth(0)).toHaveClass(/complete/);
    await expect(steps(page).nth(0).locator(".sr-only")).toHaveText("completed");
    await expect(steps(page).nth(1)).toHaveAttribute("aria-current", "step");
    await expect(steps(page).nth(1)).toHaveClass(/active/);
    await expect(steps(page).nth(2)).not.toHaveAttribute("aria-current", "step");
    await expect(steps(page).nth(2)).toContainText("First deployment");
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
    const stop = await stopNavigation(page, /\/onboarding\?projectId=/);
    await submit.click();
    await expect.poll(() => stop.seen()).toBe(1);
    await expect(page.locator("#project-form [role=status]")).toHaveText("Created. Continue to deployment setup.");
    await stop.resume();
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${organization.id}/onboarding\\?projectId=[^&]+$`));
    const projectId = new URL(page.url()).searchParams.get("projectId")!;
    const projects = await api<{ projects: Array<{ _id: string; slug: string; name: string }> }>(page, `/api/rendro/projects?organizationId=${organization.id}`);
    expect(projects.body.projects.map(project => project.slug).sort()).toEqual(["occupied-docs", projectSlug].sort());
    expect(projects.body.projects.find(project => project._id === projectId)).toMatchObject({ slug: projectSlug, name: "Portal" });

    // Credential stage: Project completed, deployment current; defaults, validation, rejection and the one-time key.
    await expect(page.getByRole("heading", { name: "Connect the Rendro CLI", level: 2 })).toBeVisible();
    await expect(steps(page).nth(1)).toHaveClass(/complete/);
    await expect(steps(page).nth(1).locator(".sr-only")).toHaveText("completed");
    await expect(steps(page).nth(2)).toHaveAttribute("aria-current", "step");
    // From here page timers only move when the test advances them, so copy windows and poll intervals are exact.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
    const keyForm = page.locator("#key-form");
    const keyName = keyForm.getByLabel("Credential name", { exact: true });
    await expect(keyName).toHaveValue("First deployment");
    const expiry = keyForm.getByRole("combobox", { name: "Expiration" });
    await expect(expiry).toHaveText("90 days");
    await expiry.click();
    await expect(page.getByRole("listbox", { name: "Expiration" }).getByRole("option")).toHaveText(["30 days", "90 days", "1 year", "Never"]);
    await page.getByRole("option", { name: "30 days", exact: true }).click();
    await expect(expiry).toHaveText("30 days");
    const scopes = keyForm.locator("input[name=scope]");
    await expect(keyForm.locator(".check")).toHaveText(["Read deployments", "Push documentation"]);
    expect(await scopes.evaluateAll(inputs => (inputs as HTMLInputElement[]).map(input => [input.value, input.checked]))).toEqual([["docs:read", true], ["docs:write", true]]);
    const generate = page.getByRole("button", { name: "Generate API key", exact: true });
    const keyError = page.locator("#key-error");
    const credentials = await holdRequest(page, "/api/rendro/credentials");
    try {
      await keyForm.getByLabel("Read deployments").uncheck();
      await keyForm.getByLabel("Push documentation").uncheck();
      await generate.click();
      await expect(keyError).toHaveText("Choose at least one permission.");
      await expect(keyError).toHaveAttribute("role", "alert");
      await barrier(page);
      expect(credentials.count()).toBe(0);
      await keyForm.getByLabel("Read deployments").check();
      await keyForm.getByLabel("Push documentation").check();
      await keyName.fill("CI deploy");
      // Pending state, then a rejected generation keeps the form and the entered values.
      await generate.click();
      await expect(generate).toHaveAttribute("aria-busy", "true");
      await expect(generate).toBeDisabled();
      await expect.poll(() => credentials.count()).toBe(1);
      credentials.release(true);
      await expect(keyError).toHaveText("Service unavailable. Please try again.");
      await expect(generate).toBeEnabled();
      await expect(generate).not.toHaveAttribute("aria-busy", "true");
      await expect(keyName).toHaveValue("CI deploy");
      await expect(expiry).toHaveText("30 days");
      await expect(page.locator("#onboarding-key")).toHaveCount(0);
    } finally {
      await credentials.close();
    }
    await generate.click();
    const keyElement = page.locator("#onboarding-key");
    await expect(keyElement).toHaveText(/^rnd_live_[0-9a-f]{16}_[0-9a-f]{64}$/);
    const token = await keyElement.innerText();
    await expect(keyForm).toBeHidden();
    const command = page.locator("#onboarding-command");
    // The shell-quoted command pins the CLI version and targets this organization, project and origin.
    const commandText = (await command.textContent())!;
    expect(commandText).toBe([
      `export RENDRO_API_KEY='${token}'`,
      `npx --yes rendro@${version} push --source ./docs \\`,
      `  --organization '${organization.id}' --project '${projectId}' \\`,
      `  --endpoint '${baseURL}'`,
    ].join("\n"));
    // Nothing persists the secret in browser storage.
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]))).not.toContain(token.split("_")[3]);

    // Server state: one credential, bound to this project, with exactly the chosen scopes and a 30-day expiry; the list never returns the secret.
    const listed = await api<{ credentials: Array<{ name: string; scopes: string[]; projectId?: string; expiresAt?: number; keyPrefix: string }> }>(page, `/api/rendro/credentials?organizationId=${organization.id}`);
    expect(listed.body.credentials).toHaveLength(1);
    expect(listed.body.credentials[0]).toMatchObject({ name: "CI deploy", projectId, keyPrefix: token.split("_").slice(0, 3).join("_") });
    expect([...listed.body.credentials[0].scopes].sort()).toEqual(["docs:read", "docs:write"]);
    expect(Math.abs(listed.body.credentials[0].expiresAt! - (Date.now() + 30 * 86_400_000))).toBeLessThan(5 * 60_000);
    expect(JSON.stringify(listed.body)).not.toContain(token.split("_")[3]);

    // Copy feedback and clipboard failure.
    const copyKey = page.locator("#copy-key");
    const copyCommand = page.locator("#copy-command");
    await copyKey.click();
    await expect(copyKey).toHaveAttribute("aria-busy", "true");
    await page.clock.runFor(250);
    await expect(copyKey).toHaveText("Copied");
    await copyCommand.click();
    await page.clock.runFor(250);
    await expect(copyCommand).toHaveText("Copied");
    expect(await clipboard(page)).toEqual([token, commandText]);
    await page.clock.runFor(1500);
    await expect(copyKey).toHaveText("Copy key");
    await expect(copyCommand).toHaveText("Copy command");
    await page.evaluate(() => { (window as unknown as { clipboardState: { mode: string } }).clipboardState.mode = "reject"; });
    await copyKey.click();
    await page.clock.runFor(250);
    await expect(toasts(page).filter({ hasText: "Unable to copy. Select the value and copy it manually." })).toHaveCount(1);
    await expect(copyKey).toHaveText("Copy key");
    await expect(copyKey).not.toHaveAttribute("aria-busy", "true");

    // Until the key is stored, departure is blocked; confirming releases it.
    const unloadBlocked = () => page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    expect(await unloadBlocked()).toBe(true);
    await page.getByLabel("I have stored this key securely").check();
    expect(await unloadBlocked()).toBe(false);
    await page.getByLabel("I have stored this key securely").uncheck();
    expect(await unloadBlocked()).toBe(true);
    await page.getByLabel("I have stored this key securely").check();

    // Polling: advance the frozen page clock five seconds at a time.
    await expect.poll(() => deploymentReads.length).toBeGreaterThanOrEqual(1);
    await barrier(page);
    const waiting = page.locator(".progress-state");
    await expect(waiting).toContainText("Waiting for your first deployment");
    await expect(page.getByRole("link", { name: "Open documentation" })).toHaveCount(0);
    let reads = deploymentReads.length;
    // A hidden tab pauses fetching but keeps the schedule.
    await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
    await page.clock.runFor(5000);
    await barrier(page);
    expect(deploymentReads.length).toBe(reads);
    await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => false }));
    await page.clock.runFor(5000);
    await expect.poll(() => deploymentReads.length).toBe(reads + 1);
    reads++;
    await barrier(page);
    await expect(waiting).toContainText("Waiting for your first deployment");
    // Outage: the status says so and polling continues; recovery restores the waiting state.
    await page.route("**/api/rendro/deployments?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Deployments unavailable" }) }));
    await page.clock.runFor(5000);
    await expect(waiting).toContainText("Connection interrupted");
    await expect(waiting).toHaveClass(/poll-error/);
    await expect(waiting.locator(".cell-secondary")).toContainText("Rendro will retry automatically");
    await page.clock.runFor(5000);
    await expect.poll(() => deploymentReads.length).toBe(reads + 2);
    reads += 2;
    await page.unroute("**/api/rendro/deployments?*");
    await page.clock.runFor(5000);
    await expect(waiting).toContainText("Waiting for your first deployment");
    await expect(waiting).not.toHaveClass(/poll-error/);
    await expect.poll(() => deploymentReads.length).toBe(reads + 1);
    // Still no deployment: nothing claims success.
    await expect(page.getByRole("link", { name: "Open documentation" })).toHaveCount(0);

    // A real CLI push; the next poll shows the actual deployment and offers the documentation.
    const source = await mkdtemp(join(process.env.RENDRO_E2E_DIRECTORY!, "onboard-"));
    await writeFile(join(source, "index.html"), '<!doctype html><html><head><title>Onboarding document</title></head><body><h1>Shipped through onboarding</h1></body></html>');
    await pushDocuments(source, baseURL!, organization.id, projectId, token);
    await page.clock.runFor(5000);
    const success = page.locator("#deployment-success");
    await expect(success.getByText("First deployment received", { exact: true })).toBeVisible();
    await expect(success).toHaveAttribute("role", "status");
    await expect(success.locator(".cell-secondary")).toContainText(/^1 documents/);
    await expect(waiting).toHaveCount(0);
    const open = success.getByRole("link", { name: "Open documentation", exact: true });
    await expect(open).toHaveAttribute("href", `/organizations/${organization.id}/projects/${projectId}/docs`);
    // The poller stops after success.
    reads = deploymentReads.length;
    await page.clock.runFor(5000);
    await barrier(page);
    expect(deploymentReads.length).toBe(reads);
    const deployments = await api<{ deployments: Array<{ status: string; fileCount: number }> }>(page, `/api/rendro/deployments?organizationId=${organization.id}&projectId=${projectId}`);
    expect(deployments.body.deployments.filter(deployment => deployment.status === "active")).toHaveLength(1);
    await page.clock.resume();
    await open.click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${organization.id}/projects/${projectId}/docs$`));
    await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Shipped through onboarding" })).toBeVisible();
  });

  test("setup initialization failure recovers with Try again; a foreign project cannot be used and Finish later leaves setup", async ({ actor }) => {
    const owner = await actor("setup", { organizations: ["Setup One", "Setup Two"], project: true });
    const { page } = owner;
    const [one, two] = owner.organizations;
    const [projectOne, projectTwo] = owner.projects;

    let reads = 0;
    await page.route("**/api/rendro/management/access?*", async route => {
      if (reads++ === 0) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Setup service unavailable" }) });
      else await route.continue();
    });
    await page.goto(`/organizations/${one.id}/onboarding?projectId=${projectOne.id}`);
    await expect(page.getByRole("heading", { name: "Unable to load setup", level: 2 })).toBeVisible();
    await expect(page.locator("#onboarding-stage .empty p")).toHaveText("Setup service unavailable");
    await expect(page.locator("#key-form")).toHaveCount(0);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connect the Rendro CLI", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unable to load setup" })).toHaveCount(0);
    expect(reads).toBe(2);

    // A project from another organization is not found by the page and rejected by the credential API; nothing is created.
    const foreign = await page.goto(`/organizations/${one.id}/onboarding?projectId=${projectTwo.id}`);
    expect(foreign!.status()).toBe(404);
    await expect(page.getByText("Page not found")).toBeVisible();
    await expect(page.locator("#key-form")).toHaveCount(0);
    const forged = await api(page, "/api/rendro/credentials", { organizationId: one.id, projectId: projectTwo.id, name: "Forged", scopes: ["docs:read"] });
    expect(forged.status).toBe(404);
    for (const organization of [one, two]) {
      const listed = await api<{ credentials: unknown[] }>(page, `/api/rendro/credentials?organizationId=${organization.id}`);
      expect(listed.body.credentials).toEqual([]);
    }

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
    for (const suffix of ["", `?projectId=${seed.projectId}`]) {
      await page.goto(`/organizations/${seed.organizationId}/onboarding${suffix}`);
      await expect(page.getByRole("heading", { name: "Setup is managed by organization admins", level: 2 })).toBeVisible();
      await expect(page.getByText("only an owner or admin can create projects and deployment credentials")).toBeVisible();
      await expect(page.locator("#project-form, #key-form")).toHaveCount(0);
      await expect(steps(page)).toHaveCount(3);
      await expect(page.getByRole("link", { name: "Return to overview", exact: true })).toHaveAttribute("href", `/organizations/${seed.organizationId}`);
    }
    const project = await api(page, "/api/rendro/projects", { organizationId: seed.organizationId, name: "Denied", slug: `denied-${info.project.name}` });
    expect(project.status).toBe(403);
    const credential = await api(page, "/api/rendro/credentials", { organizationId: seed.organizationId, projectId: seed.projectId, name: "Denied", scopes: ["docs:read"] });
    expect(credential.status).toBe(403);
    await page.getByRole("link", { name: "Return to overview", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${seed.organizationId}$`));
  });
});
