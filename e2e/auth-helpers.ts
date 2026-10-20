import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { expect } from "./fixtures";
import { assertLoopback, localHttp } from "./backend";
import { password } from "./seed";
import type { Mail } from "./services";

export async function mailFor(email: string) {
  return JSON.parse((await localHttp(`${process.env.RENDRO_E2E_MAIL}/mail?to=${encodeURIComponent(email)}`)).body) as Mail[];
}
export async function mailLink(email: string, subject: RegExp) {
  await expect.poll(async () => (await mailFor(email)).filter(mail => subject.test(mail.subject)).length).toBeGreaterThan(0);
  const mail = (await mailFor(email)).filter(mail => subject.test(mail.subject)).at(-1);
  const link = mail?.text.match(/http:\/\/[^\s]+/)?.[0];
  if (!link || new URL(link).origin !== process.env.RENDRO_E2E_ORIGIN) throw new Error("Mail link escaped local Worker");
  return link;
}
/** A token the server must reject. The last characters of a base64url signature carry unused bits, so changing only
 * them can decode to the same bytes and leave the token valid; the first signature character has no spare bits. */
export function tamperedToken(token: string): string {
  const at = token.lastIndexOf(".") + 1;
  return `${token.slice(0, at)}${token[at] === "A" ? "B" : "A"}${token.slice(at + 1)}`;
}
/** Auth pages apply their preloaded webfonts right after the first paint; a pointer event dispatched
 * inside that swap window can land on a reflowing layout and silently do nothing. Interacting only once
 * the font loading is settled keeps clicks (and the form submits behind them) real. */
export async function fontsSettled(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
export async function signup(page: Page, email: string, returnTo = "/account/security") {
  await page.goto(`/sign-up?returnTo=${encodeURIComponent(returnTo)}`);
  await fontsSettled(page);
  await page.getByLabel("Full name", { exact: true }).fill("Auth Journey");
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}
export async function verifiedUser(page: Page, email: string) {
  await signup(page, email);
  await page.goto(await mailLink(email, /Verify/));
  await expect(page.getByRole("heading", { name: "Email verified", exact: true })).toBeVisible();
}
export async function login(page: Page, email: string, value = password, remember = true, returnTo = "/account/security") {
  await page.goto(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(value);
  await page.getByLabel("Keep me signed in").setChecked(remember);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
/** Submit the recovery form and wait for its neutral confirmation. Keyboard submission
 * does not depend on pointer hit-testing, which Firefox can lose right after a navigation
 * under load; the visible confirmation proves the request completed before mail is awaited.
 */
export async function requestPasswordReset(page: Page, email: string) {
  await page.goto("/forgot-password");
  await page.locator("#email").fill(email);
  await page.locator("#email").press("Enter");
  await expect(page.getByRole("status")).toContainText("If an account exists");
}
export async function session(page: Page) {
  // Deliberately project out credentials: assertions and traces need identity only.
  return page.evaluate(async () => {
    const result = await (await fetch("/api/auth/get-session?disableCookieCache=true")).json() as null | { user: { id: string; email: string; emailVerified: boolean }; session: { id: string; createdAt: string | number; expiresAt: string | number } };
    return result ? { userId: result.user.id, email: result.user.email,
      verified: result.user.emailVerified, sessionId: result.session.id,
      createdAt: result.session.createdAt, expiresAt: result.session.expiresAt } : null;
  });
}
/** Expiry of the browser's live session cookie (-1 for a session-only one), or undefined while there is none. Firefox
 * keeps listing a cookie that sign-out just expired, so an entry whose expiry has passed is not the session. Poll it. */
export async function sessionCookieExpiry(context: BrowserContext) {
  const live = (await context.cookies()).find(cookie => cookie.name.endsWith(".session_token") && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
  return live?.expires;
}
/** The security page is interactive once its document has fully parsed (the
 * lifecycle listeners are inline scripts at the end of the body) and the
 * sign-in methods have loaded. A URL assertion only proves the navigation committed.
 */
export async function securityReady(page: Page) {
  await page.waitForLoadState("load");
  await expect(page.locator("#method-list")).toHaveAttribute("aria-busy", "false");
}
export async function signout(page: Page) {
  // Method loading expands the security card and moves Sign out. WebKit can
  // finish its actionability check before that layout change and miss the click.
  await securityReady(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  expect(await session(page)).toBeNull();
}

/** Administrative access is only to the private backend allocated by global setup.
 * No production function, auth option or clock is changed. Never print this file.
 */
export async function authRecord<T>(operation: "findOne" | "updateOne" | "create", args: object): Promise<T> {
  const directory = process.env.RENDRO_E2E_DIRECTORY;
  if (!directory) throw new Error("Missing disposable backend directory");
  const { origin, adminKey } = JSON.parse(await readFile(join(directory, "backend-admin.json"), "utf8")) as { origin: string; adminKey: string };
  assertLoopback(origin);
  if (origin !== process.env.RENDRO_E2E_CONVEX) throw new Error("Admin fixture backend mismatch");
  const response = await localHttp(`${origin}/api/function`, { path: `adapter:${operation}`, componentPath: "betterAuth", args, format: "json" }, { Authorization: `Convex ${adminKey}` });
  const result = JSON.parse(response.body) as { status: string; value: T; errorMessage?: string };
  if (response.status !== 200 || result.status !== "success") throw new Error(`Disposable auth fixture ${operation} failed: ${result.errorMessage ?? response.status}`);
  return result.value;
}
export async function ageRecord(model: "session" | "verification", field: string, value: string, update: object) {
  await authRecord("updateOne", { input: { model, where: [{ field, value }], update } });
}

/** Hold a browser request at the transport boundary; release it to the real backend
 * unless the test explicitly asks for a transport failure. Always release in finally.
 */
export async function holdRequest(page: Page, path: string) {
  let release!: (failure?: boolean) => void;
  const gate = new Promise<boolean | undefined>(resolve => { release = resolve; });
  let count = 0;
  const handler = async (route: Route) => {
    count++;
    if (await gate) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Service unavailable. Please try again." }) });
    else await route.continue();
  };
  await page.route(`**${path}`, handler);
  return { release, count: () => count, async close() { release(); await page.unroute(`**${path}`, handler); } };
}
