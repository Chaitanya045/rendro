import type { Page } from "@playwright/test";
import { test, expect, invitationLink, invitations, organizationList, roles, stopNavigation, openSection, failOnce } from "./org-fixtures";
import { holdRequest, mailLink } from "./auth-helpers";
import { authRecord } from "./auth-helpers";
import { api } from "./shell-helpers";
import { password } from "./seed";

async function invite(owner: { page: Page }, organizationId: string, email: string, role: "member" | "admin") {
  const response = await api<{ id: string }>(owner.page, "/api/auth/organization/invite-member", { organizationId, email, role });
  expect(response.status).toBe(200);
  return response.body.id;
}
/** The invitation the mail points at must be the pending one for this recipient. */
const status = async (owner: { page: Page }, organizationId: string, id: string) =>
  (await api<Array<{ id: string; status: string }>>(owner.page, `/api/auth/organization/list-invitations?organizationId=${organizationId}`)).body.find(invitation => invitation.id === id)?.status;
/** An unavailable invitation is the shared not-found document with a way back, never a review screen. */
async function expectUnavailable(page: Page, url: string) {
  const response = await page.goto(url);
  expect(response!.status()).toBe(404);
  await expect(page.getByText("Page not found")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage organizations", exact: true })).toHaveAttribute("href", "/organizations?choose=1");
  await expect(page.locator("#accept, #reject, #invitation-state")).toHaveCount(0);
}

test.describe("invitation acceptance", () => {
  test("a new invitee follows the mailed link through sign-up and verification, reviews the invitation and accepts it", async ({ actor, baseURL }) => {
    test.setTimeout(120_000);
    const host = await actor("host", { organizations: ["Invite Org"] });
    const guest = await actor("guest", { signedOut: true });
    const [organization] = host.organizations;
    const invitationId = await invite(host, organization.id, guest.email, "admin");
    const link = await invitationLink(guest.email, "Invite Org");
    expect(link).toBe(`${baseURL}/accept-invitation/${invitationId}`);
    const { page } = guest;

    // Signed out: the link leads to sign-in with the invitation as the return target and explains why.
    await page.goto(link);
    const returnTo = `/accept-invitation/${invitationId}`;
    await expect(page).toHaveURL(`${baseURL}/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    await expect(page.locator(".invitation-chip").first()).toHaveText("Organization invitation");
    await expect(page.getByRole("heading", { name: "You have been invited to collaborate." })).toBeVisible();
    // The invitation survives account creation, verification and sign-in.
    const create = page.getByRole("link", { name: "Create an account", exact: true });
    await expect(create).toHaveAttribute("href", `/sign-up?returnTo=${encodeURIComponent(returnTo)}`);
    await create.click();
    await expect(page).toHaveURL(`${baseURL}/sign-up?returnTo=${encodeURIComponent(returnTo)}`);
    await page.getByLabel("Full name", { exact: true }).fill("Invited Guest");
    await page.getByLabel("Work email", { exact: true }).fill(guest.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await page.goto(await mailLink(guest.email, /Verify/));
    await expect(page.getByRole("heading", { name: "Email verified", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", `/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
    await page.getByRole("link", { name: "Continue to sign in" }).click();
    await page.getByLabel("Work email", { exact: true }).fill(guest.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // Review: the signed-in address, organization and role are shown; nothing is accepted or created automatically.
    await expect(page).toHaveURL(`${baseURL}${returnTo}`);
    await expect(page.getByRole("heading", { name: "Review your invitation", level: 1 })).toBeVisible();
    await expect(page.locator("#invitation-state h2")).toHaveText("Join Invite Org");
    await expect(page.locator("#invitation-state .invitation-mark")).toHaveText("I");
    await expect(page.locator("#invitation-state .invitation-copy")).toHaveText(`Accept the invitation for ${guest.email} with the Admin role.`);
    await expect(page.getByText(`Signed in as ${guest.email}.`)).toBeVisible();
    await expect(page.locator(".cp-org-switcher, button#cp-org-switcher")).toHaveCount(0);
    expect(await status(host, organization.id, invitationId)).toBe("pending");
    expect(await organizationList(page)).toEqual([]);

    // A failed response re-enables both actions; a pending one disables both; the retry succeeds once.
    const accept = page.locator("#accept"), decline = page.locator("#reject"), failure = page.locator("#invitation-error");
    const failing = await failOnce(page, "**/api/auth/organization/accept-invitation", "Invitation service unavailable", 503);
    await accept.click();
    await expect(failure).toHaveText("Invitation service unavailable");
    await expect(failure).toHaveAttribute("role", "alert");
    await expect(accept).toBeEnabled();
    await expect(decline).toBeEnabled();
    await expect(accept).toHaveAttribute("aria-busy", "false");
    await failing.close();
    expect(await status(host, organization.id, invitationId)).toBe("pending");

    const pending = await holdRequest(page, "/api/auth/organization/accept-invitation");
    const stop = await stopNavigation(page, new RegExp(`/organizations/${organization.id}$`));
    try {
      await accept.click();
      await expect.poll(() => pending.count()).toBe(1);
      await expect(accept).toBeDisabled();
      await expect(decline).toBeDisabled();
      await expect(accept).toHaveAttribute("aria-busy", "true");
      pending.release();
      await expect.poll(() => stop.seen()).toBe(1);
      await expect(page.locator("#invitation-state [role=status]")).toHaveText("Invitation accepted. Continue to your organization.");
      await expect(accept).toBeDisabled();
      await expect(decline).toBeDisabled();
      expect(pending.count()).toBe(1);
    } finally {
      await pending.close();
    }
    await stop.resume();
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/organizations/${organization.id}`);
    expect(await roles(page, organization.id)).toEqual({ [host.email]: "owner", [guest.email]: "admin" });
    expect(await status(host, organization.id, invitationId)).toBe("accepted");

    // The inviter's view: the new admin is on the roster and no invitation is pending.
    await openSection(host.page, organization.id, "people");
    await expect(host.page.locator("#member-list tr", { hasText: guest.email }).locator("td[data-label=Role] .badge, td[data-label=Role] [role=combobox]")).toHaveText("Admin");
    await expect(host.page.locator("#invitation-list")).toHaveText("No pending invitations.");
  });

  test("declining returns to the chooser and the declined invitation can no longer be used", async ({ actor, baseURL }) => {
    test.setTimeout(120_000);
    const host = await actor("decline-host", { organizations: ["Decline Org"] });
    const guest = await actor("decline-guest", { organizations: ["Guest One", "Guest Two"] });
    const [organization] = host.organizations;
    const invitationId = await invite(host, organization.id, guest.email, "member");
    const { page } = guest;
    const link = await invitationLink(guest.email, "Decline Org");
    await page.goto(link);
    await expect(page.locator("#invitation-state h2")).toHaveText("Join Decline Org");
    await expect(page.locator("#invitation-state .invitation-copy")).toHaveText(`Accept the invitation for ${guest.email} with the Member role.`);

    const decline = page.locator("#reject"), accept = page.locator("#accept");
    const pending = await holdRequest(page, "/api/auth/organization/reject-invitation");
    const stop = await stopNavigation(page, new RegExp("/organizations$"));
    try {
      await decline.click();
      await expect.poll(() => pending.count()).toBe(1);
      await expect(decline).toBeDisabled();
      await expect(accept).toBeDisabled();
      await expect(decline).toHaveAttribute("aria-busy", "true");
      pending.release();
      await expect.poll(() => stop.seen()).toBe(1);
      await expect(page.locator("#invitation-state [role=status]")).toHaveText("Invitation declined. Continue to your organizations.");
    } finally {
      await pending.close();
    }
    await stop.resume();
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/organizations`);
    await expect(page.locator("#organization-list .organization-card strong")).toHaveText(["Guest One", "Guest Two"]);
    expect(await status(host, organization.id, invitationId)).toBe("rejected");
    expect(await roles(host.page, organization.id)).toEqual({ [host.email]: "owner" });
    expect((await organizationList(page)).map(entry => entry.name).sort()).toEqual(["Guest One", "Guest Two"]);

    await expectUnavailable(page, link);
    expect(await api(page, "/api/auth/organization/accept-invitation", { invitationId })).toMatchObject({ status: 400, body: { code: "INVITATION_NOT_FOUND" } });
    await openSection(host.page, organization.id, "people");
    await expect(host.page.locator("#invitation-list")).toHaveText("No pending invitations.");
  });

  test("a wrong recipient, a revoked, an expired and an already used invitation are all unavailable and change nothing", async ({ actor, baseURL }) => {
    test.setTimeout(150_000);
    const host = await actor("deny-host", { organizations: ["Denial Org"] });
    const recipient = await actor("deny-recipient");
    const stranger = await actor("deny-stranger");
    const [organization] = host.organizations;
    const unchanged = async () => expect(await roles(host.page, organization.id)).toEqual({ [host.email]: "owner" });

    // Another signed-in person with the link cannot read or accept it.
    const first = await invite(host, organization.id, recipient.email, "member");
    const firstLink = await invitationLink(recipient.email, "Denial Org");
    expect(firstLink).toBe(`${baseURL}/accept-invitation/${first}`);
    await expectUnavailable(stranger.page, firstLink);
    expect(await api(stranger.page, `/api/auth/organization/get-invitation?id=${first}`)).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION" } });
    expect(await api(stranger.page, "/api/auth/organization/accept-invitation", { invitationId: first })).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION" } });
    expect(await api(stranger.page, "/api/auth/organization/reject-invitation", { invitationId: first })).toMatchObject({ status: 403 });
    expect(await status(host, organization.id, first)).toBe("pending");
    expect(await organizationList(stranger.page)).toEqual([]);
    await unchanged();

    // Revoked by the owner: the intended recipient is refused too.
    expect((await api(host.page, "/api/auth/organization/cancel-invitation", { invitationId: first })).status).toBe(200);
    await expectUnavailable(recipient.page, firstLink);
    expect(await api(recipient.page, "/api/auth/organization/accept-invitation", { invitationId: first })).toMatchObject({ status: 400, body: { code: "INVITATION_NOT_FOUND" } });
    expect(await status(host, organization.id, first)).toBe("canceled");
    await unchanged();

    // Expired: the link and the API refuse it; the record is untouched.
    const expired = await invite(host, organization.id, recipient.email, "member");
    const expiredLink = `${baseURL}/accept-invitation/${expired}`;
    await authRecord("updateOne", { input: { model: "invitation", where: [{ field: "_id", value: expired }], update: { expiresAt: Date.now() - 1000 } } });
    await expectUnavailable(recipient.page, expiredLink);
    expect(await api(recipient.page, "/api/auth/organization/accept-invitation", { invitationId: expired })).toMatchObject({ status: 400, body: { code: "INVITATION_NOT_FOUND" } });
    expect(await organizationList(recipient.page)).toEqual([]);
    await unchanged();
    await expectUnavailable(recipient.page, `${baseURL}/accept-invitation/not-an-invitation`);

    // A fresh invitation is accepted; afterwards its link is spent and the person cannot be invited again.
    const valid = await invite(host, organization.id, recipient.email, "member");
    const validLink = `${baseURL}/accept-invitation/${valid}`;
    await recipient.page.goto(validLink);
    await expect(recipient.page.locator("#invitation-state h2")).toHaveText("Join Denial Org");
    await recipient.page.locator("#accept").click();
    await expect(recipient.page).toHaveURL(`${baseURL}/organizations/${organization.id}`);
    expect(await roles(host.page, organization.id)).toEqual({ [host.email]: "owner", [recipient.email]: "member" });
    await expectUnavailable(recipient.page, validLink);
    expect(await api(recipient.page, "/api/auth/organization/accept-invitation", { invitationId: valid })).toMatchObject({ status: 400, body: { code: "INVITATION_NOT_FOUND" } });
    expect(await api(host.page, "/api/auth/organization/invite-member", { organizationId: organization.id, email: recipient.email, role: "member" }))
      .toMatchObject({ status: 400, body: { code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" } });
    // Members and their invitations list are unaffected by the earlier attempts.
    expect((await invitations(host.page, organization.id)).body.filter(invitation => invitation.status === "pending").map(invitation => invitation.id)).toEqual([expired]);
  });
});
