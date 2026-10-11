import { Hono } from "hono";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { testUtils } from "better-auth/plugins";
import type { User } from "better-auth/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthOptions } from "../convex/auth";
import { sessionMiddleware } from "@/middleware/session";
import { logger } from "@/logger";

const cookie = "better-auth.session_token=secret-cookie";
const user = {
  id: "member-id", email: "private@example.test", name: "Member", emailVerified: true,
  image: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
function app() {
  const downstream = vi.fn();
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", sessionMiddleware);
  app.all("*", (c) => {
    downstream();
    return c.get("user") ? c.json({ id: c.get("user")!.id }) : c.redirect("/sign-in");
  });
  return { app, downstream };
}
async function request(path = "/organizations", headers = { cookie, accept: "text/html" }, method = "GET") {
  const fixture = app();
  const pending = fixture.app.request(path, { method, headers });
  await vi.runAllTimersAsync();
  return { ...fixture, response: await pending };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session lookup failures", () => {
  it.each(["", "theme=better-auth", "better-auth.state=oauth", "better-auth.session_token="])(
    "skips lookup without a session token (%s)", async (cookie) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { response, downstream } = await request("/organizations", { cookie, accept: "text/html" });
      expect(response.status).toBe(302);
      expect(downstream).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    () => Response.json(null),
    () => Response.json({ code: "FAILED_TO_GET_SESSION" }, { status: 401 }),
  ])("allows the normal signed-out flow for explicit invalid/expired sessions", async (response) => {
    const fetchMock = vi.fn(response);
    vi.stubGlobal("fetch", fetchMock);
    const result = await request();
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("location")).toBe("/sign-in");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  const failures = [
    ["network", () => Promise.reject(new Error("secret-upstream-message")), 2],
    ["rate_limit", () => new Response("secret-body", { status: 429 }), 2],
    ["upstream", () => new Response("secret-body", { status: 500 }), 2],
    ["upstream", () => new Response("secret-body", { status: 503 }), 2],
    ["malformed_response", () => new Response("not-json-secret"), 2],
    ["malformed_response", () => new Response(""), 2],
    ["malformed_response", () => Response.json({ user: { ...user, createdAt: "invalid" } }), 2],
    ["malformed_response", () => Response.json({ user: null }), 2],
    ["unexpected_status", () => new Response(null, { status: 302, headers: { location: "/sign-in" } }), 1],
    ["unexpected_status", () => Response.json({ code: "UNKNOWN" }, { status: 401 }), 1],
    ["unexpected_status", () => new Response("forbidden", { status: 403 }), 1],
  ] as const;
  it.each(failures)("returns styled 503 on persistent %s failure (%#)", async (category, fail, calls) => {
    const fetchMock = vi.fn(fail);
    vi.stubGlobal("fetch", fetchMock);
    const { response, downstream } = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    expect(html).toContain('<a class="retry" href="">Try again</a>');
    expect(html).toContain("<style");
    expect(html).not.toContain("secret");
    expect(downstream).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ category }), "Session lookup failed");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(/secret|private@example/);
  });

  it.each(failures.filter(([, , calls]) => calls === 2))(
    "recovers from %s after one backoff, including before an incoming write (%#)", async (_, fail) => {
      const fetchMock = vi.fn().mockImplementationOnce(fail).mockImplementation(() => Response.json({ user }));
      vi.stubGlobal("fetch", fetchMock);
      const { response, downstream } = await request("/api/private-action", { cookie, accept: "application/json" }, "POST");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: user.id });
      expect(downstream).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchMock.mock.calls) expect(init).not.toHaveProperty("body");
    },
  );

  it.each(["/api/private", "/organizations"])("returns retryable JSON for %s", async (path) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret")));
    const { response, downstream } = await request(path, { cookie, accept: "application/json" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Session temporarily unavailable", retryable: true });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("keeps API errors JSON even when HTML is accepted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret")));
    expect((await request("/api/private")).response.headers.get("content-type")).toContain("application/json");
  });

  it.each(["60", "date"])("honors a long Retry-After (%s) without an early retry", async (header) => {
    const retryAfter = header === "date" ? new Date(Date.now() + 60_000).toUTCString() : header;
    const fetchMock = vi.fn(() => new Response(null, { status: 429, headers: { "retry-after": retryAfter } }));
    vi.stubGlobal("fetch", fetchMock);
    const { response } = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([false, true])("bounds timeouts including a stalled response body (%s)", async (bodyStalls) => {
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      const signal = init.signal!;
      if (bodyStalls) {
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(new Error("secret")));
          },
        })));
      }
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("secret"))));
    });
    vi.stubGlobal("fetch", fetchMock);
    const start = Date.now();
    const { response, downstream } = await request();
    expect(response.status).toBe(503);
    expect(Date.now() - start).toBe(10_150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(downstream).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({ category: "timeout", status: null, attempt: 2 }, "Session lookup failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for a short Retry-After before recovering", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Response(null, { status: 429, headers: { "retry-after": "1" } }))
      .mockImplementation(() => Response.json({ user }));
    vi.stubGlobal("fetch", fetchMock);
    const start = Date.now();
    expect((await request()).response.status).toBe(200);
    expect(Date.now() - start).toBe(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts an authoritative missing-session result after a transient failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(Response.json(null)));
    expect((await request()).response.status).toBe(302);
  });

  it.each(["expired", "revoked", "invalid"])("recognizes a real Better Auth %s session", async (state) => {
    vi.useRealTimers();
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "session-lookup-test-secret-at-least-32",
      database: memoryAdapter({ user: [], session: [] }),
      session: { cookieCache: { enabled: false } },
      plugins: [testUtils()],
      rateLimit: { enabled: false },
    });
    const context = await auth.$context;
    const member = context.test!.createUser({ emailVerified: true });
    await context.test!.saveUser(member);
    const login = await context.test!.login({ userId: member.id });
    vi.stubGlobal("fetch", vi.fn((_: string, init: RequestInit) =>
      auth.handler(new Request("http://localhost:3000/api/auth/get-session", init))));
    const fixture = app();
    const headers = login.headers;
    expect((await fixture.app.request("/organizations", { headers })).status).toBe(200);
    if (state === "expired") {
      await context.internalAdapter.updateSession(login.session.token, { expiresAt: new Date(Date.now() - 1_000) });
    } else if (state === "revoked") {
      await context.internalAdapter.deleteSession(login.session.token);
    } else {
      headers.set("cookie", "better-auth.session_token=invalid-signature");
    }
    const response = await fixture.app.request("/organizations", { headers });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["valid", "expired", "malformed"])("ignores malformed unused cache cookies with a real %s session", async (state) => {
    vi.useRealTimers();
    const configured = createAuthOptions({ runMutation: () => Promise.resolve(0) } as never);
    const auth = betterAuth({
      ...configured,
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ user: [], session: [], rateLimit: [] }),
      plugins: [...configured.plugins, testUtils()],
    });
    const context = await auth.$context;
    const member = context.test!.createUser({ emailVerified: true });
    await context.test!.saveUser(member);
    const login = await context.test!.login({ userId: member.id });
    if (state === "expired") await context.internalAdapter.updateSession(login.session.token, { expiresAt: new Date(Date.now() - 1_000) });
    const tokenCookie = state === "malformed" ? "better-auth.session_token=%broken.signature" : login.headers.get("cookie")!;
    const headers = { cookie: `${tokenCookie}; better-auth.session_data=malformed; __Secure-better-auth.session_data=malformed; better-auth.session_data.0=malformed; __Secure-better-auth.session_data.1=malformed; unrelated=secret` };
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("cookie")).not.toMatch(/session_data|unrelated/);
      return auth.handler(new Request("http://localhost:3000/api/auth/get-session", init));
    });
    vi.stubGlobal("fetch", fetchMock);
    const fixture = app();
    for (let i = 0; i < 2; i++) {
      expect((await fixture.app.request("/organizations", { headers })).status).toBe(state === "valid" ? 200 : 302);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("checks every request, recognizes secure cookies, and does not reuse a revoked session", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => Response.json({ user })).mockImplementation(() => Response.json(null));
    vi.stubGlobal("fetch", fetchMock);
    const headers = { cookie: `theme=dark; __Secure-${cookie}`, accept: "text/html" };
    expect((await request("/organizations", headers)).response.status).toBe(200);
    expect((await request("/organizations", headers)).response.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
