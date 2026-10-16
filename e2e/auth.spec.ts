import { test, expect } from "./fixtures";
import { password } from "./seed";
import { ageRecord, authRecord, holdRequest, login, mailFor, mailLink, oauthFixture, requestPasswordReset, securityReady, session, signout, signup, verifiedUser } from "./auth-helpers";
import { localHttp } from "./backend";

test.describe.configure({ timeout: 60_000 });

const changedPassword = "Changed local password 111!";
test("signup verifies the original mail and retains the destination", async ({ page }, info) => {
  const email = `signup-${info.project.name}-${info.retry}@example.test`;
  const pending = await holdRequest(page, "/api/auth/sign-up/email");
  const destination = "/account/security?from=original-signup";
  const signing = signup(page, email, destination);
  try {
    await expect.poll(pending.count).toBe(1);
    await page.locator("#auth-form").dispatchEvent("submit");
    pending.release();
    await signing;
    expect(pending.count()).toBe(1);
  } finally { pending.release(); await signing; await pending.close(); }
  await expect.poll(async () => (await mailFor(email)).length).toBe(1);
  // Capture before sign-in or resend can deliver another verification message.
  const originalLink = await mailLink(email, /Verify/);
  const neutral = await page.locator("#success-panel p").innerText();
  await expect(page.locator("#auth-form")).toBeHidden();
  expect(await session(page)).toBeNull();
  await login(page, email);
  await expect(page.getByRole("alert")).toContainText(/verif/i);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(await session(page)).toBeNull();

  await page.goto(originalLink);
  await expect(page.getByRole("heading", { name: "Email verified", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", `/sign-in?returnTo=${encodeURIComponent(destination)}`);
  expect(await session(page)).toBeNull();
  await page.getByRole("link", { name: "Continue to sign in" }).click();
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${process.env.RENDRO_E2E_ORIGIN}${destination}`);
  expect(await session(page)).toMatchObject({ email, verified: true });
  const user = await authRecord<{ emailVerified: boolean }>("findOne", { model: "user", where: [{ field: "email", value: email }], select: ["emailVerified"] });
  expect(user.emailVerified).toBe(true);
  await signout(page);
  // Duplicate signup has the same UI; the existing user gets an account notice.
  await signup(page, email);
  await expect(page.locator("#success-panel p")).toHaveText(neutral);
  await expect.poll(async () => (await mailFor(email)).some(mail => mail.subject === "A Rendro sign-up was requested")).toBe(true);
});

test("verification resend is neutral and retains its destination", async ({ page }, info) => {
  const email = `resend-${info.project.name}-${info.retry}@example.test`;
  await signup(page, email);
  await expect.poll(async () => (await mailFor(email)).length).toBe(1);
  const before = (await mailFor(email)).length;
  await page.goto("/verify-email?returnTo=%2Faccount%2Fsecurity");
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(page.getByLabel("Work email", { exact: true })).toBeFocused();
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(page.getByRole("status")).toContainText("If the address is eligible");
  const resendMessage = await page.getByRole("status").innerText();
  await expect.poll(async () => (await mailFor(email)).length).toBeGreaterThan(before);
  await page.getByLabel("Work email", { exact: true }).fill(`absent-${email}`);
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(page.getByRole("button", { name: "Resend verification email" })).toBeEnabled();
  await expect(page.getByRole("status")).toHaveText(resendMessage);
  expect(await mailFor(`absent-${email}`)).toEqual([]);
  await page.goto(await mailLink(email, /Verify/));
  await expect(page.getByRole("heading", { name: "Email verified", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", "/sign-in?returnTo=%2Faccount%2Fsecurity");
  expect(await session(page)).toBeNull();
});

test("auth validation, reveal, pending exclusion and transport recovery preserve inputs", async ({ page }) => {
  for (const path of ["/sign-up", "/sign-in"]) {
    await page.goto(path);
    const submit = page.locator("#auth-form button[type=submit]");
    await submit.click();
    const first = page.locator(path === "/sign-up" ? "#name" : "#email");
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("aria-invalid", "true");
    await expect(first).toHaveAttribute("aria-describedby", "form-error");
    await expect(page.getByRole("alert")).toHaveText("Please complete this field.");
    if (path === "/sign-up") await first.fill("Auth Author");
    await page.locator("#email").fill("invalid-email");
    await submit.click();
    await expect(page.locator("#email")).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("valid email");
    await page.locator("#email").fill("transport@example.test");
    if (path === "/sign-up") {
      await page.locator("#password").pressSequentially("short");
      await submit.click();
      await expect(page.locator("#password")).toBeFocused();
      await expect(page.getByRole("alert")).toContainText("at least 15 characters");
    }
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(page.locator("#password")).toHaveAttribute("type", "text");
    await expect(page.locator("#password")).toHaveValue(password);
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(page.locator("#password")).toHaveAttribute("type", "password");
    const pending = await holdRequest(page, `/api/auth${path}/email`);
    try {
      await page.locator("#password").press("Enter");
      await expect.poll(pending.count).toBe(1);
      await expect(submit).toBeDisabled();
      await expect(submit).toHaveAttribute("aria-busy", "true");
      await expect(page.locator("#google-auth")).toBeDisabled();
      await page.locator("#auth-form").dispatchEvent("submit");
      pending.release(true);
      await expect(page.getByRole("alert")).toContainText("Service unavailable");
      await expect(submit).toBeEnabled();
      await expect(page.locator("#google-auth")).toBeEnabled();
      expect(pending.count()).toBe(1);
      await expect(page.locator("#email")).toHaveValue("transport@example.test");
      await expect(page.locator("#password")).toHaveValue(password);
      expect(await session(page)).toBeNull();
    } finally { await pending.close(); }
  }
});

test("wrong password and the real sign-in limiter restore the form with an alert", async ({ page }) => {
  await page.goto("/sign-in");
  await page.locator("#email").fill("owner@example.test");
  await page.locator("#password").fill("Wrong local password 111!");
  const submit = page.getByRole("button", { name: "Sign in", exact: true });
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = page.waitForResponse(response => response.url().endsWith("/api/auth/sign-in/email"));
    await submit.click();
    expect((await response).status()).toBe(attempt < 5 ? 401 : 429);
    await expect(submit).toBeEnabled();
    await expect(page.getByRole("alert")).toContainText(attempt < 5 ? /invalid.*password/i : /too many requests/i);
    expect(await session(page)).toBeNull();
  }
});

test("remember-me controls cookie persistence and survives reload", async ({ page, context }) => {
  for (const remember of [true, false]) {
    await login(page, "owner@example.test", password, remember);
    await expect(page).toHaveURL(/\/account\/security$/);
    const identity = await session(page);
    expect(identity?.email).toBe("owner@example.test");
    if (!identity) throw new Error("Missing session");
    // Compare cookie metadata only; never include values in assertion output.
    const cookieExpiry = (await context.cookies()).find(cookie => cookie.name.endsWith(".session_token"))?.expires;
    if (remember) expect(cookieExpiry).toBeGreaterThan(Date.now() / 1000);
    else expect(cookieExpiry).toBe(-1);
    await page.reload();
    expect((await session(page))?.sessionId).toBe(identity.sessionId);
    await signout(page);
  }
});

test("returnTo permits local paths and rejects off-site and protocol-relative destinations", async ({ page, baseURL }) => {
  for (const destination of ["/account/security?from=auth", "https://outside.invalid/private", "//outside.invalid/private", "/\\outside.invalid/private"]) {
    await login(page, "owner@example.test", password, true, destination);
    if (destination === "/account/security?from=auth") await expect(page).toHaveURL(`${baseURL}${destination}`);
    else await expect(page).toHaveURL(/\/organizations\//);
    expect(new URL(page.url()).origin).toBe(baseURL);
    expect((await session(page))?.email).toBe("owner@example.test");
    await page.goto("/account/security");
    await signout(page);
  }
});

test("password recovery is neutral and reset revokes a second browser session", async ({ page, secondContext }, info) => {
  const email = `reset-${info.project.name}-${info.retry}@example.test`;
  await verifiedUser(page, email);
  const second = await secondContext.newPage();
  await login(second, email);
  await expect(second).toHaveURL(/\/account\/security$/);
  const previous = await session(second);
  await page.goto("/forgot-password?returnTo=%2Faccount%2Fsecurity");
  await page.locator("#email").fill(`absent-${email}`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account exists");
  const neutral = await page.getByRole("status").innerText();
  expect(await mailFor(`absent-${email}`)).toEqual([]);
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeEnabled();
  await expect(page.getByRole("status")).toHaveText(neutral);
  const link = await mailLink(email, /reset/i);
  await page.goto(link);
  await expect(page).toHaveURL(/\/reset-password\?.*token=/);
  let resetRequests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/auth/reset-password") resetRequests++;
  });
  await page.getByLabel("New password", { exact: true }).fill(changedPassword);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("alert")).toHaveText("Passwords do not match.");
  expect(resetRequests).toBe(0);
  await page.getByLabel("Confirm password", { exact: true }).fill(changedPassword);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();
  await expect(page.locator("#success-panel")).toBeFocused();
  expect(resetRequests).toBe(1);
  expect(await session(second)).toBeNull();
  expect(await authRecord("findOne", { model: "session", select: ["_id"], where: [{ field: "_id", value: previous?.sessionId }] })).toBeNull();
  await second.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(second.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await expect(second.getByRole("heading", { name: "Sign-in methods" })).toBeHidden();
  await login(page, email);
  await expect(page.getByRole("alert")).toContainText(/invalid/i);
  await login(page, email, changedPassword);
  await expect(page).toHaveURL(/\/account\/security$/);
  await signout(page);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Reset link unavailable" })).toBeVisible();
});

test("missing, invalid and expired reset tokens recover without changing credentials", async ({ page }, info) => {
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "Reset link unavailable" })).toBeVisible();
  await page.getByRole("link", { name: "Request a new reset link" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.goto("/reset-password?token=invalid-local-token");
  await page.getByLabel("New password", { exact: true }).fill(changedPassword);
  await page.getByLabel("Confirm password", { exact: true }).fill(changedPassword);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("alert")).toContainText(/invalid|expired/i);
  await expect(page.getByRole("button", { name: "Update password" })).toBeEnabled();
  const email = `expired-${info.project.name}-${info.retry}@example.test`;
  await verifiedUser(page, email);
  await requestPasswordReset(page, email);
  const link = await mailLink(email, /reset/i);
  const token = new URL(link).pathname.split("/").at(-1) ?? "";
  await ageRecord("verification", "identifier", `reset-password:${token}`, { expiresAt: Date.now() - 1000 });
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Reset link unavailable" })).toBeVisible();
  expect(await session(page)).toBeNull();
  await login(page, email);
  await expect(page).toHaveURL(/\/account\/security$/);
});

test("security methods expose loading, failure and a real retry", async ({ page }) => {
  await login(page, "owner@example.test");
  await expect(page).toHaveURL(/\/account\/security$/);
  const pending = await holdRequest(page, "/api/auth/list-accounts");
  try {
    await page.reload();
    await expect(page.locator("#method-list")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#method-list")).toHaveAttribute("aria-live", "polite");
    await expect(page.getByText("Loading sign-in methods")).toBeAttached();
    pending.release(true);
    await expect(page.getByRole("alert")).toContainText("Couldn't load your sign-in methods");
    await expect(page.locator("#method-list")).toHaveAttribute("aria-busy", "false");
  } finally { await pending.close(); }
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("#method-list")).toContainText("Configured");
  await expect(page.locator("#method-list")).toContainText("Not connected");
  await expect(page.locator("#change-password-section")).toBeVisible();
});

test("change password rejects wrong current credentials and revokes other sessions", async ({ page, secondContext }, info) => {
  const email = `change-${info.project.name}-${info.retry}@example.test`;
  await verifiedUser(page, email);
  await login(page, email);
  const second = await secondContext.newPage();
  await login(second, email);
  await expect(second).toHaveURL(/\/account\/security$/);
  await page.locator("#currentPassword").fill("Wrong local password 111!");
  await page.locator("#newPassword").fill(changedPassword);
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page.locator("#change-error")).toContainText(/invalid|incorrect/i);
  await expect(page.locator("#newPassword")).toHaveValue(changedPassword);
  expect(await session(second)).not.toBeNull();
  await page.locator("#currentPassword").fill(password);
  await expect(page.getByLabel("Sign out other sessions")).toBeChecked();
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Password changed successfully.");
  await expect(page.locator("#currentPassword")).toHaveValue("");
  await expect(page.locator("#newPassword")).toHaveValue("");
  expect(await session(page)).toMatchObject({ email });
  expect(await session(second)).toBeNull();
  await signout(page);
  await login(page, email);
  await expect(page.getByRole("alert")).toContainText(/invalid/i);
  await login(page, email, changedPassword);
  await expect(page).toHaveURL(/\/account\/security$/);
});

test("OAuth callback creates a verified session and initial password requires freshness", async ({ page }, info) => {
  const email = `initial-${info.project.name}-${info.retry}@example.test`;
  await oauthFixture(page, email);
  await page.goto("/sign-in?returnTo=%2Faccount%2Fsecurity");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  expect(identity).toMatchObject({ email, verified: true });
  await expect(page.locator("#method-list")).toContainText("Not configured");
  await page.getByRole("button", { name: "Add below" }).click();
  await expect(page.locator("#password")).toBeFocused();
  await page.locator("#password").fill(password);
  await page.locator("#confirmPassword").fill(changedPassword);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.locator("#initial-error")).toHaveText("Passwords do not match.");
  await ageRecord("session", "_id", identity?.sessionId ?? "", { createdAt: Date.now() - 2 * 86400_000 });
  await page.locator("#password").fill(password);
  await page.locator("#confirmPassword").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.locator("#initial-error")).toHaveText("Sign in again before setting a password");
  await expect(page.getByRole("button", { name: "Set password" })).toBeEnabled();
  await signout(page);
  await page.goto("/sign-in?returnTo=%2Faccount%2Fsecurity");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(/\/account\/security$/);
  await page.locator("#password").fill(password);
  await page.locator("#confirmPassword").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.locator("#change-password-section")).toBeVisible();
  await expect(page.locator("#method-list")).toContainText("Configured");
  await signout(page);
  await login(page, email);
  await expect(page).toHaveURL(/\/account\/security$/);
  expect((await session(page))?.userId).toBe(identity?.userId);
});

test("OAuth denial and mismatched state create no session and offer sign-in recovery", async ({ page }, info) => {
  for (const mode of ["denial", "state-mismatch"] as const) {
    await oauthFixture(page, `denied-${info.project.name}-${info.retry}@example.test`, mode);
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page).toHaveURL(/\/sign-in\?error=/);
    await expect(page.getByRole("alert")).toContainText(mode === "denial" ? /canceled/i : /expired|verified/i);
    expect(await session(page)).toBeNull();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    await page.unroute("https://accounts.google.com/o/oauth2/v2/auth?**");
  }
});

test("Google linking restores controls on failure and connects the matching account", async ({ page }, info) => {
  const email = `link-${info.project.name}-${info.retry}@example.test`;
  await verifiedUser(page, email);
  await login(page, email);
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  const pending = await holdRequest(page, "/api/auth/link-social");
  try {
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.poll(pending.count).toBe(1);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
    pending.release(true);
    await expect(page.locator("#security-message")).toContainText("Service unavailable");
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  } finally { await pending.close(); }
  await oauthFixture(page, email);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#method-list")).toContainText("Connected");
  expect((await session(page))?.userId).toBe(identity?.userId);
  await signout(page);
  await page.goto("/sign-in?returnTo=%2Faccount%2Fsecurity");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(/\/account\/security$/);
  expect((await session(page))?.userId).toBe(identity?.userId);
});

test("sign-out failure retries, clears both tabs and protects back-forward history", async ({ page, context }) => {
  await login(page, "owner@example.test");
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  const observer = await context.newPage();
  await observer.goto("/account/security");
  const observerURL = observer.url();
  for (const tab of [page, observer]) {
    await expect(tab.locator(".shell")).toBeVisible();
    await expect(tab.locator(".shell")).not.toHaveAttribute("inert");
    await expect(tab.locator("#change-password-section")).toBeVisible();
  }
  const pending = await holdRequest(page, "/api/auth/sign-out");
  try {
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    pending.release(true);
    await expect(page.getByRole("alert").filter({ hasText: "Sign-out wasn't completed" })).toBeVisible();
    expect((await session(observer))?.sessionId).toBe(identity?.sessionId);
    await expect(observer.getByRole("heading", { name: "Sign-in methods" })).toBeVisible();
  } finally { await pending.close(); }
  await signout(page);
  await expect(observer.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await expect(observer.locator("#rendro-signed-out")).toBeFocused();
  await expect(observer.locator("#rendro-signed-out")).toHaveAttribute("aria-live", "polite");
  await expect(observer.getByRole("heading", { name: "Sign-in methods" })).toBeHidden();
  for (const tab of [page, observer]) {
    // Assert the retained containers themselves, before either tab navigates.
    await expect(tab.locator(".shell")).toBeAttached();
    await expect(tab.locator(".shell")).toBeHidden();
    await expect(tab.locator(".shell")).toHaveAttribute("inert", "");
    await expect(tab.locator(".card[data-page=security]")).toBeHidden();
    await expect(tab.locator("#change-password-section")).toBeHidden();
    await tab.locator("#currentPassword").evaluate(input => input.focus());
    await expect(tab.locator("#currentPassword")).not.toBeFocused();
    await expect(tab.locator("#rendro-signed-out")).toBeFocused();
  }
  expect(page.url()).toBe(observerURL);
  expect(observer.url()).toBe(observerURL);
  expect(await authRecord("findOne", { model: "session", select: ["_id"], where: [{ field: "_id", value: identity?.sessionId }] })).toBeNull();
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeHidden();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeHidden();
  expect(await session(page)).toBeNull();
});

test("signup success hides Google and the credential divider [AUTH-111-01]", async ({ page }, info) => {
  await signup(page, `hidden-${info.project.name}-${info.retry}@example.test`);
  await expect(page.locator("#google-auth")).toBeHidden();
  await expect(page.locator(".divider")).toBeHidden();
  await expect(page.locator("#auth-form")).toBeHidden();
  await expect(page.locator("#success-panel")).toBeFocused();
  await page.locator("#email").evaluate(input => input.focus());
  await expect(page.locator("#success-panel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Back to sign in" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page.locator("#google-auth")).toBeVisible();
  await expect(page.locator("#google-auth")).toBeEnabled();
  await expect(page.locator(".divider")).toBeVisible();
  await expect(page.locator("#auth-form")).toBeVisible();
  await expect(page.locator("#success-panel")).toBeHidden();
});

test("Google linking rejects a different provider email without replacing the session", async ({ page }, info) => {
  const email = `mismatch-${info.project.name}-${info.retry}@example.test`;
  await verifiedUser(page, email);
  await login(page, email);
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  await oauthFixture(page, `other-${email}`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in\?error=/);
  await expect(page.getByRole("alert")).toContainText("couldn't connect this Google account");
  expect((await session(page))?.userId).toBe(identity?.userId);
  await page.goto("/account/security");
  await expect(page.locator("#method-list")).toContainText("Not connected");
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
});

test("persisted pageshow checks the backend and hides a revoked account", async ({ page }) => {
  await login(page, "owner@example.test");
  await expect(page).toHaveURL(/\/account\/security$/);
  // The URL commits before the document's inline scripts finish; a pageshow
  // dispatched earlier would find no listener and be lost.
  await securityReady(page);
  const identity = await session(page);
  await ageRecord("session", "_id", identity?.sessionId ?? "", { expiresAt: Date.now() - 1000 });
  // Routing can disable native BFCache eligibility. Exercise the persisted-event
  // branch explicitly in addition to the real back/forward test above.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeHidden();
  await expect(page.locator("#rendro-signed-out")).toBeFocused();
  expect(await session(page)).toBeNull();
});

// Exercise fresh and cached protected reads, ticket-backed document assets, and
// the server expiry boundary with the production Better Auth settings.
test("nonpersistent session retains its short backend lifetime [AUTH-111-02]", async ({ page, context, seed }) => {
  await login(page, "owner@example.test", password, false);
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  expect(identity?.email).toBe("owner@example.test");
  if (!identity) throw new Error("Missing session");
  const stored = () => authRecord<{ createdAt: number; expiresAt: number }>("findOne", {
    model: "session", where: [{ field: "_id", value: identity.sessionId }], select: ["createdAt", "expiresAt"],
  });
  const initial = await stored();
  // Better Auth samples expiresAt and createdAt separately on the real clock.
  expect(initial.expiresAt - initial.createdAt).toBeGreaterThan(86400_000 - 1000);
  expect(initial.expiresAt - initial.createdAt).toBeLessThanOrEqual(86400_000);
  const org = `/organizations/${seed.organizationId}`;
  for (const path of [org, `${org}/projects`, `${org}/projects/${seed.projectId}/docs`, "/account/security"]) {
    expect((await page.goto(path))?.status()).toBe(200);
    await page.reload();
    if (path.endsWith("/docs")) {
      await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Publication from local storage" })).toBeVisible();
    }
    expect((await stored()).expiresAt).toBe(initial.expiresAt);
  }
  // The client preference is not authoritative, even when removed or forged.
  for (const marker of [null, "true.invalid", "false"]) {
    await context.clearCookies({ name: "better-auth.dont_remember" });
    if (marker !== null) await context.addCookies([{ name: "better-auth.dont_remember", value: marker, url: page.url() }]);
    // End on a fresh-identity page; the reloads below must not use cached identity.
    for (const path of [org, `${org}/projects/${seed.projectId}/docs`, "/account/security"]) {
      expect((await page.goto(path))?.status()).toBe(200);
      if (path.endsWith("/docs")) await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Publication from local storage" })).toBeVisible();
      expect((await session(page))?.sessionId).toBe(identity.sessionId);
      expect((await stored()).expiresAt).toBe(initial.expiresAt);
      expect((await context.cookies()).find(cookie => cookie.name.endsWith(".session_token"))?.expires).toBe(-1);
    }
  }
  // Age only this disposable record to just before its one-day boundary.
  const expiresAt = Date.now() + 60_000;
  await ageRecord("session", "_id", identity.sessionId, { createdAt: expiresAt - 86400_000, expiresAt });
  await page.reload();
  expect((await session(page))?.sessionId).toBe(identity.sessionId);
  expect((await stored()).expiresAt).toBe(expiresAt);
  await ageRecord("session", "_id", identity.sessionId, { expiresAt: Date.now() - 1000 });
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  expect(await session(page)).toBeNull();
});

// Sessions are cookie-only on the real Convex runtime and through the Worker: a
// bearer session token neither authenticates nor refreshes/persists the session.
test("bearer session tokens never extend a nonpersistent session [AUTH-111-02]", async ({ page, context, seed }) => {
  await login(page, "owner@example.test", password, false);
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  if (!identity) throw new Error("Missing session");
  const stored = () => authRecord<{ expiresAt: number; rememberMe: boolean }>("findOne", {
    model: "session", where: [{ field: "_id", value: identity.sessionId }], select: ["expiresAt", "rememberMe"],
  });
  const initial = await stored();
  expect(initial.rememberMe).toBe(false);
  const token = (await context.cookies()).find(cookie => cookie.name.endsWith(".session_token"));
  if (!token) throw new Error("Missing session cookie");
  const cookie = `${token.name}=${token.value}`;
  const authorization = `Bearer ${decodeURIComponent(token.value)}`;
  for (const origin of [process.env.RENDRO_E2E_CONVEX_SITE, process.env.RENDRO_E2E_ORIGIN]) {
    for (const path of ["/api/auth/get-session", "/api/auth/convex/token", "/api/auth/organization/list", "/api/auth/list-sessions", `/api/rendro/management/access?organizationId=${seed.organizationId}`]) {
      for (const headers of [{ authorization }, { authorization, cookie }] as Record<string, string>[]) {
        const label = `${origin === process.env.RENDRO_E2E_ORIGIN ? "worker" : "convex"} ${path} ${Object.keys(headers).join("+")}`;
        const response = await localHttp(`${origin}${path}`, undefined, headers);
        const sessionCookies = [response.headers["set-cookie"] ?? []].flat().filter(value => /^[^=]*\.session_token=/.test(value));
        for (const value of sessionCookies) expect(value.replace(/; Max-Age=0(?=;|$)/i, ""), label).not.toMatch(/; (?:Max-Age|Expires)=/i);
        const authenticated = response.status === 200 && response.body !== "null";
        // Convex Rendro APIs treat Authorization as an API-key request, never a session.
        const cookieAuthority = "cookie" in headers && (path.startsWith("/api/auth/") || origin === process.env.RENDRO_E2E_ORIGIN);
        expect(authenticated, `${label}: ${response.status}`).toBe(cookieAuthority);
        const current = await stored();
        expect(current.expiresAt, label).toBe(initial.expiresAt);
        expect(current.rememberMe, label).toBe(false);
      }
    }
  }
});

test("remembered session refreshes to seven days on protected entry", async ({ page, context }) => {
  await login(page, "owner@example.test");
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  if (!identity) throw new Error("Missing session");
  const stored = () => authRecord<{ createdAt: number; expiresAt: number }>("findOne", {
    model: "session", where: [{ field: "_id", value: identity.sessionId }], select: ["createdAt", "expiresAt"],
  });
  const initial = await stored();
  expect(initial.expiresAt - initial.createdAt).toBeGreaterThan(7 * 86400_000 - 1000);
  expect(initial.expiresAt - initial.createdAt).toBeLessThanOrEqual(7 * 86400_000);
  const before = Date.now();
  await ageRecord("session", "_id", identity.sessionId, {
    createdAt: before - 2 * 86400_000, expiresAt: before + 5 * 86400_000,
  });
  await page.reload();
  const refreshed = await stored();
  expect(refreshed.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86400_000);
  expect(refreshed.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86400_000);
  expect((await session(page))?.sessionId).toBe(identity.sessionId);
  expect((await context.cookies()).find(cookie => cookie.name.endsWith(".session_token"))?.expires).toBeGreaterThan(Date.now() / 1000);
});

for (const remember of [false, true]) {
  test(`password rotation inherits session lifetime (remember=${remember})`, async ({ page, context }, info) => {
    const email = `lifetime-${remember}-${info.project.name}-${info.retry}@example.test`;
    await verifiedUser(page, email);
    await login(page, email, password, remember);
    await expect(page).toHaveURL(/\/account\/security$/);
    const original = await session(page);
    await context.clearCookies({ name: "better-auth.dont_remember" });
    await page.locator("#currentPassword").fill(password);
    await page.locator("#newPassword").fill(changedPassword);
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Password changed successfully.");
    const replacement = await session(page);
    if (!replacement) throw new Error("Missing replacement session");
    expect(replacement.sessionId).not.toBe(original?.sessionId);
    const stored = await authRecord<{ createdAt: number; expiresAt: number; rememberMe: boolean }>("findOne", {
      model: "session", where: [{ field: "_id", value: replacement.sessionId }], select: ["createdAt", "expiresAt", "rememberMe"],
    });
    expect(stored.rememberMe).toBe(remember);
    const duration = (remember ? 7 : 1) * 86400_000;
    expect(stored.expiresAt - stored.createdAt).toBeGreaterThan(duration - 1000);
    expect(stored.expiresAt - stored.createdAt).toBeLessThanOrEqual(duration);
    const cookieExpiry = (await context.cookies()).find(cookie => cookie.name.endsWith(".session_token"))?.expires;
    if (remember) expect(cookieExpiry).toBeGreaterThan(Date.now() / 1000);
    else expect(cookieExpiry).toBe(-1);
    expect(await authRecord("findOne", { model: "session", where: [{ field: "_id", value: original?.sessionId }], select: ["_id"] })).toBeNull();
  });
}
