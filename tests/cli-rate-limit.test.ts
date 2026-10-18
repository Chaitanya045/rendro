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

  it("bounds the retries of a rate limit that never clears", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(limited()));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchWithRateLimit("https://rendro.test/read");
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([{ method: "PUT", body: "identical-bytes" }, { method: "POST", body: '{"paths":["index.html"]}' }, {}])("replays the same request after a transient failure, whether a 5xx or a lost connection (%j)", async init => {
    const outage = (status: number, headers?: Record<string, string>) => Response.json({ error: "Storage temporarily unavailable", retryable: true }, { status, headers });
    const fetchMock = vi.fn().mockResolvedValueOnce(outage(503, { "Retry-After": "1" })).mockResolvedValueOnce(new Response("Error: Network connection lost.", { status: 500 }))
      .mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchWithRateLimit("https://rendro.test/safe", init, true);
    await vi.advanceTimersByTimeAsync(1124);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2125);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4125);
    expect((await pending).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) expect(call).toEqual(["https://rendro.test/safe", init]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Server error (503). Retrying in 1.1s (1/3)"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Server error (500). Retrying in 2.1s (2/3)"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Network error. Retrying in 4.1s (3/3)"));
  });

  it.each([500, 502, 503, 504])("reports a %i that does not clear after the last retry", async status => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status })));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchWithRateLimit("https://rendro.test/safe", { method: "PUT", body: "x" }, true);
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockReset().mockRejectedValue(new Error("Transport failed"));
    const lost = fetchWithRateLimit("https://rendro.test/safe", { method: "PUT", body: "x" }, true);
    const settled = expect(lost).rejects.toThrow("Transport failed");
    await vi.runAllTimersAsync();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never replays a server error or lost connection of an operation that is unsafe to replay", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ error: "down" }, { status: 503, headers: { "Retry-After": "1" } })));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchWithRateLimit("https://rendro.test/start", { method: "POST", body: "{}" })).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 500 }));
    expect((await fetchWithRateLimit("https://rendro.test/commit", { method: "POST", body: "{}" })).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockReset().mockRejectedValue(new Error("Transport failed"));
    await expect(fetchWithRateLimit("https://rendro.test/start", { method: "POST", body: "{}" })).rejects.toThrow("Transport failed");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry other statuses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 501 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchWithRateLimit("https://rendro.test/read")).status).toBe(501);
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
it("sanitizes malformed and backend error responses", async () => {
  expect(await httpErrorMessage(new Response("private diagnostic", { status: 503 }))).toBe("503 Backend unavailable");
  for (const data of [null, "private diagnostic", {}, { error: 42 }]) {
    expect(await httpErrorMessage(Response.json(data, { status: 400 }))).toBe("400 Request failed");
  }
  expect(await httpErrorMessage(new Response("not JSON", { status: 400 }))).toBe("400 Request failed");
});
it("rejects overflowing numeric Retry-After values and handles empty retry bodies", async () => {
  expect(retryAfterMs(limited("9".repeat(400)))).toBeUndefined();
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(new Response(null));
  vi.stubGlobal("fetch", fetchMock);
  const pending = fetchWithRateLimit("https://rendro.test/read", { method: "HEAD" });
  await vi.runAllTimersAsync();
  expect((await pending).status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
