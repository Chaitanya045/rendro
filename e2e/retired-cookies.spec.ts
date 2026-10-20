import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { authRecord, login, session } from "./auth-helpers";
import { password } from "./seed";

/**
 * #89 moved HTTPS Better Auth cookies from `__Secure-better-auth.*` to host-only `__Host-better-auth.*`, and #208
 * retired the old names: nothing reads them as a session, and sign-out still expires them. This local HTTP stack uses
 * the unprefixed current names, so a browser holding the retired names is modelled by copying the same signed values
 * under `__Secure-` names.
 */
const retired = (name: string) => `__Secure-${name}`;
// An expired cookie is no longer part of the jar: the browser never sends it. Firefox can still list one that a
// `Max-Age=0` response just expired (#210), so the jar is read the way a request would see it.
const authCookies = async (context: BrowserContext) =>
  (await context.cookies()).filter(cookie => /^(?:__Secure-)?better-auth\./.test(cookie.name) && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));

/** Adds a `__Secure-` copy of every current auth cookie; `only` first removes the current ones. */
async function withRetiredCopies(page: Page, context: BrowserContext, project: string, only: boolean) {
  const current = await authCookies(context);
  // WebKit keeps but never sends Secure cookies on a loopback HTTP origin (production is HTTPS); probe first.
  await context.addCookies([{ name: "__Secure-probe", value: "1", domain: new URL(page.url()).hostname, path: "/", secure: true }]);
  test.skip(!(await page.evaluate(() => document.cookie)).includes("__Secure-probe=1"),
    `${project} does not use Secure cookies on a loopback HTTP origin`);
  await context.clearCookies({ name: "__Secure-probe" });
  if (only) await context.clearCookies();
  await context.addCookies(current.map(cookie => ({ ...cookie, name: retired(cookie.name), secure: true })));
}

test("a browser holding only retired __Secure- session cookies is signed out [AUTH-208-01]", async ({ page, context }, info) => {
  await login(page, "owner@example.test", password, true);
  await expect(page).toHaveURL(/\/account\/security$/);
  await withRetiredCopies(page, context, info.project.name, true);
  // The Worker treats the request as anonymous, and Convex resolves no session from the retired names.
  await page.goto("/account/security");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  expect(await session(page)).toBeNull();
  // Nothing re-issues the retired session under the current name.
  expect((await authCookies(context)).filter(cookie => !cookie.name.startsWith("__Secure-"))).toEqual([]);
});

test("sign-out through the Worker also expires the retired __Secure- names [AUTH-89-02]", async ({ page, context }, info) => {
  await login(page, "owner@example.test", password, true);
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  if (!identity) throw new Error("Missing session");
  await withRetiredCopies(page, context, info.project.name, false);
  const result = await page.evaluate(async () => await (await fetch("/api/auth/sign-out", { method: "POST", headers: { Accept: "application/json" } })).json() as unknown);
  expect(result).toEqual({ success: true });
  expect(await authRecord("findOne", { model: "session", where: [{ field: "_id", value: identity.sessionId }], select: ["_id"] })).toBeNull();
  expect(await authCookies(context)).toEqual([]);
  await page.goto("/account/security");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
});
