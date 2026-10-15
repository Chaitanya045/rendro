import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";
const auth = vi.hoisted(() => ({ getSession: vi.fn(), setPassword: vi.fn(), handler: vi.fn(), freshAge: 86400 }));
vi.mock("../convex/auth", () => ({ createAuth: () => ({
  handler: auth.handler,
  api: { getSession: auth.getSession, setPassword: auth.setPassword },
  $context: Promise.resolve({ sessionConfig: { freshAge: auth.freshAge } }),
}) }));
import http from "../convex/http";

const action = http.lookup("/api/auth/set-initial-password", "POST")![0] as unknown as { _handler(ctx: unknown, request: Request): Promise<Response> };
function request(body: string, overrides: Record<string, string> = {}) {
  return action._handler({}, new Request("https://backend.test/api/auth/set-initial-password", {
    method: "POST", headers: { origin: process.env.SITE_URL!, "content-type": "application/json", ...overrides }, body,
  }));
}
beforeEach(() => {
  auth.freshAge = 60;
  auth.getSession.mockResolvedValue({ session: { createdAt: Date.now() - 1000 } });
  auth.setPassword.mockResolvedValue({ status: true });
});
afterEach(() => vi.resetAllMocks());

it.each(["invalid", "null", "{}", '{"newPassword":42}'])("rejects malformed password body %s", async body => {
  expect((await request(body)).status).toBe(400);
  expect(auth.setPassword).not.toHaveBeenCalled();
});
it.each([null, { session: { createdAt: "invalid" } }, { session: { createdAt: Date.now() - 61_000 } }])("requires a fresh authoritative session (%#)", async session => {
  auth.getSession.mockResolvedValue(session);
  expect((await request('{"newPassword":"valid-long-password"}')).status).toBe(403);
  expect(auth.setPassword).not.toHaveBeenCalled();
});
it("uses the configured freshness interval and never permits a disabled interval", async () => {
  expect((await request('{"newPassword":"valid-long-password"}')).status).toBe(200);
  expect(auth.getSession).toHaveBeenCalledWith(expect.objectContaining({ query: { disableCookieCache: true } }));
  auth.freshAge = 0;
  expect((await request('{"newPassword":"valid-long-password"}')).status).toBe(403);
});
it.each([new APIError("BAD_REQUEST", { message: "private" }), new APIError("INTERNAL_SERVER_ERROR", { message: "private" }), new Error("private")])("sanitizes password-provider failures (%#)", async error => {
  auth.setPassword.mockRejectedValue(error);
  const response = await request('{"newPassword":"valid-long-password"}');
  expect(response.status).toBe(error instanceof APIError && error.statusCode < 500 ? 400 : 500);
  expect(await response.text()).not.toContain("private");
});
it("rejects the origin before parsing or resolving a session", async () => {
  expect((await request("invalid", { origin: "null" })).status).toBe(403);
  expect(auth.getSession).not.toHaveBeenCalled();
  expect(auth.setPassword).not.toHaveBeenCalled();
});

it.each([200, 422, 400])("keeps email sign-up responses non-enumerating (%i)", async status => {
  auth.handler.mockResolvedValue(Response.json({ detail: "provider result" }, { status }));
  const handler = http.lookup("/api/auth/sign-up/email", "POST")![0] as unknown as typeof action;
  const response = await handler._handler({}, new Request("https://backend.test/api/auth/sign-up/email", { method: "POST", body: "{}" }));
  expect(response.status).toBe(status === 400 ? 400 : 200);
  expect(await response.json()).toEqual(status === 400 ? { detail: "provider result" } : { status: true, message: "If the address can be registered, check your email to continue." });
});
