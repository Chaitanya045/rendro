import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, failOnce, join } from "./org-fixtures";
import { clipboard, fakeClipboard, heading } from "./shell-helpers";
import { root } from "./backend";
import {
  commitStaged, createKey, deploymentsOf, failStaged, html, openManagement, pushSite, startDeployment, uploadStaged, withKey,
} from "./project-helpers";

const { version } = JSON.parse(readFileSync(joinPath(root, "package.json"), "utf8")) as { version: string };
const history = (page: Page) => page.locator("#deployment-list tr.deployment-row");
const badge = (page: Page, index: number) => history(page).nth(index).locator("td").last().locator(".badge");

test.describe("deployments", () => {
  test("history moves from empty through staging, a failed attempt, a CLI push and a superseded release", async ({ actor, baseURL }) => {
    test.setTimeout(120_000);
    const owner = await actor("deploy", { organizations: ["Deploy Org"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects;
    const base = `/organizations/${organization.id}/projects/${project.id}`;
    const { rawKey } = await createKey(page, organization.id, project.id, undefined, { name: "Deploy key" });
    await fakeClipboard(page);

    // Empty history: the table says so, the count is zero and the CLI command pins this project, origin and version.
    await openManagement(page, `${base}/deployments`);
    await expect(heading(page)).toHaveText("Deployments");
    await expect(page.locator(".cp-page-description")).toHaveText("Release history for Deploy Org docs (docs), newest first.");
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Deployments", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Deployment history", level: 2 })).toBeVisible();
    await expect(page.getByText("The latest 100 immutable releases, newest first.")).toBeVisible();
    const table = page.getByRole("table", { name: "Project deployments" });
    await expect(table.getByRole("columnheader")).toHaveText(["Deployment", "Source", "Files", "Status"]);
    await expect(page.locator("#deployment-count")).toHaveText("0 shown");
    await expect(page.locator("#deployment-list")).toContainText("No deployments yet. Run the CLI command below to create the first immutable release.");
    await expect(page.locator(".deployment-table-wrap")).toHaveAttribute("aria-busy", "false");
    await expect(history(page)).toHaveCount(0);
    const command = [
      "# Set RENDRO_API_KEY securely in your environment; never commit it.",
      `npx --yes rendro@${version} push --source ./docs \\`,
      `  --organization '${organization.id}' --project '${project.id}' \\`,
      `  --endpoint '${baseURL}'`,
    ].join("\n");
    const panel = page.getByRole("complementary", { name: "Publish from the CLI" });
    await expect(panel.locator("code")).toHaveText(command);
    await panel.getByRole("button", { name: "Copy", exact: true }).click();
    await expect.poll(() => clipboard(page)).toEqual([command]);
    // A credential never appears in the instructions.
    expect(await panel.textContent()).not.toContain(rawKey);

    // A started deployment is staging: visible as such with its date, source commit, dirty flag, size and identifier,
    // not yet the project's release, and the docs entry stays closed.
    const staging = await startDeployment(rawKey, organization.id, project.id, { "index.html": html("Staged release") }, { commit: "0123456789abcdef0123", dirty: true });
    await page.reload();
    await expect(history(page)).toHaveCount(1);
    await expect(page.locator("#deployment-count")).toHaveText("1 shown");
    await expect(badge(page, 0)).toHaveText("Staging");
    await expect(badge(page, 0)).not.toHaveClass(/success|danger/);
    const stagingRow = history(page).first();
    const stagedAt = (await deploymentsOf(rawKey, organization.id, project.id)).body.deployments[0].createdAt;
    await expect(stagingRow.locator("td").first().locator("strong")).toHaveText(await page.evaluate(time => new Date(time).toLocaleString(), stagedAt));
    await expect(stagingRow.locator("td").nth(1).locator("strong")).toHaveText("0123456789ab");
    await expect(stagingRow.locator("td").nth(1)).toContainText("Uncommitted source changes");
    await expect(stagingRow.locator("td").nth(2).locator("strong")).toHaveText("1 files");
    await expect(stagingRow.locator("td").nth(2)).toHaveText(/^1 files\d+ KB$/);
    await expect(stagingRow.locator(".cp-id")).toHaveText(staging.deploymentId);
    await expect(page.locator("[data-cp-open-docs]:visible")).toHaveCount(0);
    const projectRead = async () => (await withKey<{ project: { activeDeploymentId?: string } }>(rawKey, `/api/rendro/projects/get?organizationId=${organization.id}&projectId=${project.id}`));
    // The Bearer-key project read is not offered to credentials: it is a session endpoint.
    expect([401, 403]).toContain((await projectRead()).status);
    const active = await withKey<{ deployment: unknown }>(rawKey, `/api/rendro/deployments/active?organizationId=${organization.id}&projectId=${project.id}`);
    expect(active.body.deployment).toBeNull();
    // Committing before the files are uploaded is refused, and the deployment is still only staging.
    const early = await commitStaged(rawKey, organization.id, project.id, staging);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("Deployment is incomplete; uploaded files do not match the manifest");
    expect((await deploymentsOf(rawKey, organization.id, project.id)).body.deployments.map(entry => entry.status)).toEqual(["staging"]);

    // The CLI (or the Worker) fails the attempt with a reason; the row says why.
    const reason = "Upload interrupted: connection reset";
    expect((await failStaged(rawKey, organization.id, project.id, staging, reason)).status).toBe(200);
    await page.reload();
    await expect(badge(page, 0)).toHaveText("Failed");
    await expect(badge(page, 0)).toHaveClass(/danger/);
    await expect(history(page).first().locator(".deployment-failure")).toHaveText(reason);
    expect((await deploymentsOf(rawKey, organization.id, project.id)).body.deployments[0]).toMatchObject({ status: "failed", failureReason: reason });
    // A failed deployment can no longer be uploaded to or committed.
    expect((await commitStaged(rawKey, organization.id, project.id, staging)).status).toBeGreaterThanOrEqual(400);
    await page.goto(`${base}`);
    await expect(page.locator(".project-overview .badge")).toHaveText("Not deployed");
    await expect(page.locator("#active-deployment")).toHaveText("None yet");
    await expect(page.getByRole("link", { name: "Open documentation" })).toHaveCount(0);
    await expect(page.locator("[data-cp-open-docs]:visible")).toHaveCount(0);

    // A real CLI push goes live: Active in history, Deployed on the overview, and documentation opens.
    await pushSite(baseURL, organization.id, project.id, rawKey, { "index.html": html("First release", "<p>one</p>") }, "deploy-one");
    const first = (await deploymentsOf(rawKey, organization.id, project.id)).body.deployments;
    expect(first.map(entry => entry.status)).toEqual(["active", "failed"]);
    await page.goto(`${base}/deployments`);
    await expect(page.locator("#deployment-count")).toHaveText("2 shown");
    await expect(badge(page, 0)).toHaveText("Active");
    await expect(badge(page, 0)).toHaveClass(/success/);
    await expect(badge(page, 1)).toHaveText("Failed");
    await expect(history(page).first().locator("td").nth(1)).toContainText("Source provenance");
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.locator(".project-overview .badge")).toHaveText("Deployed");
    await expect(page.locator("[data-cp-open-docs]:visible").first()).toHaveAttribute("href", `${base}/docs`);
    await expect(page.locator("#active-deployment .cp-id")).toHaveText(first[0]._id);
    const open = page.locator(".project-actions").getByRole("link", { name: "Open documentation", exact: true });
    await expect(open).toHaveAttribute("href", `${base}/docs`);
    await open.click();
    await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "First release" })).toBeVisible();

    // The next push supersedes it: exactly one active deployment, the old one remains in history as Superseded, and the docs follow.
    await pushSite(baseURL, organization.id, project.id, rawKey, { "index.html": html("Second release", "<p>two</p>") }, "deploy-two");
    const second = (await deploymentsOf(rawKey, organization.id, project.id)).body.deployments;
    expect(second.map(entry => entry.status)).toEqual(["active", "superseded", "failed"]);
    expect(second[1]._id).toBe(first[0]._id);
    await page.goto(`/organizations/${organization.id}/projects`);
    await expect(page.locator(".project-row .badge")).toHaveText("Deployed");
    await page.goto(`${base}/deployments`);
    await expect(page.locator("#deployment-count")).toHaveText("3 shown");
    await expect(history(page)).toHaveCount(3);
    await expect(history(page).locator("td:last-child .badge")).toHaveText(["Active", "Superseded", "Failed"]);
    await expect(history(page).first().locator(".cp-id")).toHaveText(second[0]._id);
    await page.goto(`${base}/docs`);
    await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Second release" })).toBeVisible();
    const activeNow = await withKey<{ deployment: { _id: string; status: string } }>(rawKey, `/api/rendro/deployments/active?organizationId=${organization.id}&projectId=${project.id}`);
    expect(activeNow.body.deployment).toMatchObject({ _id: second[0]._id, status: "active" });

    // Failing the live deployment is a no-op: only a staging deployment can fail, so a stale cleanup call cannot take the site down.
    const stale = { deploymentId: second[0]._id, manifestKey: "", files: {} };
    expect((await failStaged(rawKey, organization.id, project.id, stale, "stale cleanup")).status).toBe(200);
    expect((await deploymentsOf(rawKey, organization.id, project.id)).body.deployments.map(entry => entry.status)).toEqual(["active", "superseded", "failed"]);

    // A staged release can also be completed by hand: upload every file, then commit, and the previous release is superseded.
    const manual = await startDeployment(rawKey, organization.id, project.id, { "index.html": html("Manual release") });
    expect((await deploymentsOf(rawKey, organization.id, project.id)).body.deployments[0].status).toBe("staging");
    await uploadStaged(rawKey, organization.id, project.id, manual);
    expect((await commitStaged(rawKey, organization.id, project.id, manual)).status).toBe(200);
    expect((await deploymentsOf(rawKey, organization.id, project.id)).body.deployments.map(entry => entry.status)).toEqual(["active", "superseded", "superseded", "failed"]);
    await page.goto(`${base}/docs`);
    await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Manual release" })).toBeVisible();
  });

  test("a failed history read shows an isolated retry and the page chrome stays usable", async ({ actor, baseURL }) => {
    test.setTimeout(90_000);
    const owner = await actor("deploy-retry", { organizations: ["Retry Org"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects;
    const base = `/organizations/${organization.id}/projects/${project.id}`;
    const { rawKey } = await createKey(page, organization.id, project.id);
    await pushSite(baseURL, organization.id, project.id, rawKey, { "index.html": html("Retry release") }, "deploy-retry");

    // Entered from the project overview, the history read is a request that can fail on its own.
    await openManagement(page, base);
    const outage = await failOnce(page, "**/api/rendro/deployments?*", "History is unavailable");
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Deployments", exact: true }).click();
    await expect(page).toHaveURL(`${base}/deployments`);
    const failure = page.locator("#deployment-list .mini-empty");
    await expect(failure).toHaveText(/Deployment history could not be loaded\./);
    await expect(failure).toHaveAttribute("role", "status");
    await expect(page.locator(".deployment-table-wrap")).toHaveAttribute("aria-busy", "false");
    // The project chrome and the CLI instructions did not wait for, or disappear with, the history.
    await expect(heading(page)).toHaveText("Deployments");
    await expect(page.getByRole("complementary", { name: "Publish from the CLI" })).toBeVisible();
    await failure.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(history(page)).toHaveCount(1);
    await expect(badge(page, 0)).toHaveText("Active");
    await expect(page.locator("#deployment-count")).toHaveText("1 shown");
    await expect(failure).toHaveCount(0);
    expect(outage.failures()).toBe(1);
    await outage.close();
  });

  test("the organization overview shows project release state and the recent deployment, which retries on its own", async ({ actor, baseURL }) => {
    test.setTimeout(120_000);
    const owner = await actor("overview", { organizations: ["Overview Org"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects;
    const { rawKey } = await createKey(page, organization.id, project.id);
    const metrics = page.locator(".overview-metrics .metric");
    const checklist = page.locator("#workspace-checklist .checklist-row");
    const recent = page.locator("#recent-deployment");

    // Before the first deployment: the project is not deployed, the checklist stops at the project, and nothing is recent.
    await openManagement(page, `/organizations/${organization.id}`);
    await expect(page.getByRole("heading", { name: "Workspace status" })).toBeVisible();
    await expect(metrics.locator("strong")).toHaveText(["1", "1", "1"]);
    await expect(metrics.locator("span")).toHaveText(["Projects", "Members", "Teams"]);
    const projectRow = page.locator("#overview-projects .overview-row");
    await expect(projectRow).toHaveCount(1);
    await expect(projectRow).toHaveAttribute("href", `/organizations/${organization.id}/projects/${project.id}`);
    await expect(projectRow.locator(".badge")).toHaveText("Not deployed");
    await expect(checklist).toHaveText(["DoneOrganization created", "DoneCreate a project", "Push the first deployment", "Invite a teammate (optional)"]);
    await expect(checklist.nth(2)).not.toHaveClass(/complete/);
    await expect(recent).toHaveText("No deployment has been committed yet.");

    // After a CLI push: Deployed, the checklist step is done, and the recent deployment names the project and its state.
    await pushSite(baseURL, organization.id, project.id, rawKey, { "index.html": html("Overview release") }, "overview");
    await openManagement(page, `/organizations/${organization.id}`);
    await expect(projectRow.locator(".badge")).toHaveText("Deployed");
    await expect(checklist.nth(2)).toHaveClass(/complete/);
    await expect(recent.locator(".overview-row strong")).toHaveText("Overview Org docs");
    await expect(recent.locator(".overview-row .cell-secondary")).toHaveText("Immutable deployment");
    await expect(recent.locator(".overview-row .badge")).toHaveText("Active");
    await expect(recent.locator(".overview-row .badge")).toHaveClass(/success/);

    // The recent-deployment read can fail on its own: the rest of the page stays, and Try again restores only that panel.
    const outage = await failOnce(page, "**/api/rendro/management/recent-deployment?*", "Recent deployment unavailable");
    await page.reload();
    await expect(recent.locator(".mini-empty")).toHaveText(/Recent deployment could not be loaded\./);
    await expect(recent.locator(".mini-empty")).toHaveAttribute("role", "status");
    await expect(projectRow.locator(".badge")).toHaveText("Deployed");
    await expect(metrics.locator("strong")).toHaveText(["1", "1", "1"]);
    await recent.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(recent.locator(".overview-row strong")).toHaveText("Overview Org docs");
    await expect(recent.locator(".mini-empty")).toHaveCount(0);
    expect(outage.failures()).toBe(1);
    await outage.close();

    // A member sees the same panel.
    const visitor = await actor("overview-member");
    await join(owner, organization.id, visitor, "member");
    await openManagement(visitor.page, `/organizations/${organization.id}`);
    await expect(visitor.page.locator("#recent-deployment .overview-row strong")).toHaveText("Overview Org docs");
    await expect(visitor.page.locator("#recent-deployment .overview-row .badge")).toHaveText("Active");
  });

  test("members read the history without write controls; outsiders and anonymous visitors cannot reach it", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(120_000);
    const owner = await actor("deploy-roles-owner", { organizations: ["Deploy Roles"], project: true });
    const member = await actor("deploy-roles-member");
    const outsider = await actor("deploy-roles-outsider", { organizations: ["Deploy Elsewhere"] });
    const [organization] = owner.organizations;
    const [project] = owner.projects;
    await join(owner, organization.id, member, "member");
    const { rawKey } = await createKey(owner.page, organization.id, project.id);
    await pushSite(baseURL, organization.id, project.id, rawKey, { "index.html": html("Roles release") }, "deploy-roles");
    const base = `/organizations/${organization.id}/projects/${project.id}`;

    // The member sees the same history as the owner, plus the read-only note.
    for (const person of [owner, member]) {
      await openManagement(person.page, `${base}/deployments`);
      await expect(history(person.page)).toHaveCount(1);
      await expect(badge(person.page, 0)).toHaveText("Active");
      const note = person.page.locator(".access-note");
      if (person === member) await expect(note).toHaveText("You have read-only project access. Owners and admins manage publications and revoke private shares.");
      else await expect(note).toHaveCount(0);
    }
    // Members and owners read through their session; members cannot start, commit or fail a deployment with it.
    expect((await member.page.evaluate(async url => (await fetch(url)).status, `/api/rendro/deployments?organizationId=${organization.id}&projectId=${project.id}`))).toBe(200);
    const sessionStart = await member.page.evaluate(async ({ organizationId, projectId }) => (await fetch("/api/rendro/deployments/start", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, projectId, manifest: { version: 1, files: [] }, manifestSha256: "0".repeat(64) }),
    })).status, { organizationId: organization.id, projectId: project.id });
    expect(sessionStart).toBeGreaterThanOrEqual(400);
    expect(sessionStart).toBeLessThan(500);
    expect((await deploymentsOf(rawKey, organization.id, project.id)).body.deployments).toHaveLength(1);

    // An outsider: no page, no history, and the organization's key cannot be replayed from their session.
    const denied = await outsider.page.goto(`${base}/deployments`);
    expect(denied!.status()).toBe(404);
    await expect(outsider.page.getByText("Page not found")).toBeVisible();
    expect((await outsider.page.evaluate(async url => (await fetch(url)).status, `/api/rendro/deployments?organizationId=${organization.id}&projectId=${project.id}`))).toBe(403);

    // Anonymous: the page requires sign-in and the API requires a credential.
    const visitor = await secondContext.newPage();
    await visitor.goto(`${base}/deployments`);
    await expect(visitor).toHaveURL(`/sign-in?returnTo=${encodeURIComponent(`${base}/deployments`)}`);
    expect([401, 403]).toContain((await withKey(undefined, `/api/rendro/deployments?organizationId=${organization.id}&projectId=${project.id}`)).status);
    expect((await withKey(undefined, "/api/rendro/deployments/start", { organizationId: organization.id, projectId: project.id })).status).toBeGreaterThanOrEqual(400);
  });
});
