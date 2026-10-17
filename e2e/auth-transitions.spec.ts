import { test, expect } from "./fixtures";
import { password } from "./seed";
import { authRecord, login, mailLink, oauthFixture, securityReady, session, signout, signup, verifiedUser } from "./auth-helpers";

test.describe.configure({ timeout: 60_000 });

const changedPassword = "Changed local password 197!";

// Product bug: Better Auth redirects a rejected token to the callback with `&error=...`, but the
// page keys only on `verified=1`, so an invalid or expired link is reported as a success.
test.fail("an invalid verification link offers recovery instead of reporting the email as verified (known bug)", async ({ page }, info) => {
  const email = `badlink-${info.project.name}-${info.retry}@example.test`;
  await signup(page, email);
  const link = new URL(await mailLink(email, /Verify/));
  const token = link.searchParams.get("token") ?? "";
  link.searchParams.set("token", `${token.slice(0, -2)}${token.endsWith("aa") ? "bb" : "aa"}`);
  await page.goto(link.href);
  // These hold today: nothing was verified and nobody was signed in.
  const user = await authRecord<{ emailVerified: boolean }>("findOne", { model: "user", where: [{ field: "email", value: email }], select: ["emailVerified"] });
  expect(user.emailVerified).toBe(false);
  expect(await session(page)).toBeNull();
  // Intended behaviour (fails today): no success claim, and the resend form is offered.
  await expect(page.getByRole("heading", { name: "Email verified", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Resend verification email" })).toBeVisible();
});

test("Google sign-in never leaves the origin, whatever return target was requested", async ({ page, baseURL }, info) => {
  for (const [index, requested] of ["https://outside.invalid/phish", "//outside.invalid/phish", "/\\outside.invalid"].entries()) {
    await oauthFixture(page, `redirect-${index}-${info.project.name}-${info.retry}@example.test`);
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(requested)}`);
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.waitForURL(url => url.origin === baseURL && !url.pathname.startsWith("/sign-in") && !url.pathname.startsWith("/api/"));
    await page.waitForLoadState("load");
    expect(new URL(page.url()).origin).toBe(baseURL);
    expect((await session(page))?.email).toBe(`redirect-${index}-${info.project.name}-${info.retry}@example.test`);
    await page.goto("/account/security");
    await signout(page);
    await page.unroute("https://accounts.google.com/o/oauth2/v2/auth?**");
  }
});

test("changing a password can keep other sessions, and Back to workspace leaves account security", async ({ page, secondContext }, info) => {
  const email = `keep-${info.project.name}-${info.retry}@example.test`;
  await verifiedUser(page, email);
  await login(page, email);
  await expect(page).toHaveURL(/\/account\/security$/);
  const second = await secondContext.newPage();
  await login(second, email);
  await expect(second).toHaveURL(/\/account\/security$/);
  const other = await session(second);
  await securityReady(page);
  await page.locator("#currentPassword").fill(password);
  await page.locator("#newPassword").fill(changedPassword);
  await page.getByLabel("Sign out other sessions").uncheck();
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Password changed successfully.");
  await expect(page.locator("#currentPassword")).toHaveValue("");
  await expect(page.locator("#newPassword")).toHaveValue("");
  expect(await session(page)).toMatchObject({ email });
  // The unchecked option leaves the other browser's session valid.
  expect(await session(second)).toMatchObject({ email, sessionId: other?.sessionId });
  await page.getByRole("link", { name: "Back to workspace" }).click();
  await expect(page).toHaveURL(/\/organizations(\/|$)/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeVisible();
  await signout(page);
  await login(page, email, changedPassword);
  await expect(page).toHaveURL(/\/account\/security$/);
});

test("a restored page for a different account hides the previous account's data", async ({ page, context }, info) => {
  const first = `restore-a-${info.project.name}-${info.retry}@example.test`;
  const second = `restore-b-${info.project.name}-${info.retry}@example.test`;
  await verifiedUser(page, first);
  await verifiedUser(page, second);
  await login(page, first);
  await expect(page).toHaveURL(/\/account\/security$/);
  await securityReady(page);
  await expect(page.getByText(first)).toBeVisible();
  // Another tab switches the shared cookie jar to a different account; no sign-out is broadcast.
  const other = await context.newPage();
  await other.goto("/sign-in");
  const response = await other.request.post("/api/auth/sign-in/email", { headers: { origin: new URL(page.url()).origin }, data: { email: second, password } });
  expect(response.ok()).toBe(true);
  expect(await session(other)).toMatchObject({ email: second });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await expect(page.locator("#rendro-signed-out")).toBeFocused();
  await expect(page.locator(".shell")).toBeHidden();
  await expect(page.getByText(first)).toBeHidden();
  await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeHidden();
});

test("sign-out whose cookie cleanup is lost still leaves a usable signed-out tab and a working sign-in", async ({ page, context }, info) => {
  const email = `cleanup-${info.project.name}-${info.retry}@example.test`;
  await verifiedUser(page, email);
  await login(page, email);
  await expect(page).toHaveURL(/\/account\/security$/);
  await securityReady(page);
  const token = (await context.cookies()).find(cookie => cookie.name.endsWith(".session_token"));
  expect(token).toBeDefined();
  // Deliver the acknowledged sign-out without the cookie-clearing headers.
  await page.route("**/api/auth/sign-out", async route => {
    const upstream = await route.fetch();
    // route.fetch() applies Set-Cookie to the browser's jar; put the credential back to model the lost cleanup.
    await context.addCookies([token!]);
    const headers = Object.fromEntries(Object.entries(upstream.headers()).filter(([name]) => !["set-cookie", "clear-site-data"].includes(name)));
    await route.fulfill({ response: upstream, headers });
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await expect(page.locator("#rendro-signed-out")).toBeFocused();
  await expect(page.locator("#rendro-signed-out").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  // The browser still holds the revoked credential, but the server treats it as signed out.
  expect((await context.cookies()).find(cookie => cookie.name === token?.name)?.value).toBe(token?.value);
  expect(await session(page)).toBeNull();
  await page.goto("/account/security");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Faccount%2Fsecurity$/);
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/security$/);
  expect(await session(page)).toMatchObject({ email });
});
