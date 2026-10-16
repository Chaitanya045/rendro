import { test, expect } from "./fixtures";
import { password } from "./seed";
import { ageRecord, authRecord, holdRequest, login, mailFor, mailLink, oauthFixture, session, signout, signup, verifiedUser } from "./auth-helpers";

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
    // Method loading expands the card and moves Sign out. Wait for that
    // layout transition before clicking, especially in WebKit.
    await expect(page.locator("#method-list")).toHaveAttribute("aria-busy", "false");
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
  await page.goto("/forgot-password");
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
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

// Issue #146 (AUTH-111-01): auth CSS overrides the hidden attribute
// on the Google button and divider after successful signup. Keep this failing
// assertion until the controls actually disappear; do not credit the registry edge.
test("signup success hides Google and the credential divider [AUTH-111-01]", async ({ page }, info) => {
  await signup(page, `hidden-${info.project.name}-${info.retry}@example.test`);
  test.fail(true, "#146 (AUTH-111-01): display:flex overrides hidden on signup alternatives");
  expect({ googleVisible: await page.locator("#google-auth").isVisible(), dividerVisible: await page.locator(".divider").isVisible() }).toEqual({ googleVisible: false, dividerVisible: false });
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

// Issue #145 (AUTH-111-02): protected-page session reads extend a
// nonpersistent session to the persistent lifetime. The cookie-only assertions
// above remain independent so this marker cannot hide a cookie regression.
test("nonpersistent session retains its short backend lifetime [AUTH-111-02]", async ({ page }) => {
  await login(page, "owner@example.test", password, false);
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  expect(identity?.email).toBe("owner@example.test");
  const record = await authRecord<{ createdAt: number; expiresAt: number }>("findOne", {
    model: "session", where: [{ field: "_id", value: identity?.sessionId }], select: ["createdAt", "expiresAt"],
  });
  expect(record).not.toBeNull();
  test.fail(true, "#145 (AUTH-111-02): nonpersistent backend session is extended on protected-page entry");
  expect(record.expiresAt - record.createdAt).toBeLessThanOrEqual(86400_000 + 1000);
});
