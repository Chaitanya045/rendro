import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_CLIENT_IP_HEADER, signAuthClientIp, verifiedAuthRequest } from "../shared/auth-client-ip";
import { registerAuthClientIp } from "../src/auth-client-ip";
import { proxyAuthRequest, proxyAuthSignOut } from "../src/auth-proxy";
import { CONVEX_INTERNAL_SECRET } from "../src/config";
import worker from "../src/worker";

const secret = CONVEX_INTERNAL_SECRET;
const url = "https://convex.test/api/auth/sign-in/email";

afterEach(() => vi.unstubAllGlobals());

describe("trusted auth client IP forwarding", () => {
  it.each(["192.0.2.1", "2001:db8::42"])("authenticates a single ingress address: %s", async (ip) => {
    const request = new Request(url, { method: "POST", body: "body", headers: { cookie: "session=test" } });
    (await signAuthClientIp(request, ip, secret)).forEach((value, name) => request.headers.set(name, value));
    const verified = await verifiedAuthRequest(request, secret);
    expect(verified.headers.get(AUTH_CLIENT_IP_HEADER)).toBe(ip);
    expect(verified.headers.get("x-rendro-client-ip-signature")).toBeNull();
    expect(verified.headers.get("cookie")).toBe("session=test");
    expect(await verified.text()).toBe("body");
  });

  it("ignores direct callers' IP claims, even an injected verified header", async () => {
    const request = new Request(url, { headers: {
      [AUTH_CLIENT_IP_HEADER]: "192.0.2.1",
      "x-rendro-client-ip": "192.0.2.1",
      "x-forwarded-for": "192.0.2.2",
      "x-real-ip": "192.0.2.3",
      "cf-connecting-ip": "192.0.2.4",
    } });
    expect((await verifiedAuthRequest(request, secret)).headers.get(AUTH_CLIENT_IP_HEADER)).toBeNull();
  });

  it.each(["ip", "method", "path", "query", "expired", "future", "secret", "missing-secret", "malformed"])("rejects %s tampering", async (change) => {
    const now = Date.now();
    const original = new Request(url);
    const headers = await signAuthClientIp(original, "192.0.2.1", secret, now);
    if (change === "ip") headers.set("x-rendro-client-ip", "192.0.2.2");
    if (change === "malformed") headers.set("x-rendro-client-ip-signature", "not-hex");
    const request = new Request(url + (change === "path" ? "/other" : change === "query" ? "?extra=1" : ""), {
      method: change === "method" ? "POST" : "GET", headers,
    });
    const verified = await verifiedAuthRequest(request,
      change === "missing-secret" ? undefined : change === "secret" ? "different-internal-secret-at-least-32" : secret,
      now + (change === "expired" ? 60_001 : change === "future" ? -60_001 : 0),
    );
    expect(verified.headers.get(AUTH_CLIENT_IP_HEADER)).toBeNull();
  });

  it.each([undefined, "garbage", "192.0.2.1, 192.0.2.2"])("does not sign an invalid ingress value (%s)", async (ip) => {
    expect(Array.from(await signAuthClientIp(new Request(url), ip, secret))).toEqual([]);
  });

  it("overwrites spoofed forwarding headers with registered ingress metadata in the proxy", async () => {
    const fetchMock = vi.fn(async (target: string, init: RequestInit) => {
      const verified = await verifiedAuthRequest(new Request(target, init), secret);
      expect(verified.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("192.0.2.10");
      expect(verified.headers.get("x-forwarded-for")).toBeNull();
      expect(verified.headers.get("cf-connecting-ip")).toBeNull();
      expect(verified.headers.get("cookie")).toBe("session=test");
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://rendro.test/api/auth/get-session", { headers: {
      cookie: "session=test", "cf-connecting-ip": "192.0.2.99",
      "x-forwarded-for": "192.0.2.99", [AUTH_CLIENT_IP_HEADER]: "192.0.2.99",
      "x-rendro-client-ip-signature": "forged",
    } });
    registerAuthClientIp(request, "192.0.2.10");
    await proxyAuthRequest(request);
    await proxyAuthSignOut(request);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not trust CF-Connecting-IP outside the Worker ingress", async () => {
    vi.stubGlobal("fetch", vi.fn(async (target: string, init: RequestInit) => {
      const verified = await verifiedAuthRequest(new Request(target, init), secret);
      expect(verified.headers.get(AUTH_CLIENT_IP_HEADER)).toBeNull();
      return Response.json({ ok: true });
    }));
    await proxyAuthRequest(new Request("https://rendro.test/api/auth/get-session", {
      headers: { "cf-connecting-ip": "192.0.2.99" },
    }));
  });

  it.each(["/api/auth/get-session", "/health"])("forwards Worker ingress metadata through %s", async (path) => {
    const fetchMock = vi.fn(async (target: string, init: RequestInit) => {
      const request = await verifiedAuthRequest(new Request(target, init), secret);
      expect(new URL(request.url).pathname).toBe("/api/auth/get-session");
      expect(request.headers.get(AUTH_CLIENT_IP_HEADER)).toBe("192.0.2.10");
      return Response.json(null);
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await worker.request(`https://rendro.test${path}`, {
      headers: {
        "cf-connecting-ip": "192.0.2.10",
        cookie: "better-auth.session_token=test",
        [AUTH_CLIENT_IP_HEADER]: "192.0.2.99",
      },
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
