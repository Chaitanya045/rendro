import type { Page } from "@playwright/test";
import { test, expect, choose, confirmDialog, failOnce, join, toasts } from "./org-fixtures";
import { holdRequest } from "./auth-helpers";
import { clipboard, fakeClipboard, api } from "./shell-helpers";
import { createKey, openManagement, publisherScopes, watch, withKey, type Credential } from "./project-helpers";

/**
 * Keys no longer push or read anything since uploads left (#286); what each one may do is the credential check's answer,
 * which is also what records its use.
 */
const keyPattern = /^rnd_live_[0-9a-f]{16}_[0-9a-f]{64}$/;
const rowOf = (page: Page, name: string) => page.locator("#key-list tr", { hasText: name });
const secret = (key: string) => key.split("_")[3];
const validate = (key: string | undefined, organizationId: string, projectId: string | undefined, scope: string) =>
  withKey(key, `/api/rendro/credentials/validate?organizationId=${organizationId}${projectId ? `&projectId=${projectId}` : ""}&scope=${scope}`);
type Listed = Credential & { revokedAt?: number; lastUsedAt?: number; createdAt: number };
const listKeys = async (page: Page, organizationId: string) => (await api<{ credentials: Listed[] }>(page, `/api/rendro/credentials?organizationId=${organizationId}`)).body.credentials;
const day = (page: Page, time: number) => page.evaluate(value => new Date(value).toLocaleDateString(), time);

async function openKeys(page: Page, organizationId: string) {
  await openManagement(page, `/organizations/${organizationId}/api-keys`);
}

test.describe("API keys", () => {
  test("an owner creates a scoped key with a one-time secret, uses it, and revoking it stops the very next request", async ({ actor }) => {
    test.setTimeout(150_000);
    const owner = await actor("keys", { organizations: ["Keys Org"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [first] = owner.projects.map(entry => entry.id);
    const second = await api<{ project: { _id: string } }>(page, "/api/rendro/projects", { organizationId: organization.id, name: "Second docs", slug: "second" });
    expect(second.status).toBe(201);
    await fakeClipboard(page);
    const credentialRequests = watch(page, "/api/rendro/credentials");

    // Empty list: says so, offers the action and loads the dialog once projects are known (the newest project is the default scope).
    await openKeys(page, organization.id);
    await expect(page.getByRole("heading", { name: "API keys", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No API keys yet", level: 2 })).toBeVisible();
    const create = page.locator("#api-key-create");
    await expect(create).toBeEnabled();
    await create.click();
    const dialog = page.locator("#key-dialog");
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.matches(":modal"))).toBe(true);
    const name = dialog.locator("input[name=name]");
    const submit = dialog.getByRole("button", { name: "Create API key", exact: true });
    const failure = page.locator("#key-error");
    await expect(dialog.getByRole("combobox", { name: /Project scope/ })).toHaveText("Second docs");
    await expect(dialog.getByRole("combobox", { name: /Expiration/ })).toHaveText("90 days");
    await expect(dialog.locator(".scope-fieldset legend")).toHaveText("Permissions");
    await expect(dialog.locator(".scope-fieldset .check")).toHaveText(["Read deployments", "Push documentation", "Read publications", "Manage publications"]);
    expect(await dialog.locator("input[name=scope]").evaluateAll(inputs => (inputs as HTMLInputElement[]).map(input => [input.value, input.checked])))
      .toEqual([["docs:read", true], ["docs:write", true], ["publications:read", false], ["publications:write", false]]);

    // Validation: a name is required, and so is at least one permission; neither sends a request.
    const writes = () => credentialRequests.filter(entry => entry.startsWith("POST"));
    await submit.click();
    await expect(name).toBeFocused();
    await name.fill("CI deploy");
    await dialog.getByLabel("Read deployments").uncheck();
    await dialog.getByLabel("Push documentation").uncheck();
    await submit.click();
    await expect(failure).toHaveText("Choose at least one permission.");
    await expect(failure).toHaveAttribute("role", "alert");
    expect(writes()).toEqual([]);

    // Choices: project, expiry and scopes; a rejected create keeps every one of them and shows no secret.
    await dialog.getByLabel("Read deployments").check();
    await dialog.getByLabel("Push documentation").check();
    await dialog.getByLabel("Read publications").check();
    await choose(page, /Project scope/, "Keys Org docs", dialog);
    await choose(page, /Expiration/, "30 days", dialog);
    const outage = await failOnce(page, "**/api/rendro/credentials", "Key service unavailable", 503);
    await submit.click();
    await expect(failure).toHaveText("Key service unavailable");
    await expect(submit).toBeEnabled();
    await expect(submit).not.toHaveAttribute("aria-busy", "true");
    await expect(name).toHaveValue("CI deploy");
    await expect(dialog.getByRole("combobox", { name: /Project scope/ })).toHaveText("Keys Org docs");
    await expect(dialog.getByRole("combobox", { name: /Expiration/ })).toHaveText("30 days");
    await expect(dialog.getByLabel("Read deployments")).toBeChecked();
    await expect(dialog.getByLabel("Push documentation")).toBeChecked();
    await expect(dialog.getByLabel("Read publications")).toBeChecked();
    await expect(dialog.getByLabel("Manage publications")).not.toBeChecked();
    await expect(page.locator("#secret-dialog")).toBeHidden();
    expect(await listKeys(page, organization.id)).toEqual([]);
    expect(outage.failures()).toBe(1);
    await outage.close();

    // Retry succeeds: the form is closed and reset, and the secret appears once in a modal that cannot be left unconfirmed.
    await submit.click();
    const reveal = page.locator("#secret-dialog");
    await expect(reveal).toBeVisible();
    expect(await reveal.evaluate(element => element.matches(":modal"))).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(failure).toBeEmpty();
    const rawKey = (await page.locator("#raw-key").textContent())!;
    expect(rawKey).toMatch(keyPattern);
    const done = page.locator("#secret-done"), stored = page.locator("#secret-confirmed");
    await expect(done).toBeDisabled();
    await expect(reveal.getByRole("heading", { name: "API key created" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(toasts(page).filter({ hasText: "Confirm that the key is stored before closing." })).toHaveCount(1);
    await expect(reveal).toBeVisible();
    await expect(page.locator("#raw-key")).toHaveText(rawKey);

    // Copying: the key and the environment assignment are exact; a rejected clipboard says so and leaves the key readable.
    await page.locator("#copy-key").click();
    await expect.poll(() => clipboard(page)).toEqual([rawKey]);
    await page.locator("#copy-env").click();
    await expect.poll(() => clipboard(page)).toEqual([rawKey, `RENDRO_API_KEY="${rawKey}"`]);
    await page.evaluate(() => { (window as unknown as { clipboardState: { mode: string } }).clipboardState.mode = "reject"; });
    await page.locator("#copy-key").click();
    await expect(toasts(page).filter({ hasText: "Unable to copy. Select and copy the key manually." })).toHaveCount(1);
    await expect(page.locator("#raw-key")).toHaveText(rawKey);

    // The key is real before the dialog closes: it validates for its own scopes and project only, and was created with those choices.
    const [created] = await listKeys(page, organization.id);
    expect(created).toMatchObject({ name: "CI deploy", projectId: first, keyPrefix: rawKey.split("_").slice(0, 3).join("_") });
    expect([...created.scopes].sort()).toEqual(["docs:read", "docs:write", "publications:read"]);
    expect(Math.abs(created.expiresAt! - (Date.now() + 30 * 86_400_000))).toBeLessThan(5 * 60_000);
    expect(created.revokedAt).toBeUndefined();
    expect(JSON.stringify(created)).not.toContain(secret(rawKey));
    expect(Object.keys(created)).not.toContain("secretHash");
    expect((await validate(rawKey, organization.id, first, "docs:write")).status).toBe(200);
    expect((await validate(rawKey, organization.id, first, "publications:write")).status).toBe(401);
    expect((await validate(rawKey, organization.id, second.body.project._id, "docs:write")).status).toBe(401);

    // Confirming storage releases Done; closing scrubs the secret from the DOM, storage and the visible page.
    await stored.check();
    await expect(done).toBeEnabled();
    await done.click();
    await expect(reveal).toBeHidden();
    await expect(page.locator("#raw-key")).toHaveText("");
    expect(await page.evaluate(() => document.documentElement.outerHTML + JSON.stringify([localStorage, sessionStorage, document.cookie]))).not.toContain(secret(rawKey));
    await expect(create).toBeFocused();

    // The list shows the stored facts without the secret.
    const row = rowOf(page, "CI deploy");
    await expect(row).toHaveCount(1);
    await expect(row.locator("td[data-label=Name] code")).toHaveText(`${created.keyPrefix}********`);
    await expect(row.locator("td[data-label=Scope]")).toHaveText("Keys Org docs");
    await expect(row.locator("td[data-label=Permissions] .badge")).toHaveText(["Read deployments", "Push documentation", "Read publications"]);
    await expect(row.locator("td[data-label='Expires']")).toHaveText(await day(page, created.expiresAt!));
    await expect(row.locator("td[data-label=Status] .badge")).toHaveText("Active");
    await expect(row.locator("td[data-label=Status] .badge")).toHaveClass(/success/);
    expect(await page.locator("#key-list").textContent()).not.toContain(secret(rawKey));

    // A key that authenticates has its use recorded; one that was never presented has none.
    const keyWithRead = await createKey(page, organization.id, first, ["docs:read"], { name: "Reader" });
    await createKey(page, organization.id, first, ["docs:read"], { name: "Unused" });
    expect((await validate(keyWithRead.rawKey, organization.id, first, "docs:read")).status).toBe(200);
    await expect.poll(async () => (await listKeys(page, organization.id)).find(entry => entry.keyId === created.keyId)?.lastUsedAt).toBeGreaterThan(0);
    await openKeys(page, organization.id);
    await expect(rowOf(page, "CI deploy").locator("td[data-label='Last used']")).not.toHaveText("Never");
    await expect(rowOf(page, "Reader").locator("td[data-label='Last used']")).not.toHaveText("Never");
    await expect(rowOf(page, "Unused").locator("td[data-label='Last used']")).toHaveText("Never");

    // Revoke: Escape keeps the key and returns focus; confirming marks it revoked at once, and the next request is refused.
    const revoke = rowOf(page, "CI deploy").getByRole("button", { name: "Revoke CI deploy", exact: true });
    await revoke.click();
    const confirm = confirmDialog(page);
    await expect(confirm.locator("#cp-confirm-title")).toHaveText("Revoke API key?");
    await expect(confirm.locator("#cp-confirm-message")).toContainText("Any job using “CI deploy” will stop authenticating immediately.");
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(revoke).toBeFocused();
    await expect(rowOf(page, "CI deploy").locator("td[data-label=Status] .badge")).toHaveText("Active");
    expect((await validate(rawKey, organization.id, first, "docs:write")).status).toBe(200);
    // A failed revocation says so, keeps the key active and leaves the control usable for another try.
    const hold = await holdRequest(page, "/api/rendro/credentials/revoke");
    try {
      await revoke.click();
      await confirm.locator("[data-confirm-accept]").click();
      await expect(revoke).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => hold.count()).toBe(1);
      hold.release(true);
      await expect(toasts(page).filter({ hasText: "Service unavailable. Please try again." })).toHaveCount(1);
    } finally {
      await hold.close();
    }
    await expect(revoke).toBeEnabled();
    await expect(revoke).not.toHaveAttribute("aria-busy", "true");
    await expect(rowOf(page, "CI deploy").locator("td[data-label=Status] .badge")).toHaveText("Active");
    expect((await validate(rawKey, organization.id, first, "docs:write")).status).toBe(200);
    await revoke.click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "API key revoked." })).toHaveCount(1);
    const revokedRow = rowOf(page, "CI deploy");
    await expect(revokedRow.locator("td[data-label=Status] .badge")).toHaveText("Revoked");
    await expect(revokedRow.locator("td[data-label=Status] .badge")).toHaveClass(/danger/);
    await expect(revokedRow.getByRole("button")).toHaveCount(0);
    await expect(rowOf(page, "Reader").locator("td[data-label=Status] .badge")).toHaveText("Active");
    expect((await validate(rawKey, organization.id, first, "docs:write")).status).toBe(401);
    expect((await listKeys(page, organization.id)).find(entry => entry.keyId === created.keyId)?.revokedAt).toBeGreaterThan(0);
    // The other key is unaffected.
    expect((await validate(keyWithRead.rawKey, organization.id, first, "docs:read")).status).toBe(200);
    // Revoking again is harmless and the key stays revoked.
    expect((await api(page, "/api/rendro/credentials/revoke", { organizationId: organization.id, keyId: created.keyId })).status).toBe(200);
    await page.reload();
    await expect(rowOf(page, "CI deploy").locator("td[data-label=Status] .badge")).toHaveText("Revoked");
  });

  test("scopes and project binding decide what each key can do", async ({ actor }) => {
    test.setTimeout(150_000);
    const owner = await actor("scopes", { organizations: ["Scopes Org", "Scopes Other"], project: true });
    const { page } = owner;
    const [organization, other] = owner.organizations;
    const [projectA, otherProject] = owner.projects.map(entry => entry.id);
    const projectB = (await api<{ project: { _id: string } }>(page, "/api/rendro/projects", { organizationId: organization.id, name: "B", slug: "b" })).body.project._id;
    const wide = await createKey(page, organization.id, undefined, publisherScopes, { name: "Organization-wide" });
    const readA = await createKey(page, organization.id, projectA, ["docs:read"], { name: "Read A" });
    const writeA = await createKey(page, organization.id, projectA, ["docs:write"], { name: "Write A" });
    const pusherA = await createKey(page, organization.id, projectA, ["docs:read", "docs:write"], { name: "Pusher A" });
    const publishA = await createKey(page, organization.id, projectA, ["docs:read", "publications:read", "publications:write"], { name: "Publish A" });
    const pubOnly = await createKey(page, organization.id, projectA, ["publications:read", "publications:write"], { name: "Publications only" });

    // A project key answers for its own project and its own scopes only; reading is not implied by writing.
    expect((await validate(readA.rawKey, organization.id, projectA, "docs:read")).status).toBe(200);
    expect((await validate(readA.rawKey, organization.id, projectB, "docs:read")).status).toBe(401);
    expect((await validate(readA.rawKey, organization.id, projectA, "docs:write")).status).toBe(401);
    expect((await validate(writeA.rawKey, organization.id, projectA, "docs:write")).status).toBe(200);
    expect((await validate(writeA.rawKey, organization.id, projectA, "docs:read")).status).toBe(401);
    expect((await validate(pusherA.rawKey, organization.id, projectA, "docs:write")).status).toBe(200);
    expect((await validate(pusherA.rawKey, organization.id, projectB, "docs:write")).status).toBe(401);
    // The organization-wide key reaches every project of its own organization, and none of another one.
    for (const project of [projectA, projectB, undefined]) expect((await validate(wide.rawKey, organization.id, project, "docs:read")).status).toBe(200);
    expect((await validate(wide.rawKey, other.id, otherProject, "docs:read")).status).toBe(401);
    expect((await validate(readA.rawKey, organization.id, undefined, "docs:read")).status).toBe(401);
    expect((await validate(readA.rawKey, organization.id, "not-an-id", "docs:read")).status).toBe(401);
    // Publication scopes are independent of document scopes.
    expect((await validate(publishA.rawKey, organization.id, projectA, "publications:write")).status).toBe(200);
    expect((await validate(pubOnly.rawKey, organization.id, projectA, "publications:write")).status).toBe(200);
    expect((await validate(pubOnly.rawKey, organization.id, projectA, "docs:read")).status).toBe(401);
    expect((await validate(readA.rawKey, organization.id, projectA, "publications:write")).status).toBe(401);

    // Keys manage nothing about keys or people: credentials need an owner/admin session, whatever the key's scopes.
    for (const key of [wide.rawKey, publishA.rawKey]) {
      expect([401, 403]).toContain((await withKey(key, `/api/rendro/credentials?organizationId=${organization.id}`)).status);
      expect([401, 403]).toContain((await withKey(key, "/api/rendro/credentials", { organizationId: organization.id, name: "Escalate", scopes: ["docs:read"] })).status);
      expect([401, 403]).toContain((await withKey(key, "/api/rendro/credentials/revoke", { organizationId: organization.id, keyId: readA.credential.keyId })).status);
    }
    expect((await listKeys(page, organization.id)).map(entry => entry.name).sort()).toEqual(["Organization-wide", "Publications only", "Publish A", "Pusher A", "Read A", "Write A"]);
    expect((await validate(readA.rawKey, organization.id, projectA, "docs:read")).status).toBe(200);

    // Unknown, malformed and absent credentials are all refused alike.
    for (const key of [undefined, "", "rnd_live_nothing", `rnd_live_${"0".repeat(16)}_${"0".repeat(64)}`, wide.rawKey.slice(0, -1) + (wide.rawKey.endsWith("0") ? "1" : "0")]) {
      expect((await validate(key, organization.id, projectA, "docs:read")).status, String(key)).toBe(401);
    }
  });

  test("expiry: a short-lived key works until it expires, then the next request is refused; bad creation fields are rejected", async ({ actor }) => {
    test.setTimeout(120_000);
    const owner = await actor("expiry", { organizations: ["Expiry Org"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);

    // Fields the server refuses, each leaving no key behind.
    const body = (extra: object) => ({ organizationId: organization.id, projectId: project, name: "Bad", scopes: ["docs:read"], ...extra });
    const invalid: Array<[string, object]> = [
      ["an expiry in the past", { expiresAt: Date.now() - 1000 }],
      ["a non-numeric expiry", { expiresAt: "tomorrow" }],
      ["a blank name", { name: "   " }],
      ["a name over 80 characters", { name: "n".repeat(81) }],
      ["no permission", { scopes: [] }],
      ["an unknown permission", { scopes: ["docs:read", "docs:admin"] }],
      ["a non-array permission list", { scopes: "docs:read" }],
    ];
    for (const [label, extra] of invalid) {
      const response = await api(page, "/api/rendro/credentials", body(extra));
      expect(response.status, label).toBe(400);
    }
    expect((await api(page, "/api/rendro/credentials", body({ projectId: "k".repeat(32) }))).status).toBe(404);
    expect(await listKeys(page, organization.id)).toEqual([]);

    // The short-lived key is created last and used only for requests that take milliseconds, so the test never races its
    // own deadline.
    const expiring = await createKey(page, organization.id, project, ["docs:read"], { name: "Two days", expiresAt: Date.now() + 2 * 86_400_000 });
    const forever = await createKey(page, organization.id, undefined, ["docs:read"], { name: "Forever" });
    // It works now, and is refused on the first request after its time has passed.
    const shortLived = await createKey(page, organization.id, project, publisherScopes, { name: "Short lived", expiresAt: Date.now() + 10_000 });
    expect((await validate(shortLived.rawKey, organization.id, project, "docs:write")).status).toBe(200);
    await expect.poll(async () => (await validate(shortLived.rawKey, organization.id, project, "docs:write")).status, { timeout: 30_000, intervals: [500, 1000] }).toBe(401);
    expect((await validate(forever.rawKey, organization.id, project, "docs:read")).status).toBe(200);

    // The page tells expired, expiring and never-expiring keys apart, and an expired key can still be revoked.
    await openKeys(page, organization.id);
    const cells = async (name: string) => ({ expires: await rowOf(page, name).locator("td[data-label='Expires']").textContent(), status: await rowOf(page, name).locator("td[data-label=Status] .badge").textContent() });
    expect(await cells("Short lived")).toEqual({ expires: await day(page, shortLived.credential.expiresAt!), status: "Expired" });
    expect(await cells("Two days")).toEqual({ expires: await day(page, expiring.credential.expiresAt!), status: "Expiring" });
    expect(await cells("Forever")).toEqual({ expires: "Never", status: "Active" });
    await expect(rowOf(page, "Short lived").locator(".badge.danger")).toHaveText("Expired");
    await expect(rowOf(page, "Two days").locator(".badge.warning")).toHaveText("Expiring");
    await rowOf(page, "Short lived").getByRole("button", { name: "Revoke Short lived", exact: true }).click();
    await confirmDialog(page).locator("[data-confirm-accept]").click();
    await expect(rowOf(page, "Short lived").locator("td[data-label=Status] .badge")).toHaveText("Revoked");
    // The keys that did not expire are untouched.
    expect((await validate(expiring.rawKey, organization.id, project, "docs:read")).status).toBe(200);
    expect((await validate(forever.rawKey, organization.id, project, "docs:read")).status).toBe(200);
  });

  test("owner, admin, member and outsider: who can see, create and revoke keys", async ({ actor, secondContext }) => {
    test.setTimeout(150_000);
    const owner = await actor("keys-owner", { organizations: ["Keys Roles"], project: true });
    const admin = await actor("keys-admin");
    const member = await actor("keys-member");
    const outsider = await actor("keys-outsider", { organizations: ["Keys Elsewhere"], project: true });
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    await join(owner, organization.id, admin, "admin");
    await join(owner, organization.id, member, "member");
    const ownerKey = await createKey(owner.page, organization.id, project, ["docs:read"], { name: "Owner key" });
    const adminKey = await createKey(admin.page, organization.id, project, ["docs:read"], { name: "Admin key" });
    const elsewhere = await createKey(outsider.page, outsider.organizations[0].id, outsider.projects[0].id, ["docs:read"], { name: "Elsewhere key" });
    expect((await listKeys(owner.page, organization.id)).map(entry => entry.name).sort()).toEqual(["Admin key", "Owner key"]);

    // An admin sees every key and can revoke the owner's; the revoked key stops at once, the admin's own key is untouched.
    await openKeys(admin.page, organization.id);
    await expect(admin.page.locator("#api-key-create")).toBeVisible();
    await expect(rowOf(admin.page, "Owner key")).toHaveCount(1);
    await expect(rowOf(admin.page, "Admin key")).toHaveCount(1);
    await rowOf(admin.page, "Owner key").getByRole("button", { name: "Revoke Owner key", exact: true }).click();
    await confirmDialog(admin.page).locator("[data-confirm-accept]").click();
    await expect(rowOf(admin.page, "Owner key").locator("td[data-label=Status] .badge")).toHaveText("Revoked");
    expect((await validate(ownerKey.rawKey, organization.id, project, "docs:read")).status).toBe(401);
    expect((await validate(adminKey.rawKey, organization.id, project, "docs:read")).status).toBe(200);

    // The owner sees the admin's revocation as well, with both the controls the owner needs.
    await openKeys(owner.page, organization.id);
    await expect(rowOf(owner.page, "Owner key").locator("td[data-label=Status] .badge")).toHaveText("Revoked");
    await expect(owner.page.locator("#api-key-create")).toBeVisible();

    // A member gets an explanation, no key data, no create control and no credential request.
    const memberRequests = watch(member.page, "/api/rendro/credentials");
    await openKeys(member.page, organization.id);
    const restricted = member.page.locator("#keys-restricted");
    await expect(restricted).toHaveAttribute("role", "status");
    await expect(restricted.getByRole("heading", { name: "API key access is restricted", level: 2 })).toBeVisible();
    await expect(restricted).toContainText("Only organization owners and admins can view or manage API keys.");
    await expect(restricted.getByRole("link", { name: "View projects", exact: true })).toHaveAttribute("href", `/organizations/${organization.id}/projects`);
    await expect(member.page.locator("#api-key-create")).toBeHidden();
    await expect(member.page.locator(".table-wrap")).toBeHidden();
    await expect(member.page.locator("#key-list")).toBeEmpty();
    expect(await member.page.locator("body").innerText()).not.toContain("Owner key");
    expect(memberRequests).toEqual([]);
    await restricted.getByRole("link", { name: "View projects", exact: true }).click();
    await expect(member.page).toHaveURL(`/organizations/${organization.id}/projects`);
    // The same refusal holds for the API, for reading, creating and revoking.
    expect((await api(member.page, `/api/rendro/credentials?organizationId=${organization.id}`)).status).toBe(403);
    expect((await api(member.page, "/api/rendro/credentials", { organizationId: organization.id, projectId: project, name: "Member key", scopes: ["docs:read"] })).status).toBe(403);
    expect((await api(member.page, "/api/rendro/credentials/revoke", { organizationId: organization.id, keyId: adminKey.credential.keyId })).status).toBe(403);
    expect((await validate(adminKey.rawKey, organization.id, project, "docs:read")).status).toBe(200);

    // An outsider has no page and no API access to this organization's keys, and cannot revoke them by naming their own organization.
    const denied = await outsider.page.goto(`/organizations/${organization.id}/api-keys`);
    expect(denied!.status()).toBe(404);
    await expect(outsider.page.getByText("Page not found")).toBeVisible();
    expect((await api(outsider.page, `/api/rendro/credentials?organizationId=${organization.id}`)).status).toBe(403);
    expect((await api(outsider.page, "/api/rendro/credentials", { organizationId: organization.id, projectId: project, name: "Outsider key", scopes: ["docs:read"] })).status).toBe(403);
    expect((await api(outsider.page, "/api/rendro/credentials/revoke", { organizationId: organization.id, keyId: adminKey.credential.keyId })).status).toBe(403);
    const crossOrganization = await api(outsider.page, "/api/rendro/credentials/revoke", { organizationId: outsider.organizations[0].id, keyId: adminKey.credential.keyId });
    expect(crossOrganization.status).toBeGreaterThanOrEqual(400);
    expect((await validate(adminKey.rawKey, organization.id, project, "docs:read")).status).toBe(200);
    expect((await validate(elsewhere.rawKey, outsider.organizations[0].id, outsider.projects[0].id, "docs:read")).status).toBe(200);
    // Nor does a key carry across organizations.
    expect((await validate(elsewhere.rawKey, organization.id, project, "docs:read")).status).toBe(401);
    expect((await listKeys(owner.page, organization.id)).map(entry => [entry.name, Boolean(entry.revokedAt)]).sort()).toEqual([["Admin key", false], ["Owner key", true]]);

    // Anonymous visitors are sent to sign in and the API refuses them.
    const visitor = await secondContext.newPage();
    await visitor.goto(`/organizations/${organization.id}/api-keys`);
    await expect(visitor).toHaveURL(`/sign-in?returnTo=${encodeURIComponent(`/organizations/${organization.id}/api-keys`)}`);
    for (const response of [await withKey(undefined, `/api/rendro/credentials?organizationId=${organization.id}`), await withKey(undefined, "/api/rendro/credentials", { organizationId: organization.id, name: "Anon", scopes: ["docs:read"] })]) {
      expect([401, 403]).toContain(response.status);
    }
  });

  test("a key list that fails to load recovers with Try again", async ({ actor }) => {
    test.setTimeout(90_000);
    const owner = await actor("keys-retry", { organizations: ["Keys Retry"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    await createKey(page, organization.id, owner.projects[0].id, ["docs:read"], { name: "Survivor" });
    const outage = await failOnce(page, "**/api/rendro/credentials?*", "Credential list unavailable");
    await page.goto(`/organizations/${organization.id}/api-keys`);
    await expect(page.getByRole("heading", { name: "Unable to load API keys", level: 2 })).toBeVisible();
    await expect(page.locator("#key-list .empty p")).toHaveText("Credential list unavailable");
    await expect(page.locator("#api-key-create")).toBeDisabled();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(rowOf(page, "Survivor")).toHaveCount(1);
    await expect(page.locator("#api-key-create")).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Unable to load API keys" })).toHaveCount(0);
    expect(outage.failures()).toBe(1);
    await outage.close();
  });

  // The expiry must be an exact integer in the future and within the longest product choice (a year).
  test("a key expiry beyond the representable date range is rejected", async ({ actor }) => {
    test.setTimeout(90_000);
    const owner = await actor("keys-far", { organizations: ["Keys Far"] });
    const [organization] = owner.organizations;
    const now = Date.now();
    for (const expiresAt of [1e300, now + 400 * 86_400_000, now - 1000, now + 1.5]) {
      const refused = await api<{ error: string }>(owner.page, "/api/rendro/credentials", { organizationId: organization.id, name: "Far", scopes: ["docs:read"], expiresAt });
      expect(refused.status, String(expiresAt)).toBe(400);
      expect(refused.body).toEqual({ error: "Invalid credential fields" });
    }
    expect(await listKeys(owner.page, organization.id)).toEqual([]);
    const year = await api(owner.page, "/api/rendro/credentials", { organizationId: organization.id, name: "Year", scopes: ["docs:read"], expiresAt: now + 365 * 86_400_000 });
    expect(year.status).toBe(201);
  });

  // Requested permissions are de-duplicated server-side, keeping the first occurrence of each.
  test("a repeated permission is stored once", async ({ actor }) => {
    test.setTimeout(90_000);
    const owner = await actor("keys-dup", { organizations: ["Keys Dup"] });
    const [organization] = owner.organizations;
    const created = await api<{ credential: { scopes: string[] } }>(owner.page, "/api/rendro/credentials", { organizationId: organization.id, name: "Dup", scopes: ["docs:read", "docs:read"] });
    expect(created.status).toBe(201);
    expect(created.body.credential.scopes).toEqual(["docs:read"]);
    expect((await listKeys(owner.page, organization.id)).map(key => key.scopes)).toEqual([["docs:read"]]);
  });
});
