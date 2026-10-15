import { describe, expect, it } from "vitest";
import { isWorkerResolverRequest, signResolverRequest } from "../shared/resolver-auth";
import { signAuthClientIp } from "../shared/auth-client-ip";
const secret = "resolver-test-secret-32-characters-long";
const request = new Request("https://backend.example/api/rendro/publications/public?slug=docs");

describe("Worker storage resolver proof", () => {
  it("accepts only a fresh proof bound to the exact request", async () => {
    const now = Date.now();
    const headers = await signResolverRequest(request, secret, now);
    const signed = new Request(request, { headers });
    expect(await isWorkerResolverRequest(signed, secret)).toBe(true);
    expect(await isWorkerResolverRequest(signed, secret, now + 60_000)).toBe(true);
    for (const time of [now + 60_001, now - 60_001]) expect(await isWorkerResolverRequest(signed, secret, time)).toBe(false);
    for (const url of [request.url + "x", request.url.replace("backend.example", "other.example"), request.url.replace("publications", "shares")]) {
      expect(await isWorkerResolverRequest(new Request(url, { headers }), secret, now)).toBe(false);
    }
    expect(await isWorkerResolverRequest(new Request(request, { headers, method: "POST" }), secret, now)).toBe(false);
    expect(await isWorkerResolverRequest(signed, "x".repeat(32), now)).toBe(false);
    for (const missing of [undefined, "", "short"]) expect(await isWorkerResolverRequest(signed, missing, now)).toBe(false);
    await expect(signResolverRequest(request, "short")).rejects.toThrow("not configured");
  });
  it("rejects missing, malformed, and other-purpose signatures", async () => {
    const valid = await signResolverRequest(request, secret);
    expect(await isWorkerResolverRequest(request, secret)).toBe(false);
    for (const [name, value] of [["x-rendro-resolver-time", ""], ["x-rendro-resolver-time", "NaN"], ["x-rendro-resolver-signature", ""], ["x-rendro-resolver-signature", "invalid"]]) {
      const headers = new Headers(valid); headers.set(name, value);
      expect(await isWorkerResolverRequest(new Request(request, { headers }), secret)).toBe(false);
    }
    const headers = await signAuthClientIp(request, "192.0.2.1", secret);
    expect(await isWorkerResolverRequest(new Request(request, { headers }), secret)).toBe(false);
  });
});
