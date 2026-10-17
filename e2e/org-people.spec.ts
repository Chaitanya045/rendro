import { randomBytes } from "node:crypto";
import { test, expect, join, openSection, roles, invitations, toasts, confirmDialog, fullOrganization, organizationList, choose, optionsOf, failOnce } from "./org-fixtures";
import { authRecord, holdRequest, mailFor } from "./auth-helpers";
import { api, holdFirst } from "./shell-helpers";

const fresh = (label: string) => `${label}-${randomBytes(3).toString("hex")}@example.test`;
const subjectOf = (organization: string) => `Join ${organization} on Rendro`;

test.describe("people and invitations", () => {
  test("an owner invites a batch: row limits, validation, partial failure and retry, mail, pending list and revocation", async ({ actor }) => {
    test.setTimeout(120_000);
    const owner = await actor("inviter", { organizations: ["People Org"] });
    const mate = await actor("mate");
    const [organization] = owner.organizations;
    await join(owner, organization.id, mate, "member");
    const { page } = owner;
    const joinMail = async (email: string) => (await mailFor(email)).filter(mail => mail.subject === subjectOf("People Org")).length;
    const mateMail = await joinMail(mate.email);
    const [one, two, three] = [fresh("one"), fresh("two"), fresh("three")];
    // The invitation list fails on its own: the roster is already usable, and Try again loads both.
    const listFailure = await failOnce(page, "**/api/auth/organization/list-invitations*", "Invitation list unavailable");
    await openSection(page, organization.id, "people");
    await expect(page.locator("#invitation-list")).toContainText("Invitations could not be loaded.");
    await expect(page.locator("#member-list tr")).toHaveCount(2);
    const retryRead = await holdFirst(page, "**/api/auth/organization/list-invitations*");
    await page.locator("#invitation-list").getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => retryRead.held()).toBe(1);
    await expect(page.locator("#invitation-list").getByRole("status", { name: "Loading invitations" })).toBeVisible();
    await retryRead.close();
    await expect(page.locator("#invitation-list")).toHaveText("No pending invitations.");
    await listFailure.close();

    // Roster rows: name, email, You badge, status and join date.
    await expect(page.locator("#member-list tr")).toHaveCount(2);
    await expect(page.locator("#member-count")).toHaveText("2 people currently have organization access.");
    const ownerRow = page.locator("#member-list tr", { hasText: owner.email });
    await expect(ownerRow.locator(".badge.accent")).toHaveText("You");
    await expect(ownerRow.locator(".person-name strong")).toHaveText(owner.name);
    await expect(ownerRow.locator(".cell-secondary")).toHaveText(owner.email);
    await expect(ownerRow.locator("td[data-label=Status] .badge")).toHaveText("Active");
    await expect(ownerRow.locator("td[data-label=Joined]")).toHaveText(/\d/);

    const trigger = page.locator("#organization-page-action");
    const dialog = page.locator("#invite-dialog");
    const rows = dialog.locator(".invite-entry");
    const add = dialog.getByRole("button", { name: "Add another person", exact: true });
    const send = dialog.getByRole("button", { name: "Send invitations", exact: true });
    await expect(trigger).toHaveText("Invite people");
    await trigger.click();
    await expect(dialog).toBeVisible();

    // One to ten rows: the last row cannot be removed and an eleventh cannot be added.
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByRole("button", { name: "Remove invitation row" })).toBeDisabled();
    for (let index = 0; index < 9; index++) await add.click();
    await expect(rows).toHaveCount(10);
    await expect(add).toBeDisabled();
    await rows.first().getByRole("button", { name: "Remove invitation row" }).click();
    await expect(rows).toHaveCount(9);
    await expect(add).toBeEnabled();
    while (await rows.count() > 3) await rows.last().getByRole("button", { name: "Remove invitation row" }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.first().getByRole("button", { name: "Remove invitation row" })).toBeEnabled();

    // Native email validation blocks the submission and focuses the offending field.
    const invite = await holdRequest(page, "/api/auth/organization/invite-member");
    try {
      await rows.nth(0).getByLabel("Work email").fill("not-an-email");
      await send.click();
      await expect(rows.nth(0).getByLabel("Work email")).toBeFocused();
      expect(await rows.nth(0).getByLabel("Work email").evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(true);
      expect(invite.count()).toBe(0);
    } finally {
      await invite.close();
    }

    // Sequential batch: two succeed, an existing member is rejected; only the failed row stays, marked and explained.
    await rows.nth(0).getByLabel("Work email").fill(one);
    await rows.nth(1).getByLabel("Work email").fill(mate.email);
    await rows.nth(2).getByLabel("Work email").fill(two);
    const emailRow = (index: number) => rows.nth(index);
    await choose(page, "Role", "Admin", rows.nth(2));
    await send.click();
    await expect(toasts(page)).toHaveText(["2 invitations sent; retry the highlighted rows."]);
    await expect(rows).toHaveCount(1);
    await expect(emailRow(0).getByLabel("Work email")).toHaveValue(mate.email);
    await expect(emailRow(0).getByLabel("Work email")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator("#invite-error")).toHaveText(`${mate.email}: User is already a member of this organization`);
    await expect(dialog.locator("#invite-error")).toHaveAttribute("role", "alert");
    await expect(send).toBeEnabled();
    await expect(send).not.toHaveAttribute("aria-busy", "true");
    await expect(dialog).toBeVisible();
    // Server state and mail after the partial failure.
    expect((await invitations(page, organization.id)).body.filter(invitation => invitation.status === "pending").map(invitation => invitation.email).sort()).toEqual([one, two].sort());
    for (const email of [one, two]) expect(await joinMail(email)).toBe(1);
    expect(await joinMail(mate.email)).toBe(mateMail);

    // Retry with a corrected address sends only that row, closes the dialog and refreshes the list.
    await emailRow(0).getByLabel("Work email").fill(three);
    await send.click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(toasts(page).filter({ hasText: "Invitation sent." })).toHaveCount(1);
    const pending = page.locator("#invitation-list tr");
    await expect(pending).toHaveCount(3);
    for (const email of [one, two, three]) await expect(pending.filter({ hasText: email })).toHaveCount(1);
    await expect(pending.filter({ hasText: two }).locator(".badge").first()).toHaveText("Admin");
    await expect(pending.filter({ hasText: one }).locator(".badge").first()).toHaveText("Member");
    for (const email of [one, two, three]) expect(await joinMail(email)).toBe(1);
    const listed = (await invitations(page, organization.id)).body;
    expect(listed.filter(invitation => invitation.status === "pending").map(invitation => invitation.email).sort()).toEqual([one, two, three].sort());
    expect(listed.find(invitation => invitation.email === two)?.role).toBe("admin");

    // Revocation: cancel keeps the row and focus; failure keeps it and restores the control; success removes it.
    const revoke = (email: string) => pending.filter({ hasText: email }).getByRole("button", { name: `Revoke invitation for ${email}` });
    const confirm = confirmDialog(page);
    await revoke(two).click();
    await expect(confirm.locator("#cp-confirm-title")).toHaveText("Revoke invitation?");
    await expect(confirm.locator("#cp-confirm-message")).toHaveText(`The invitation for ${two} will stop working immediately.`);
    await expect(confirm.locator("[data-confirm-cancel]")).toBeFocused();
    await confirm.locator("[data-confirm-cancel]").click();
    await expect(confirm).toBeHidden();
    await expect(revoke(two)).toBeFocused();
    await expect(pending).toHaveCount(3);
    const failing = await failOnce(page, "**/api/auth/organization/cancel-invitation", "Invitation service unavailable");
    await revoke(two).click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "Invitation service unavailable" })).toHaveCount(1);
    await expect(toasts(page).filter({ hasText: "Invitation service unavailable" })).toHaveClass(/error/);
    await expect(revoke(two)).toBeEnabled();
    await expect(revoke(two)).not.toHaveAttribute("aria-busy", "true");
    await expect(pending).toHaveCount(3);
    expect((await invitations(page, organization.id)).body.find(invitation => invitation.email === two)?.status).toBe("pending");
    await failing.close();
    for (const email of [two, one, three]) {
      await revoke(email).click();
      await confirm.locator("[data-confirm-accept]").click();
      await expect(pending.filter({ hasText: email })).toHaveCount(0);
    }
    await expect(page.locator("#invitation-list")).toHaveText("No pending invitations.");
    expect((await invitations(page, organization.id)).body.filter(invitation => invitation.status === "pending")).toEqual([]);
    expect((await invitations(page, organization.id)).body.filter(invitation => invitation.status === "canceled").map(invitation => invitation.email).sort()).toEqual([one, two, three].sort());
  });

  test("roles: an admin is limited, the owner assigns and is bound by the last-owner rule, failures revert and self-demotion drops privileges", async ({ actor }) => {
    test.setTimeout(150_000);
    const owner = await actor("roles-owner", { organizations: ["Roles Org"] });
    const admin = await actor("roles-admin");
    const member = await actor("roles-member");
    const [organization] = owner.organizations;
    await join(owner, organization.id, admin, "admin");
    await join(owner, organization.id, member, "member");
    const row = (page: typeof owner.page, email: string) => page.locator("#member-list tr", { hasText: email });
    const roleSelect = (email: string) => `Change role for ${email}`;
    const trigger = (page: typeof owner.page) => page.locator("#organization-page-action");
    const members = await fullOrganization(owner.page, organization.id);
    const memberIds = Object.fromEntries(members.body.members.map(entry => [entry.user.email, entry.id]));

    // An admin sees the invitation tools but cannot touch owners or grant ownership.
    await openSection(admin.page, organization.id, "people");
    await expect(trigger(admin.page)).toBeVisible();
    await expect(admin.page.locator(".pending-panel")).toBeVisible();
    await expect(row(admin.page, owner.email).getByRole("combobox")).toHaveCount(0);
    await expect(row(admin.page, owner.email).locator("td[data-label=Role] .badge")).toHaveText("Owner");
    await expect(row(admin.page, owner.email).locator("button.remove-member")).toHaveCount(0);
    await expect(row(admin.page, admin.email).locator("button.remove-member")).toHaveCount(0);
    expect(await optionsOf(admin.page, roleSelect(member.email))).toEqual([{ text: "Member", disabled: false }, { text: "Admin", disabled: false }]);
    expect(await optionsOf(admin.page, roleSelect(admin.email))).toEqual([{ text: "Member", disabled: false }, { text: "Admin", disabled: false }]);
    await expect(row(admin.page, member.email).locator("button.remove-member")).toBeVisible();
    for (const [label, request] of [
      ["grant ownership", ["/api/auth/organization/update-member-role", { memberId: memberIds[member.email], role: "owner", organizationId: organization.id }]],
      ["demote the owner", ["/api/auth/organization/update-member-role", { memberId: memberIds[owner.email], role: "member", organizationId: organization.id }]],
      ["remove the owner", ["/api/auth/organization/remove-member", { memberIdOrEmail: memberIds[owner.email], organizationId: organization.id }]],
      ["delete the organization", ["/api/auth/organization/delete", { organizationId: organization.id }]],
    ] as const) {
      const denied = await api<{ code?: string }>(admin.page, request[0], request[1]);
      expect([400, 401, 403], label).toContain(denied.status);
    }
    expect(await roles(owner.page, organization.id)).toEqual({ [owner.email]: "owner", [admin.email]: "admin", [member.email]: "member" });

    // The sole owner cannot be demoted or leave; their own role options reflect it. An ordinary member has no controls.
    await openSection(owner.page, organization.id, "people");
    await openSection(member.page, organization.id, "people");
    await expect(trigger(member.page)).toBeHidden();
    await expect(member.page.locator(".pending-panel")).toHaveCount(0);
    await expect(member.page.locator("#member-list select, #member-list button.remove-member")).toHaveCount(0);
    await expect(row(member.page, member.email).locator(".badge.accent")).toHaveText("You");
    expect(await optionsOf(owner.page, roleSelect(owner.email))).toEqual([{ text: "Member", disabled: true }, { text: "Admin", disabled: true }, { text: "Owner", disabled: false }]);
    await expect(row(owner.page, owner.email).locator("button.remove-member")).toHaveCount(0);
    expect(await optionsOf(owner.page, roleSelect(member.email))).toEqual([{ text: "Member", disabled: false }, { text: "Admin", disabled: false }, { text: "Owner", disabled: false }]);
    expect(await api(owner.page, "/api/auth/organization/update-member-role", { memberId: memberIds[owner.email], role: "admin", organizationId: organization.id }))
      .toMatchObject({ status: 400, body: { code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER" } });
    expect(await api(owner.page, "/api/auth/organization/leave", { organizationId: organization.id }))
      .toMatchObject({ status: 400, body: { code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER" } });

    // A rejected change reverts the selection and keeps the server role; the next attempt succeeds and is announced.
    const memberSelect = row(owner.page, member.email).getByRole("combobox", { name: roleSelect(member.email) });
    const rejecting = await failOnce(owner.page, "**/api/auth/organization/update-member-role", "Role service unavailable");
    await choose(owner.page, roleSelect(member.email), "Admin");
    await expect(toasts(owner.page).filter({ hasText: "Role service unavailable" })).toHaveClass(/error/);
    await expect(memberSelect).toHaveText("Member");
    await expect(memberSelect).toBeEnabled();
    expect((await roles(owner.page, organization.id))[member.email]).toBe("member");
    await rejecting.close();
    const pendingRole = await holdRequest(owner.page, "/api/auth/organization/update-member-role");
    try {
      await choose(owner.page, roleSelect(member.email), "Admin");
      await expect.poll(() => pendingRole.count()).toBe(1);
      await expect(memberSelect).toBeDisabled();
      pendingRole.release();
      await expect(toasts(owner.page).filter({ hasText: "Member role updated." })).toHaveCount(1);
    } finally {
      await pendingRole.close();
    }
    await expect(memberSelect).toBeEnabled();
    await expect(memberSelect).toHaveText("Admin");
    expect((await roles(owner.page, organization.id))[member.email]).toBe("admin");
    // The promoted person gains the management tools on their next load.
    await openSection(member.page, organization.id, "people");
    await expect(trigger(member.page)).toBeVisible();
    await expect(member.page.locator(".pending-panel")).toBeVisible();

    // A second owner lifts the last-owner constraint; the original owner can then demote themselves and loses every privilege.
    // Toasts last 4.2s and the reload above can outlast the first one, so count only the new confirmation.
    await expect(toasts(owner.page).filter({ hasText: "Member role updated." })).toHaveCount(0);
    await choose(owner.page, roleSelect(admin.email), "Owner");
    await expect(toasts(owner.page).filter({ hasText: "Member role updated." })).toHaveCount(1);
    expect(await roles(owner.page, organization.id)).toEqual({ [owner.email]: "owner", [admin.email]: "owner", [member.email]: "admin" });
    expect(await optionsOf(owner.page, roleSelect(owner.email))).toEqual([{ text: "Member", disabled: false }, { text: "Admin", disabled: false }, { text: "Owner", disabled: false }]);
    await choose(owner.page, roleSelect(owner.email), "Member");
    await expect(row(owner.page, owner.email).getByRole("combobox")).toHaveCount(0);
    await expect(row(owner.page, owner.email).locator("td[data-label=Role] .badge")).toHaveText("Member");
    await expect(trigger(owner.page)).toBeHidden();
    await expect(owner.page.locator(".pending-panel")).toHaveCount(0);
    await expect(owner.page.locator("#invite-dialog")).toHaveCount(0);
    await expect(owner.page.locator("#member-list select, #member-list button.remove-member")).toHaveCount(0);
    expect((await roles(owner.page, organization.id))[owner.email]).toBe("member");
    expect(await api(owner.page, "/api/auth/organization/invite-member", { organizationId: organization.id, email: fresh("late"), role: "member" })).toMatchObject({ status: 403 });
    expect(await api(owner.page, "/api/auth/organization/update", { organizationId: organization.id, data: { name: "Hijack" } })).toMatchObject({ status: 403 });

    // Leaving: an ordinary member can leave; the only remaining owner cannot. There is no leave control in the UI.
    await expect(owner.page.getByRole("button", { name: /leave/i })).toHaveCount(0);
    expect(await api(owner.page, "/api/auth/organization/leave", { organizationId: organization.id })).toMatchObject({ status: 200 });
    expect(await organizationList(owner.page)).toEqual([]);
    expect((await api(owner.page, `/api/rendro/management/access?organizationId=${organization.id}`)).status).toBe(403);
    await openSection(admin.page, organization.id, "people");
    await expect(admin.page.locator("#member-count")).toHaveText("2 people currently have organization access.");
    expect(await roles(admin.page, organization.id)).toEqual({ [admin.email]: "owner", [member.email]: "admin" });
    expect(await api(admin.page, "/api/auth/organization/leave", { organizationId: organization.id }))
      .toMatchObject({ status: 400, body: { code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER" } });
  });

  test("removing a member: confirmation, failure and retry, the removed person's lost access and a revoked admin's rejected action", async ({ actor }) => {
    test.setTimeout(150_000);
    const owner = await actor("remove-owner", { organizations: ["Removal Org"] });
    const admin = await actor("remove-admin");
    const member = await actor("remove-member");
    const [organization] = owner.organizations;
    await join(owner, organization.id, admin, "admin");
    await join(owner, organization.id, member, "member");
    const row = (email: string) => owner.page.locator("#member-list tr", { hasText: email });
    const ids = Object.fromEntries((await fullOrganization(owner.page, organization.id)).body.members.map(entry => [entry.user.email, { member: entry.id, user: entry.userId }]));
    // The member belongs to a team; leaving the organization must take that membership with it.
    const team = await api<{ id: string }>(owner.page, "/api/auth/organization/create-team", { name: "Docs", organizationId: organization.id });
    expect((await api(owner.page, "/api/auth/organization/add-team-member", { teamId: team.body.id, userId: ids[member.email].user, organizationId: organization.id })).status).toBe(200);
    const roster = async () => (await api<{ members: Array<{ userId: string }> }>(owner.page, `/api/rendro/management/team-members?organizationId=${organization.id}&teamId=${team.body.id}`)).body.members.map(entry => entry.userId);
    expect(await roster()).toEqual([ids[member.email].user]);

    // A revoked admin's open page: the next action is rejected by the server and the control reverts.
    await openSection(admin.page, organization.id, "people");
    await openSection(member.page, organization.id, "");
    expect(await api(owner.page, "/api/auth/organization/remove-member", { memberIdOrEmail: ids[admin.email].member, organizationId: organization.id })).toMatchObject({ status: 200 });
    const staleSelect = admin.page.locator("#member-list tr", { hasText: member.email }).getByRole("combobox", { name: `Change role for ${member.email}` });
    await choose(admin.page, `Change role for ${member.email}`, "Admin");
    await expect(admin.page.locator("#cp-toasts .toast.error")).toHaveCount(1);
    await expect(staleSelect).toHaveText("Member");
    await expect(staleSelect).toBeEnabled();
    expect(await roles(owner.page, organization.id)).toEqual({ [owner.email]: "owner", [member.email]: "member" });
    await admin.page.reload();
    await expect(admin.page.getByText("Page not found")).toBeVisible();
    expect(await organizationList(admin.page)).toEqual([]);

    // Owner removes the member through the confirmation: cancel, failure, then success.
    await openSection(owner.page, organization.id, "people");
    await expect(owner.page.locator("#member-count")).toHaveText("2 people currently have organization access.");
    const remove = row(member.email).getByRole("button", { name: `Remove ${member.name} from organization` });
    const confirm = confirmDialog(owner.page);
    await remove.click();
    await expect(confirm.locator("#cp-confirm-title")).toHaveText("Remove member?");
    await expect(confirm.locator("#cp-confirm-message")).toHaveText(`${member.name} will lose access to this organization’s projects and teams.`);
    await expect(confirm.locator("[data-confirm-accept]")).toHaveText("Remove member");
    await expect(confirm.locator("[data-confirm-cancel]")).toBeFocused();
    await owner.page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(remove).toBeFocused();
    await expect(row(member.email)).toHaveCount(1);
    expect(await roles(owner.page, organization.id)).toHaveProperty([member.email], "member");

    const failing = await failOnce(owner.page, "**/api/auth/organization/remove-member", "Membership service unavailable");
    await remove.click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(toasts(owner.page).filter({ hasText: "Membership service unavailable" })).toHaveClass(/error/);
    await expect(row(member.email)).toHaveCount(1);
    await expect(remove).toBeEnabled();
    await expect(remove).not.toHaveAttribute("aria-busy", "true");
    expect(await roles(owner.page, organization.id)).toHaveProperty([member.email], "member");
    await failing.close();

    const pendingRemoval = await holdRequest(owner.page, "/api/auth/organization/remove-member");
    try {
      await remove.click();
      await confirm.locator("[data-confirm-accept]").click();
      await expect.poll(() => pendingRemoval.count()).toBe(1);
      await expect(remove).toHaveAttribute("aria-busy", "true");
      await expect(remove).toBeDisabled();
      await expect(row(member.email)).toHaveCount(1);
      pendingRemoval.release();
      await expect(toasts(owner.page).filter({ hasText: "Organization member removed." })).toHaveCount(1);
    } finally {
      await pendingRemoval.close();
    }
    await expect(row(member.email)).toHaveCount(0);
    await expect(owner.page.locator("#member-count")).toHaveText("1 person currently has organization access.");
    expect(await roles(owner.page, organization.id)).toEqual({ [owner.email]: "owner" });
    expect(await roster()).toEqual([]);

    // The removed person observes the loss everywhere: API, organization list and a reload of the page they had open.
    expect((await api(member.page, `/api/rendro/management/access?organizationId=${organization.id}`)).status).toBe(403);
    expect((await fullOrganization(member.page, organization.id)).status).toBeGreaterThanOrEqual(400);
    expect(await organizationList(member.page)).toEqual([]);
    await member.page.goto(`/organizations/${organization.id}`);
    await expect(member.page.getByText("Page not found")).toBeVisible();
    await member.page.getByRole("link", { name: "Manage organizations", exact: true }).click();
    await expect(member.page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
  });

  test("an expired invitation is labelled Expired, stays revocable and is not counted as pending", async ({ actor }) => {
    const owner = await actor("expiry-owner", { organizations: ["Expiry Org"] });
    const [organization] = owner.organizations;
    const email = fresh("expired");
    const other = fresh("current");
    const invitation = await api<{ id: string }>(owner.page, "/api/auth/organization/invite-member", { organizationId: organization.id, email, role: "member" });
    expect(invitation.status).toBe(200);
    expect((await api(owner.page, "/api/auth/organization/invite-member", { organizationId: organization.id, email: other, role: "member" })).status).toBe(200);
    await authRecord("updateOne", { input: { model: "invitation", where: [{ field: "_id", value: invitation.body.id }], update: { expiresAt: Date.now() - 1000 } } });
    await openSection(owner.page, organization.id, "people");
    const expired = owner.page.locator("#invitation-list tr", { hasText: email });
    const current = owner.page.locator("#invitation-list tr", { hasText: other });
    await expect(expired.locator("td[data-label=Status] .badge")).toHaveText("Expired");
    await expect(current.locator("td[data-label=Status] .badge")).toHaveText("Pending");
    await expect(expired.getByText("Pending", { exact: true })).toHaveCount(0);
    // An expired invitation is cleaned up like any other: confirm, revoke, gone.
    await expired.getByRole("button", { name: `Revoke invitation for ${email}` }).click();
    await confirmDialog(owner.page).locator("[data-confirm-accept]").click();
    await expect(toasts(owner.page).filter({ hasText: "Invitation revoked." })).toHaveCount(1);
    await expect(expired).toHaveCount(0);
    await expect(current).toHaveCount(1);
  });
});
