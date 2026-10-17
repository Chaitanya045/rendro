import type { BrowserContext, Page } from "@playwright/test";
import type { Seed } from "./seed";
import { test, expect, fullOrganization, invitations, join, openSection, optionsOf, toasts, type FullOrganization } from "./org-fixtures";
import { api, signInSeeded } from "./shell-helpers";

type Role = "owner" | "admin" | "member";
const trigger = (page: Page) => page.locator("#organization-page-action");

type Fixtures = { page: Page; context: BrowserContext; baseURL: string | undefined; seed: Seed };

async function inspectRole(role: Role, { page, context, baseURL, seed }: Fixtures) {
  await signInSeeded(context, baseURL, seed, role);
  const manager = role !== "member";
  const invitationReads: string[] = [];
  page.on("request", request => { if (request.url().includes("/organization/list-invitations")) invitationReads.push(request.url()); });

  // People
  await openSection(page, seed.organizationId, "people");
  const row = (email: string) => page.locator("#member-list tr", { hasText: email });
  await expect(page.locator("#member-list tr")).toHaveCount(3);
  await expect(row(`${role}@example.test`).locator(".badge.accent")).toHaveText("You");
  if (manager) {
    await expect(trigger(page)).toHaveText("Invite people");
    await expect(page.locator(".pending-panel")).toBeVisible();
    await expect(page.locator("#invite-dialog")).toBeAttached();
    expect(invitationReads).toHaveLength(1);
    await expect(row("member@example.test").getByRole("combobox")).toBeVisible();
    await expect(row("member@example.test").locator("button.remove-member")).toBeVisible();
    await expect(row("owner@example.test").locator("button.remove-member")).toHaveCount(0);
    await expect(row(`${role}@example.test`).locator("button.remove-member")).toHaveCount(0);
    if (role === "admin") {
      // Admins manage members and admins, never owners, and cannot grant ownership.
      await expect(row("owner@example.test").getByRole("combobox")).toHaveCount(0);
      await expect(row("owner@example.test").locator("td[data-label=Role] .badge")).toHaveText("Owner");
      expect((await optionsOf(page, "Change role for member@example.test")).map(option => option.text)).toEqual(["Member", "Admin"]);
    } else {
      expect((await optionsOf(page, "Change role for member@example.test")).map(option => option.text)).toEqual(["Member", "Admin", "Owner"]);
    }
  } else {
    await expect(trigger(page)).toBeHidden();
    await expect(page.locator(".pending-panel, #invite-dialog")).toHaveCount(0);
    await expect(page.locator("#member-list select, #member-list [role=combobox], #member-list button")).toHaveCount(0);
    await expect(row("owner@example.test").locator("td[data-label=Role] .badge")).toHaveText("Owner");
    await expect(row("admin@example.test").locator("td[data-label=Role] .badge")).toHaveText("Admin");
    // Members never request the invitation list.
    expect(invitationReads).toEqual([]);
  }

  // Teams
  await openSection(page, seed.organizationId, "teams");
  const team = page.locator(".team-card").first();
  await expect(team).toBeVisible();
  if (manager) {
    await expect(trigger(page)).toHaveText("Create team");
    await expect(page.locator("#team-dialog")).toBeAttached();
    await expect(team.getByRole("combobox", { name: "Choose member" })).toBeVisible();
    await expect(team.getByRole("button", { name: "Remove team", exact: true })).toBeVisible();
    await expect(team.getByRole("button", { name: "View members", exact: true })).toBeVisible();
  } else {
    await expect(trigger(page)).toBeHidden();
    await expect(page.locator("#team-dialog")).toHaveCount(0);
    await expect(team).toContainText("Organization team");
    await expect(team.locator("select, button, [role=combobox]")).toHaveCount(0);
  }

  // Settings
  await openSection(page, seed.organizationId, "settings");
  const name = page.getByLabel("Name", { exact: true }), slug = page.getByLabel("Slug", { exact: true });
  await expect(name).toHaveValue("E2E primary");
  await expect(slug).toHaveValue("e2e-primary");
  if (manager) {
    await expect(name).toBeEnabled();
    await expect(slug).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeVisible();
  } else {
    await expect(name).toBeDisabled();
    await expect(slug).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByText("Only organization owners and admins can change these settings.")).toBeVisible();
  }
}

/** Seeded owner/admin/member of one organization, plus an outsider in another: read-only journeys, nothing is written. */
test.describe("role-specific organization pages", () => {
  test("owner: People, Teams and Settings expose exactly the controls of that role", ({ page, context, baseURL, seed }) => inspectRole("owner", { page, context, baseURL, seed }));
  test("admin: People, Teams and Settings expose exactly the controls of that role", ({ page, context, baseURL, seed }) => inspectRole("admin", { page, context, baseURL, seed }));
  test("member: People, Teams and Settings expose exactly the controls of that role", ({ page, context, baseURL, seed }) => inspectRole("member", { page, context, baseURL, seed }));

  test("an outsider cannot open or read another organization's pages", async ({ page, context, baseURL, seed }) => {
    await signInSeeded(context, baseURL, seed, "outsider");
    for (const section of ["", "/people", "/teams", "/settings", "/onboarding"]) {
      const response = await page.goto(`/organizations/${seed.organizationId}${section}`);
      expect(response!.status(), section).toBe(404);
      await expect(page.getByText("Page not found")).toBeVisible();
      await expect(page.getByRole("link", { name: "Manage organizations", exact: true })).toHaveAttribute("href", "/organizations?choose=1");
    }
    for (const path of ["management/access?organizationId=", "management/members?organizationId=", "credentials?organizationId="]) {
      expect((await api(page, `/api/rendro/${path}${seed.organizationId}`)).status, path).toBe(403);
    }
    for (const path of ["get-full-organization?organizationId=", "list-invitations?organizationId="]) {
      expect((await api(page, `/api/auth/organization/${path}${seed.organizationId}`)).status, path).toBe(403);
    }
  });
});

test.describe("organization management APIs enforce roles independently of the UI", () => {
  test("members and outsiders are refused every management write; admins cannot delete the organization", async ({ seeded, seed }) => {
    // Owner: look up targets and prepare one invitation that denied callers will try to cancel.
    const ownerPage = await seeded("owner");
    const full = (await fullOrganization(ownerPage, seed.organizationId)).body;
    const memberByEmail = Object.fromEntries(full.members.map(entry => [entry.user.email, entry]));
    const team = full.teams[0];
    const target = `denied-${Date.now().toString(36)}@example.test`;
    const invitation = await api<{ id: string }>(ownerPage, "/api/auth/organization/invite-member", { organizationId: seed.organizationId, email: target, role: "member" });
    expect(invitation.status).toBe(200);

    const org = seed.organizationId;
    const attempts: Array<[string, string, unknown]> = [
      ["invite", "/api/auth/organization/invite-member", { organizationId: org, email: `late-${target}`, role: "member" }],
      ["cancel invitation", "/api/auth/organization/cancel-invitation", { invitationId: invitation.body.id }],
      ["change a role", "/api/auth/organization/update-member-role", { memberId: memberByEmail["admin@example.test"].id, role: "member", organizationId: org }],
      ["remove a member", "/api/auth/organization/remove-member", { memberIdOrEmail: memberByEmail["admin@example.test"].id, organizationId: org }],
      ["rename the organization", "/api/auth/organization/update", { organizationId: org, data: { name: "Hijacked" } }],
      ["create a team", "/api/auth/organization/create-team", { name: "Sneaky", organizationId: org }],
      ["remove a team", "/api/auth/organization/remove-team", { teamId: team.id, organizationId: org }],
      ["add a team member", "/api/auth/organization/add-team-member", { teamId: team.id, userId: memberByEmail["member@example.test"].userId, organizationId: org }],
      ["remove a team member", "/api/auth/organization/remove-team-member", { teamId: team.id, userId: memberByEmail["owner@example.test"].userId, organizationId: org }],
      ["delete the organization", "/api/auth/organization/delete", { organizationId: org }],
    ];
    for (const role of ["member", "outsider"] as const) {
      const page = await seeded(role);
      for (const [label, path, body] of attempts) {
        const response = await api(page, path, body);
        expect(response.status, `${role}: ${label}`).toBeGreaterThanOrEqual(400);
        expect(response.status, `${role}: ${label}`).toBeLessThan(500);
      }
    }
    const admin = await seeded("admin");
    for (const [label, path, body] of [
      ["delete the organization", "/api/auth/organization/delete", { organizationId: org }],
      ["grant ownership", "/api/auth/organization/update-member-role", { memberId: memberByEmail["member@example.test"].id, role: "owner", organizationId: org }],
      ["demote the owner", "/api/auth/organization/update-member-role", { memberId: memberByEmail["owner@example.test"].id, role: "member", organizationId: org }],
      ["remove the owner", "/api/auth/organization/remove-member", { memberIdOrEmail: memberByEmail["owner@example.test"].id, organizationId: org }],
    ] as const) {
      const response = await api(admin, path, body);
      expect(response.status, `admin: ${label}`).toBeGreaterThanOrEqual(400);
      expect(response.status, `admin: ${label}`).toBeLessThan(500);
    }

    // Nothing changed: same name, roles and teams; the prepared invitation is still pending until its owner cancels it.
    const after = (await fullOrganization(ownerPage, seed.organizationId)).body;
    expect(after.name).toBe("E2E primary");
    expect(after.members.map(entry => [entry.user.email, entry.role]).sort()).toEqual(full.members.map(entry => [entry.user.email, entry.role]).sort());
    expect(after.teams.map(entry => entry.id)).toEqual(full.teams.map(entry => entry.id));
    const pending = await api<Array<{ id: string; status: string }>>(ownerPage, `/api/auth/organization/list-invitations?organizationId=${org}`);
    expect(pending.body.find(entry => entry.id === invitation.body.id)?.status).toBe("pending");
    expect((await api(ownerPage, "/api/auth/organization/cancel-invitation", { invitationId: invitation.body.id })).status).toBe(200);
  });

  test("an ordinary member cannot read the organization's pending invitations", async ({ actor }) => {
    const owner = await actor("invites-owner", { organizations: ["Invite Privacy"] });
    const admin = await actor("invites-admin");
    const member = await actor("invites-member");
    const [organization] = owner.organizations;
    await join(owner, organization.id, admin, "admin");
    await join(owner, organization.id, member, "member");
    const pending = `pending-${Date.now().toString(36)}@example.test`;
    expect((await api(owner.page, "/api/auth/organization/invite-member", { organizationId: organization.id, email: pending, role: "member" })).status).toBe(200);
    type WithInvitations = FullOrganization & { invitations: Array<{ email: string }> };

    for (const who of [owner, admin]) {
      const listed = await invitations(who.page, organization.id);
      expect(listed.status, who.label).toBe(200);
      expect(listed.body.map(entry => entry.email), who.label).toContain(pending);
      const full = await fullOrganization(who.page, organization.id) as { status: number; body: WithInvitations };
      expect(full.body.invitations.map(entry => entry.email), who.label).toContain(pending);
    }

    // Members are refused the list and get the organization without it; the roster they need is unchanged.
    const denied = await invitations(member.page, organization.id);
    expect(denied).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_ALLOWED_TO_LIST_INVITATIONS" } });
    expect(JSON.stringify(denied.body)).not.toContain(pending);
    const memberView = await fullOrganization(member.page, organization.id) as { status: number; body: WithInvitations };
    expect(memberView.status).toBe(200);
    expect(memberView.body.invitations).toEqual([]);
    expect(memberView.body.members.map(entry => entry.user.email).sort()).toEqual([admin.email, member.email, owner.email].sort());

    // Their People page shows the roster without an invitation section or an error.
    await openSection(member.page, organization.id, "people");
    await expect(member.page.locator("#member-list tr")).toHaveCount(3);
    await expect(member.page.locator(".pending-panel")).toHaveCount(0);
    await expect(member.page.getByText(pending)).toHaveCount(0);
    await expect(toasts(member.page)).toHaveCount(0);
    await openSection(admin.page, organization.id, "people");
    await expect(admin.page.locator("#invitation-list")).toContainText(pending);
  });
});
