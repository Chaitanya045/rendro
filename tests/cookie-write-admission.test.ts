import { cookieWriteFixture as fixture, admissionHeaders as headers } from "./helpers/cookie-write-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { components } from "../convex/_generated/api";
import { requireCookieWrite } from "../shared/request-admission";
import { writeAdmission } from "../src/middleware/write-admission";

const origin = "http://localhost:3000";
const badHeaders: Array<Record<string, string>> = [
  { origin: "https://foreign.test" }, { origin: "http://sibling.localhost:3000" },
  { origin: "null" }, { origin: "" }, { origin: `${origin}/` },
  { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" },
  { "content-type": "application/x-www-form-urlencoded" },
  { "content-type": "multipart/form-data; boundary=test" }, { "content-type": "" },
];

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("cookie write admission", () => {
  it("fails closed on absent/invalid canonical configuration and accepts only exact HTTP origins", () => {
    const request = new Request(`${origin}/write`, { method: "POST", headers: headers() });
    for (const site of [undefined, "", "broken", "file:///tmp/site"]) expect(() => requireCookieWrite(request, site)).toThrow("Same-origin");
    expect(() => requireCookieWrite(request, `${origin}/app`)).not.toThrow();
    expect(() => requireCookieWrite(new Request(request, { headers: headers({ "content-type": "Application/JSON; charset=UTF-8", "sec-fetch-site": "same-origin" }) }), origin)).not.toThrow();
    expect(() => requireCookieWrite(new Request(request, { headers: headers({ "content-type": "" }) }), origin, false)).not.toThrow();
  });

  // This matrix executes every mutation with ten denied origins/content types,
  // then a real successful write (including password hashing). Coverage on a
  // shared runner can exceed the default five-second unit-test budget.
  it("protects every custom session mutation directly at Convex and retains same-origin success", async () => {
    const f = await fixture();
    for (const path of Object.keys(f.bodies)) {
      for (const bad of badHeaders) {
        const response = await f.post(path, bad);
        expect(response.status, `${path}: ${JSON.stringify(bad)}`).toBe("content-type" in bad ? 415 : 403);
      }
      const response = await f.post(path);
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
    }
  }, 15_000);

  it("never treats a bearer header as authority for a session write", async () => {
    const f = await fixture();
    expect((await f.post("/api/auth/set-initial-password", { authorization: "Bearer valid-key", origin: "" })).status).toBe(403);
  });

  it("requires a fresh persisted session before setting an initial password", async () => {
    const f = await fixture();
    const path = "/api/auth/set-initial-password";
    expect((await f.post(path, { cookie: "" })).status).toBe(403);
    for (const createdAt of [Date.now() - 86400_000, Date.now() + 60_000]) {
      await f.backend.mutation(components.betterAuth.adapter.updateOne, { input: { model: "session", where: [{ field: "_id", value: f.session._id }], update: { createdAt } } });
      expect((await f.post(path)).status).toBe(403);
    }
    const accounts = await f.backend.query(components.betterAuth.adapter.findMany, { model: "account", paginationOpts: { cursor: null, numItems: 10 } });
    expect(accounts.page).toEqual([]);
  });

  it("enforces Worker admission before session writes and leaves other routes to their own policy", async () => {
    const app = new Hono();
    const write = vi.fn(() => new Response(null, { status: 204 }));
    app.use("*", writeAdmission);
    app.all("*", write);
    for (const path of ["/api/auth/set-initial-password"]) {
      for (const bad of badHeaders) {
        const count = write.mock.calls.length;
        expect((await app.request(origin + path, { method: "POST", headers: headers(bad) })).status).toBe("content-type" in bad ? 415 : 403);
        expect(write).toHaveBeenCalledTimes(count);
      }
      expect((await app.request(origin + path, { method: "POST", headers: headers() })).status).toBe(204);
    }
    // Better Auth, comment access and beacons decide for themselves.
    for (const path of ["/api/auth/sign-in/email", "/r/acme/docs/comment-access", "/rum"]) {
      expect((await app.request(origin + path, { method: "POST", headers: { authorization: "Bearer valid-key" } })).status).toBe(204);
    }
    expect((await app.request(origin + "/health")).status).toBe(204);
    vi.stubEnv("SITE_URL", undefined);
    expect((await app.request(origin + "/api/auth/set-initial-password", { method: "POST", headers: headers({ origin }) })).status).toBe(204);
  });
});
