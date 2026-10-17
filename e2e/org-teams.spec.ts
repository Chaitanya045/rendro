import type { Page } from "@playwright/test";
import { test, expect, join, openSection, roles, toasts, confirmDialog, fullOrganization, choose, failOnce, delayedSnapshot } from "./org-fixtures";
import { holdRequest, authRecord } from "./auth-helpers";
import { api, holdFirst, settleFrames } from "./shell-helpers";

const card = (page: Page, team: string) => page.locator(".team-card", { has: page.getByRole("heading", { name: team, exact: true }) });
const teamsOf = async (page: Page, organizationId: string) => (await fullOrganization(page, organizationId)).body.teams.map(team => team.name).sort();
const rosterOf = async (page: Page, organizationId: string, teamId: string) =>
  (await api<{ members: Array<{ userId: string }>; nextCursor: string | null }>(page, `/api/rendro/management/team-members?organizationId=${organizationId}&teamId=${teamId}`)).body;

test.describe("teams", () => {
  test("a team is created, staffed, inspected and removed; membership never changes organization access", async ({ actor }) => {
    test.setTimeout(180_000);
    const owner = await actor("teams-owner", { organizations: ["Teams Org"] });
    const member = await actor("teams-member");
    const [organization] = owner.organizations;
    await join(owner, organization.id, member, "member");
    const { page } = owner;
    const baseline = await roles(page, organization.id);
    await openSection(page, organization.id, "teams");

    // A new organization already has its default team, with the creator on it.
    await expect(page.locator(".team-card h2")).toHaveText(["Teams Org"]);
    const dialog = page.locator("#team-dialog");
    const trigger = page.locator("#organization-page-action");
    const name = dialog.getByLabel("Team name", { exact: true });
    const submit = dialog.getByRole("button", { name: "Create team", exact: true });
    await expect(trigger).toHaveText("Create team");

    // Dialog: focus lands on the name, Cancel returns it; validation precedes any request; failure keeps the name.
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(name).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    const create = await holdRequest(page, "/api/auth/organization/create-team");
    try {
      await trigger.click();
      await submit.click();
      await expect(name).toBeFocused();
      expect(await name.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
      await settleFrames(page);
      expect(create.count()).toBe(0);
      await name.fill("  Docs  ");
      await submit.click();
      await expect(submit).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => create.count()).toBe(1);
      await name.press("Enter");
      await settleFrames(page);
      expect(create.count()).toBe(1);
      create.release(true);
      await expect(dialog.locator("#team-error")).toContainText("Service unavailable");
      await expect(submit).toBeEnabled();
      await expect(name).toHaveValue("  Docs  ");
      expect(await teamsOf(page, organization.id)).toEqual(["Teams Org"]);
    } finally {
      await create.close();
    }
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect(toasts(page).filter({ hasText: "Team created." })).toHaveCount(1);
    await expect(page.locator(".team-card h2")).toHaveText(["Teams Org", "Docs"]);
    expect(await teamsOf(page, organization.id)).toEqual(["Docs", "Teams Org"]);
    await expect(trigger).toBeFocused();
    // The dialog is reusable and starts clean.
    await trigger.click();
    await expect(name).toHaveValue("");
    await expect(dialog.locator("#team-error")).toBeEmpty();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    // Assignment: nothing selected, Add is off; a failed add keeps the selection; a successful one resets it.
    const docs = card(page, "Docs");
    const add = docs.getByRole("button", { name: "Add member", exact: true });
    const picker = docs.getByRole("combobox", { name: "Choose member" });
    await expect(add).toBeDisabled();
    await expect(picker).toHaveText("Choose member");
    await choose(page, "Choose member", member.name, docs);
    await expect(picker).toHaveText(member.name);
    await expect(add).toBeEnabled();
    const failing = await failOnce(page, "**/api/auth/organization/add-team-member", "Team service unavailable");
    await add.click();
    await expect(toasts(page).filter({ hasText: "Team service unavailable" })).toHaveClass(/error/);
    await expect(picker).toHaveText(member.name);
    await expect(add).toBeEnabled();
    await expect(add).not.toHaveAttribute("aria-busy", "true");
    await failing.close();

    // Open the roster first so the successful add must refresh it.
    const toggle = docs.getByRole("button", { name: "View members", exact: true });
    await toggle.click();
    await expect(docs.getByRole("button", { name: "Hide members", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(docs.locator(".team-roster")).toBeVisible();
    await expect(docs.locator(".team-roster")).toHaveText("No members in this team.");
    await add.click();
    await expect(toasts(page).filter({ hasText: "Member added to Docs." })).toHaveCount(1);
    await expect(picker).toHaveText("Choose member");
    await expect(add).toBeDisabled();
    await expect(docs.locator(".team-roster .overview-row strong")).toHaveText([member.name]);
    const docsTeam = (await fullOrganization(page, organization.id)).body.teams.find(team => team.name === "Docs")!;
    expect((await rosterOf(page, organization.id, docsTeam.id)).members).toHaveLength(1);
    // Already-listed members cannot be chosen again.
    await picker.click();
    await expect(page.getByRole("option", { name: member.name, exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("option", { name: owner.name, exact: true })).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    // Hide and show reuse the loaded roster.
    const rosterReads: string[] = [];
    page.on("request", request => { if (request.url().includes("/management/team-members")) rosterReads.push(request.url()); });
    await docs.getByRole("button", { name: "Hide members", exact: true }).click();
    await expect(docs.locator(".team-roster")).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(docs.locator(".team-roster .overview-row strong")).toHaveText([member.name]);
    expect(rosterReads).toEqual([]);

    // A team member is not elevated: the organization roles are exactly as before, and their page stays read-only.
    expect(await roles(page, organization.id)).toEqual(baseline);
    await openSection(member.page, organization.id, "teams");
    await expect(member.page.locator(".team-card h2")).toHaveText(["Teams Org", "Docs"]);
    await expect(member.page.locator(".team-card").first()).toContainText("Organization team");
    await expect(member.page.locator("#organization-page-action")).toBeHidden();
    await expect(member.page.locator("#team-dialog, .team-card select, .team-card button")).toHaveCount(0);
    expect(await api(member.page, "/api/auth/organization/create-team", { name: "Sneaky", organizationId: organization.id })).toMatchObject({ status: 403 });
    expect(await api(member.page, "/api/auth/organization/remove-team", { teamId: docsTeam.id, organizationId: organization.id })).toMatchObject({ status: 403 });
    expect(await api(member.page, "/api/auth/organization/add-team-member", { teamId: docsTeam.id, userId: "anyone", organizationId: organization.id })).toMatchObject({ status: 403 });
    expect((await api(member.page, `/api/rendro/management/team-members?organizationId=${organization.id}&teamId=${docsTeam.id}`)).status).toBe(403);
    expect(await teamsOf(page, organization.id)).toEqual(["Docs", "Teams Org"]);

    // Removing someone from the team asks first, refreshes the roster and leaves the organization roster alone.
    const confirm = confirmDialog(page);
    const removeFromTeam = docs.getByRole("button", { name: `Remove ${member.name} from Docs`, exact: true });
    await removeFromTeam.click();
    await expect(confirm.locator("#cp-confirm-title")).toHaveText("Remove from team?");
    await expect(confirm.locator("#cp-confirm-message")).toHaveText(`${member.name} will be removed from “Docs”. Organization access is unchanged.`);
    await confirm.locator("[data-confirm-cancel]").click();
    await expect(removeFromTeam).toBeFocused();
    expect((await rosterOf(page, organization.id, docsTeam.id)).members).toHaveLength(1);
    await removeFromTeam.click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "Team member removed." })).toHaveCount(1);
    await expect(docs.locator(".team-roster")).toHaveText("No members in this team.");
    expect((await rosterOf(page, organization.id, docsTeam.id)).members).toEqual([]);
    expect(await roles(page, organization.id)).toEqual(baseline);

    // Deleting a team: cancel keeps it, failure keeps it, success removes it; the sole remaining team offers no removal.
    const removeTeam = docs.getByRole("button", { name: "Remove team", exact: true });
    await removeTeam.click();
    await expect(confirm.locator("#cp-confirm-title")).toHaveText("Remove team?");
    await expect(confirm.locator("#cp-confirm-message")).toHaveText("“Docs” will be deleted. Organization members keep their access.");
    await confirm.locator("[data-confirm-cancel]").click();
    await expect(removeTeam).toBeFocused();
    expect(await teamsOf(page, organization.id)).toEqual(["Docs", "Teams Org"]);
    const failingRemoval = await failOnce(page, "**/api/auth/organization/remove-team", "Team removal unavailable");
    await removeTeam.click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "Team removal unavailable" })).toHaveClass(/error/);
    await expect(docs).toBeVisible();
    await expect(removeTeam).toBeEnabled();
    await expect(removeTeam).not.toHaveAttribute("aria-busy", "true");
    await failingRemoval.close();
    await removeTeam.click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "Team removed." })).toHaveCount(1);
    await expect(page.locator(".team-card h2")).toHaveText(["Teams Org"]);
    expect(await teamsOf(page, organization.id)).toEqual(["Teams Org"]);
    expect(await roles(page, organization.id)).toEqual(baseline);

    const lastTeam = card(page, "Teams Org");
    await expect(lastTeam.getByRole("button", { name: "Remove team", exact: true })).toBeDisabled();
    await expect(lastTeam.locator(".team-hint")).toBeVisible();
    expect(await teamsOf(page, organization.id)).toEqual(["Teams Org"]);
  });

  test("a roster larger than one page loads more, retries failures and ignores an outdated response", async ({ actor }) => {
    test.setTimeout(180_000);
    const owner = await actor("roster-owner", { organizations: ["Roster Org"] });
    const [organization] = owner.organizations;
    const { page } = owner;
    const created = await api<{ id: string }>(page, "/api/auth/organization/create-team", { name: "Everyone", organizationId: organization.id });
    expect(created.status).toBe(200);
    const teamId = created.body.id;
    // Fifty-two real organization members are written straight to the disposable auth store (signing up fifty-two
    // users would dominate the run); the page reads them through the same management APIs as any roster.
    const total = 52;
    const now = Date.now();
    const make = async (index: number) => {
      const label = `Bulk ${String(index).padStart(2, "0")}`;
      const user = await authRecord<{ _id: string }>("create", { input: { model: "user", data: { name: label, email: `bulk-${index}-${now}@example.test`, emailVerified: true, createdAt: now, updatedAt: now } } });
      await authRecord("create", { input: { model: "member", data: { organizationId: organization.id, userId: user._id, role: "member", createdAt: now } } });
      await authRecord("create", { input: { model: "teamMember", data: { teamId, userId: user._id, createdAt: now } } });
      return label;
    };
    const labels: string[] = [];
    for (let start = 1; start <= total; start += 8) {
      labels.push(...await Promise.all(Array.from({ length: Math.min(8, total - start + 1) }, (_, offset) => make(start + offset))));
    }
    expect(await rosterOf(page, organization.id, teamId)).toMatchObject({ members: expect.any(Array), nextCursor: expect.any(String) });
    await openSection(page, organization.id, "teams");
    const everyone = card(page, "Everyone");
    const rows = everyone.locator(".team-roster .overview-row");

    // First page of fifty with a Load more control; a failed second page is reported and recoverable.
    const firstRead = await holdFirst(page, "**/api/rendro/management/team-members?*");
    await everyone.getByRole("button", { name: "View members", exact: true }).click();
    await expect.poll(() => firstRead.held()).toBe(1);
    await expect(everyone.locator(".team-roster [role=status]")).toHaveText("Loading members…");
    await expect(everyone.getByRole("button", { name: "Hide members", exact: true })).toHaveAttribute("aria-expanded", "true");
    await firstRead.close();
    await expect(rows).toHaveCount(50);
    const more = everyone.getByRole("button", { name: "Load more members", exact: true });
    await expect(more).toBeVisible();
    const failing = await failOnce(page, /\/management\/team-members\?.*cursor=/, "Roster page unavailable");
    await more.click();
    await expect(everyone.locator(".team-roster .message.error")).toHaveText("Unable to load team members.");
    await expect(rows).toHaveCount(0);
    await failing.close();
    await everyone.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(rows).toHaveCount(50);
    await more.click();
    await expect(rows).toHaveCount(total);
    await expect(more).toHaveCount(0);
    const names = await rows.locator("strong").allInnerTexts();
    expect(new Set(names).size).toBe(total);
    expect([...names].sort()).toEqual([...labels].sort());
    // Everyone loaded is unavailable in the picker.
    expect(await everyone.locator("select").evaluate((select: HTMLSelectElement) => Array.from(select.options).filter(option => option.disabled).length)).toBe(total);
    const roster = await rosterOf(page, organization.id, teamId);
    expect(roster.members).toHaveLength(50);
    expect(roster.nextCursor).not.toBeNull();

    // An outdated page response is fenced out: the second page is answered immediately but delivered late, after an
    // assignment has already refreshed the roster from its first page.
    await page.reload();
    await expect(page.locator("#team-grid .team-card")).toHaveCount(2);
    const reopened = card(page, "Everyone");
    const reopenedRows = reopened.locator(".team-roster .overview-row");
    await reopened.getByRole("button", { name: "View members", exact: true }).click();
    await expect(reopenedRows).toHaveCount(50);
    const outdated = await delayedSnapshot(page, /\/management\/team-members\?.*cursor=/);
    await reopened.getByRole("button", { name: "Load more members", exact: true }).click();
    await expect.poll(() => outdated.held()).toBe(1);
    await choose(page, "Choose member", owner.name, reopened);
    await reopened.getByRole("button", { name: "Add member", exact: true }).click();
    await expect(toasts(page).filter({ hasText: "Member added to Everyone." })).toHaveCount(1);
    await expect(reopened.getByRole("button", { name: "Load more members", exact: true })).toBeEnabled();
    await expect(reopenedRows).toHaveCount(50);
    outdated.release();
    await settleFrames(page);
    await expect(reopenedRows).toHaveCount(50);
    await outdated.close();
    expect((await rosterOf(page, organization.id, teamId)).members).toHaveLength(50);
    await reopened.getByRole("button", { name: "Load more members", exact: true }).click();
    await expect(reopenedRows).toHaveCount(total + 1);
    expect(new Set(await reopenedRows.locator("strong").allInnerTexts()).size).toBe(total + 1);
  });

  test("a roster refresh after an assignment is not answered by an older read still in flight", async ({ actor }) => {
    test.setTimeout(120_000);
    const owner = await actor("stale-owner", { organizations: ["Stale Org"] });
    const mate = await actor("stale-mate");
    const [organization] = owner.organizations;
    await join(owner, organization.id, mate, "member");
    const { page } = owner;
    await openSection(page, organization.id, "teams");
    const team = card(page, "Stale Org");
    const older = await delayedSnapshot(page, /\/management\/team-members\?/);
    await team.getByRole("button", { name: "View members", exact: true }).click();
    await expect.poll(() => older.held()).toBe(1);
    await choose(page, "Choose member", mate.name, team);
    await team.getByRole("button", { name: "Add member", exact: true }).click();
    await expect(toasts(page).filter({ hasText: "Member added to Stale Org." })).toHaveCount(1);
    older.release();
    await expect(team.locator(".team-roster .overview-row strong")).toHaveText([owner.name, mate.name], { timeout: 5000 });
    await older.close();
  });

  test("a team cannot be created with a blank name", async ({ actor }) => {
    const owner = await actor("blank-owner", { organizations: ["Blank Org"] });
    const [organization] = owner.organizations;
    const { page } = owner;
    await openSection(page, organization.id, "teams");
    await page.locator("#organization-page-action").click();
    const dialog = page.locator("#team-dialog");
    const name = dialog.getByLabel("Team name", { exact: true });
    await name.fill("   ");
    await dialog.getByRole("button", { name: "Create team", exact: true }).click();
    // The error is announced, tied to the field, and focus stays in it; nothing is sent.
    await expect(dialog.locator("#team-error")).toHaveText("Enter a team name.");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAccessibleDescription("Enter a team name.");
    await expect(name).toBeFocused();
    await expect(dialog).toBeVisible();
    expect(await teamsOf(page, organization.id)).toEqual(["Blank Org"]);
    // The API refuses a blank name as well, for creation and for renaming, and stores trimmed names.
    const blank = await api<{ message?: string }>(page, "/api/auth/organization/create-team", { organizationId: organization.id, name: "  \t " });
    expect(blank.status).toBe(400);
    expect(blank.body.message).toBe("Team name is required.");
    const padded = await api<{ id: string; name: string }>(page, "/api/auth/organization/create-team", { organizationId: organization.id, name: "  Padded  " });
    expect(padded.status).toBe(200);
    expect(padded.body.name).toBe("Padded");
    const rename = await api<{ message?: string }>(page, "/api/auth/organization/update-team", { teamId: padded.body.id, data: { organizationId: organization.id, name: " " } });
    expect(rename.status).toBe(400);
    expect(await teamsOf(page, organization.id)).toEqual(["Blank Org", "Padded"]);
  });

  test("the only remaining team cannot be removed; the control explains why and follows the team count", async ({ actor }) => {
    const owner = await actor("last-owner", { organizations: ["Last Org"] });
    const admin = await actor("last-admin");
    const [organization] = owner.organizations;
    await join(owner, organization.id, admin, "admin");
    const { page } = owner;
    await openSection(page, organization.id, "teams");
    const only = card(page, "Last Org");
    const remove = only.getByRole("button", { name: "Remove team", exact: true });
    await expect(remove).toBeDisabled();
    await expect(remove).toHaveAccessibleDescription(/at least one team/);
    await expect(only.locator(".team-hint")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No teams yet" })).toHaveCount(0);
    // The server rule holds without the UI: an admin (whose session has no active team) is refused too.
    const [team] = (await fullOrganization(page, organization.id)).body.teams;
    const refused = await api<{ message?: string }>(admin.page, "/api/auth/organization/remove-team", { teamId: team.id, organizationId: organization.id });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("Unable to remove last team");
    expect(await teamsOf(page, organization.id)).toEqual(["Last Org"]);

    // A second team unlocks that team only: the owner's session keeps the first one active. Removing it locks the survivor on the count again.
    const created = await api(page, "/api/auth/organization/create-team", { organizationId: organization.id, name: "Second" });
    expect(created.status).toBe(200);
    await page.reload();
    const second = card(page, "Second");
    await expect(second.getByRole("button", { name: "Remove team", exact: true })).toBeEnabled();
    await expect(remove).toBeDisabled();
    await expect(remove).toHaveAccessibleDescription(/active team/);
    await expect(page.locator(".team-hint")).toHaveCount(1);
    await second.getByRole("button", { name: "Remove team", exact: true }).click();
    await confirmDialog(page).locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "Team removed." })).toHaveCount(1);
    await expect(second).toHaveCount(0);
    await expect(remove).toBeDisabled();
    await expect(remove).toHaveAccessibleDescription(/at least one team/);
    await expect(only.locator(".team-hint")).toBeVisible();
    expect(await teamsOf(page, organization.id)).toEqual(["Last Org"]);
  });

  test("the team a session has active cannot be removed; the control explains why, follows the active team and the server still refuses", async ({ actor }) => {
    test.setTimeout(120_000);
    const owner = await actor("active-owner", { organizations: ["Active Org"] });
    const [organization] = owner.organizations;
    const { page } = owner;
    const created = await api<{ id: string }>(page, "/api/auth/organization/create-team", { organizationId: organization.id, name: "Docs" });
    expect(created.status).toBe(200);
    const [first] = (await fullOrganization(page, organization.id)).body.teams.filter(team => team.name === "Active Org");
    const removeOf = (name: string) => card(page, name).getByRole("button", { name: "Remove team", exact: true });
    const session = async () => (await api<{ session: { activeTeamId: string | null } }>(page, "/api/auth/get-session?disableCookieCache=true")).body.session.activeTeamId;

    // The creator's session has the organization's first team active: it is not offered for removal, the other team is.
    expect(await session()).toBe(first.id);
    await openSection(page, organization.id, "teams");
    await expect(removeOf("Active Org")).toBeDisabled();
    await expect(removeOf("Active Org")).toHaveAccessibleDescription("This is your active team, so it can’t be removed.");
    await expect(card(page, "Active Org").locator(".team-hint")).toBeVisible();
    await expect(removeOf("Docs")).toBeEnabled();
    await expect(card(page, "Docs").locator(".team-hint")).toHaveCount(0);

    // The rule is the server's: without the UI the same session is refused and nothing is deleted.
    const refused = await api<{ message?: string }>(page, "/api/auth/organization/remove-team", { teamId: first.id, organizationId: organization.id });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/not allowed to delete this team/i);
    expect(await teamsOf(page, organization.id)).toEqual(["Active Org", "Docs"]);

    // A session can only activate a team it belongs to; once it does, the restriction moves with it.
    const me = (await api<{ user: { id: string } }>(page, "/api/auth/get-session?disableCookieCache=true")).body.user.id;
    expect((await api(page, "/api/auth/organization/add-team-member", { teamId: created.body.id, userId: me, organizationId: organization.id })).status).toBe(200);
    const switched = await api(page, "/api/auth/organization/set-active-team", { teamId: created.body.id });
    expect(switched.status).toBe(200);
    expect(await session()).toBe(created.body.id);
    await page.reload();
    await expect(card(page, "Docs")).toBeVisible();
    await expect(removeOf("Docs")).toBeDisabled();
    await expect(removeOf("Docs")).toHaveAccessibleDescription(/active team/);
    await expect(removeOf("Active Org")).toBeEnabled();
    await expect(card(page, "Active Org").locator(".team-hint")).toHaveCount(0);
    const stillRefused = await api<{ message?: string }>(page, "/api/auth/organization/remove-team", { teamId: created.body.id, organizationId: organization.id });
    expect(stillRefused.status).toBe(403);

    // The now-inactive team is removed through the page; the survivor is both active and the last team.
    await removeOf("Active Org").click();
    await confirmDialog(page).locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "Team removed." })).toHaveCount(1);
    await expect(card(page, "Active Org")).toHaveCount(0);
    await expect(removeOf("Docs")).toBeDisabled();
    await expect(removeOf("Docs")).toHaveAccessibleDescription(/at least one team/);
    expect(await teamsOf(page, organization.id)).toEqual(["Docs"]);
  });
});
