import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { managementRequestScript } from "@/routes/management-request";
afterEach(() => vi.useRealTimers());
function fixture(status: number, retryAfter: string) {
  const fetch = vi.fn().mockResolvedValue(Response.json({ message: "private upstream detail" }, { status, headers: { "Retry-After": retryAfter } }));
  const request = vm.runInNewContext(managementRequestScript + "\nrequest", { window: { RendroUI: {} }, fetch, setTimeout, clearTimeout, Date, DOMException }) as (path: string, options?: RequestInit) => Promise<unknown>;
  return { fetch, request };
}
const path = "/api/auth/organization/get-full-organization?organizationId=org-a";
it.each([429, 503])("honors Retry-After for %s, then recovers without surfacing the raw error", async status => {
  vi.useFakeTimers(); const f = fixture(status, "1");
  f.fetch.mockResolvedValueOnce(Response.json({}, { status, headers: { "Retry-After": "1" } })).mockResolvedValue(Response.json({ id: "org-a" }));
  const result = f.request(path);
  await vi.advanceTimersByTimeAsync(999); expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.fetch).toHaveBeenCalledWith(path, expect.objectContaining({ cache: "no-store" }));
  await vi.advanceTimersByTimeAsync(1); expect(await result).toEqual({ id: "org-a" }); expect(f.fetch).toHaveBeenCalledTimes(2);
});
it("stops after two automatic retries and returns a safe retryable message", async () => {
  vi.useFakeTimers(); const f = fixture(429, "1");
  const result = f.request(path).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await result).toMatchObject({ status: 429, retryAfter: 1, message: "Organization information is temporarily unavailable. Please try again in 1 second." });
  expect(f.fetch).toHaveBeenCalledTimes(3);
});
it.each(["60", "date"])("does not retry before a long %s Retry-After", async kind => {
  vi.useFakeTimers(); const header = kind === "date" ? new Date(Date.now() + 60_000).toUTCString() : "60";
  const f = fixture(503, header);
  await expect(f.request(path)).rejects.toMatchObject({ status: 503, retryAfter: 60 });
  await vi.advanceTimersByTimeAsync(2_000); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it("cancels the backoff on navigation", async () => {
  vi.useFakeTimers(); const f = fixture(429, "1"), controller = new AbortController();
  const result = f.request(path, { signal: controller.signal }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0); controller.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(5_000); expect(f.fetch).toHaveBeenCalledTimes(1);
});
it("never retries invitation or credential writes", async () => {
  vi.useFakeTimers(); const f = fixture(429, "1");
  await expect(f.request("/api/auth/organization/invite-member", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(10_000); expect(f.fetch).toHaveBeenCalledTimes(1);
});
