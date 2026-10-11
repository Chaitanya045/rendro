import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRateLimit, retryAfterMs } from "../cli/src/rate-limit";
import { httpErrorMessage } from "../cli/src/http-error";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const limited = (retryAfter?: string) => Response.json({ error: "Rate limit exceeded", code: "rate_limited" }, {
  status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {},
});

describe("CLI rate-limit handling", () => {
  it.each([{}, { method: "PUT", body: "identical-bytes" }, { method: "POST", body: '{"paths":["index.html"]}' }])("retries safe operations with Retry-After, exponential backoff and jitter (%j)", async init => {
    const fetchMock = vi.fn().mockResolvedValueOnce(limited("2")).mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited()).mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchWithRateLimit("https://rendro.test/safe", init, true);
    await vi.advanceTimersByTimeAsync(2124);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2125);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4125);
    expect((await pending).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) expect(call).toEqual(["https://rendro.test/safe", init]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Rate limited (429). Retrying"));
  });

  it.each(["start", "commit", "publications"])("never retries %s POSTs by default", async path => {
    const fetchMock = vi.fn().mockResolvedValue(limited("5"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await fetchWithRateLimit(`https://rendro.test/${path}`, { method: "POST", body: "{}" });
    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await httpErrorMessage(response)).toBe("429 Rate limited. Retry after 5s.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds retries and does not retry outages or ambiguous transport failures", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(limited()));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchWithRateLimit("https://rendro.test/read");
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 502 }));
    expect((await fetchWithRateLimit("https://rendro.test/read")).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockReset().mockRejectedValue(new Error("Transport failed"));
    await expect(fetchWithRateLimit("https://rendro.test/read")).rejects.toThrow("Transport failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("parses dates, handles malformed headers and refuses excessive waits", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs(limited("Thu, 01 Jan 2026 00:00:05 GMT"), now)).toBe(5000);
    expect(retryAfterMs(limited("garbage"))).toBeUndefined();
    expect(retryAfterMs(limited("-1"))).toBeUndefined();
    expect(await httpErrorMessage(limited("garbage"))).toBe("429 Rate limited. Wait before retrying.");
    const fetchMock = vi.fn().mockResolvedValue(limited("3600"));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchWithRateLimit("https://rendro.test/read")).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
