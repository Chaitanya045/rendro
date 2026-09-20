import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionMiddleware } from "@/middleware/session";

function sessionApp() {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", sessionMiddleware);
  app.get("/protected", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    c.header("Server-Timing", "data;dur=4");
    return c.json({ email: user.email });
  });
  return app;
}

function expectNumericMetric(header: string, name: string): void {
  expect(header).toMatch(new RegExp(`(?:^|,\\s*)${name};dur=\\d+\\.\\d(?:,|$)`));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session middleware Server-Timing", () => {
  it.each(["/api/auth/check", "/api/rendro/check", "/api/sync/check"])(
    "does not recursively inspect or instrument excluded API path %s",
    async (path) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const app = new Hono<{ Variables: { user?: User } }>();
      app.use("*", sessionMiddleware);
      app.get("*", (c) => c.text("ok"));

      const response = await app.request(path, {
        headers: { cookie: "better-auth.session_token=credential-secret" },
      });

      expect(response.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.headers.get("server-timing")).toBeNull();
      expect(response.headers.get("cache-control")).toBeNull();
    },
  );

  it("measures document rendering without performing a cookie-free session lookup", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await sessionApp().request("/protected");

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    const timing = response.headers.get("server-timing") ?? "";
    expectNumericMetric(timing, "render");
    expect(timing).not.toContain("session;");
  });

  it("reports only numeric session/render timings and preserves downstream metrics", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({
      user: {
        id: "user-secret-id",
        email: "timing-user@rendro.invalid",
        name: "Timing User",
        emailVerified: true,
        image: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    })));
    vi.stubGlobal("fetch", fetchMock);

    const cookie = "better-auth.session_token=credential-secret";
    const app = sessionApp();
    const first = await app.request("/protected", { headers: { cookie } });
    const second = await app.request("/protected", { headers: { cookie } });

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/auth\/get-session$/);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
    });
    const timing = first.headers.get("server-timing") ?? "";
    expect(timing).toContain("data;dur=4");
    expectNumericMetric(timing, "session");
    expectNumericMetric(timing, "render");
    expect(timing).not.toContain("user-secret-id");
    expect(timing).not.toContain("timing-user@rendro.invalid");
    expect(timing).not.toContain("credential-secret");
    expect(second.status).toBe(200);
  });

  it("fails closed when session lookup throws while retaining safe timing data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("session backend unavailable")));

    const response = await sessionApp().request("/protected", {
      headers: { cookie: "better-auth.session_token=do-not-expose" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    const timing = response.headers.get("server-timing") ?? "";
    expectNumericMetric(timing, "session");
    expectNumericMetric(timing, "render");
    expect(timing).not.toContain("session backend unavailable");
    expect(timing).not.toContain("do-not-expose");
  });
});
