import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { authRecord, login, session } from "./auth-helpers";
import { password } from "./seed";

/**
 * #89: HTTPS deployments moved Better Auth cookies from `__Secure-better-auth.*` to host-only `__Host-better-auth.*`.
 * This local HTTP stack uses the unprefixed names, so a pre-#89 browser is modelled by moving the same signed values
 * under the `__Secure-` names: the migration code path is the same (legacy name → current name).
 */
const legacy = (name: string) => `__Secure-${name}`;
// An expired cookie is no longer part of the jar: the browser never sends it. Firefox can still list one that a
// `Max-Age=0` response just expired (observed in CI: its expiry is the response time, and no later request carried it),
// so the jar is read the way a request would see it.
const authCookies = async (context: BrowserContext) =>
  (await context.cookies()).filter(cookie => /^(?:__Secure-)?better-auth\./.test(cookie.name) && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
// The legacy cookie names a fresh same-origin session read actually puts on the wire.
const legacyNamesSent = async (page: Page) => {
  const [request] = await Promise.all([page.waitForRequest(/\/api\/auth\/get-session/), session(page)]);
  return ((await request.allHeaders()).cookie ?? "").split(/;\s*/).map(pair => pair.split("=")[0]).filter(name => name.startsWith("__Secure-"));
};

async function asLegacyBrowser(page: Page, context: BrowserContext, project: string) {
  const current = await authCookies(context);
  // WebKit keeps but never sends Secure cookies on a loopback HTTP origin (production is HTTPS); probe first.
  await context.addCookies([{ name: "__Secure-probe", value: "1", domain: new URL(page.url()).hostname, path: "/", secure: true }]);
  test.skip(!(await page.evaluate(() => document.cookie)).includes("__Secure-probe=1"),
    `${project} does not use Secure cookies on a loopback HTTP origin`);
  await context.clearCookies();
  await context.addCookies(current.map(cookie => ({ ...cookie, name: legacy(cookie.name), secure: true })));
  return current;
}

for (const remember of [false, true]) {
  test(`a legacy session stays signed in and moves to the current cookie name (remember=${remember}) [AUTH-89-01]`, async ({ page, context }, info) => {
    await login(page, "owner@example.test", password, remember);
    await expect(page).toHaveURL(/\/account\/security$/);
    const identity = await session(page);
    if (!identity) throw new Error("Missing session");
    const current = await asLegacyBrowser(page, context, info.project.name);
    const token = current.find(cookie => cookie.name === "better-auth.session_token");
    if (!token) throw new Error("Missing session cookie");

    // Reads: the Worker renders a protected page from the legacy cookie alone (no redirect to sign-in).
    expect((await page.goto("/home"))?.status()).toBe(200);
    await expect(page).toHaveURL(/\/home$/);

    // Writes: the next successful auth read (the page's own, or this probe's) re-issues the session under the
    // current name and expires the legacy one. A transiently failed read leaves the legacy cookie usable, so wait
    // for the signal that matters: a read that no longer carries any legacy cookie.
    await expect.poll(() => legacyNamesSent(page)).toEqual([]);
    expect((await authCookies(context)).filter(cookie => cookie.name.startsWith("__Secure-"))).toEqual([]);
    const migrated = (await authCookies(context)).find(cookie => cookie.name === "better-auth.session_token");
    expect(migrated?.value).toBe(token.value);
    // #145: a non-remembered session stays a browser-session cookie; a remembered one persists.
    if (remember) expect(migrated?.expires).toBeGreaterThan(Date.now() / 1000);
    else expect(migrated?.expires).toBe(-1);

    // The same session persists across reloads and new tabs under the current name.
    expect((await session(page))?.sessionId).toBe(identity.sessionId);
    await page.reload();
    expect((await session(page))?.sessionId).toBe(identity.sessionId);
    const second = await context.newPage();
    expect((await second.goto("/account/security"))?.status()).toBe(200);
    expect((await session(second))?.sessionId).toBe(identity.sessionId);
    await second.close();
  });
}

test("a legacy session signs out through the Worker and leaves no auth cookie [AUTH-89-02]", async ({ page, context }, info) => {
  await login(page, "owner@example.test", password, true);
  await expect(page).toHaveURL(/\/account\/security$/);
  const identity = await session(page);
  if (!identity) throw new Error("Missing session");
  await asLegacyBrowser(page, context, info.project.name);
  // A POST with a body: Convex rewrites the legacy cookie names before routing and revokes the session.
  const result = await page.evaluate(async () => await (await fetch("/api/auth/sign-out", { method: "POST", headers: { Accept: "application/json" } })).json() as unknown);
  expect(result).toEqual({ success: true });
  expect(await authRecord("findOne", { model: "session", where: [{ field: "_id", value: identity.sessionId }], select: ["_id"] })).toBeNull();
  expect(await authCookies(context)).toEqual([]);
  await page.goto("/account/security");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
});
