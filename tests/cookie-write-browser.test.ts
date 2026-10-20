import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { cookieWriteFixture } from "./helpers/cookie-write-fixture";
import { createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
const appOrigin = "https://app.rendro.test";
const siblingOrigin = "https://sibling.rendro.test";
beforeAll(async () => { await harness.start((_req, res) => res.end("fixture")); });
afterAll(() => vi.unstubAllEnvs());

it("rejects same-site sibling submissions with real browser cookies", async () => {
  vi.stubEnv("SITE_URL", appOrigin);
  const f = await cookieWriteFixture();
  const page = await harness.newPage();
  // Reserved .test hosts are resolved entirely in this local fixture. Chromium
  // still owns cookie, Origin and CORS behavior.
  const observed: Array<{ origin: string | undefined; site: string | undefined; cookie: boolean; status: number }> = [];
  await page.context().addCookies([{ name: "__Host-better-auth.session_token", value: f.cookie.split("=").slice(1).join("="), url: appOrigin, secure: true, httpOnly: true, sameSite: "Lax" }]);
  await page.context().route("https://*.rendro.test/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local admission fixture</title>" });
    const headers = await request.allHeaders();
    const response = await f.backend.fetch(url.pathname, { method: request.method(), headers, body: request.postData()! });
    observed.push({ origin: headers.origin, site: headers["sec-fetch-site"], cookie: Boolean(headers.cookie), status: response.status });
    await route.fulfill({ response: undefined, status: response.status, contentType: "application/json", body: await response.text() });
  });
  await page.goto(siblingOrigin);
  const path = "/api/auth/set-initial-password";
  await page.evaluate(async ({ url, body }) => {
    await fetch(url, { method: "POST", mode: "no-cors", credentials: "include", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) });
  }, { url: appOrigin + path, body: f.bodies[path] });
  expect(observed.at(-1)).toMatchObject({ origin: siblingOrigin, cookie: true, status: 403 });
  await page.goto(appOrigin);
  const result = await page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return response.status;
  }, { path, body: f.bodies[path] });
  expect(result).toBe(200);
  expect(observed.at(-1)).toMatchObject({ origin: appOrigin, cookie: true, status: 200 });
});
