import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The read path's internal Convex calls (#254, #284): comment grants and first-page snapshots. Every failure is the
 * retryable "could not check", never an empty answer the caller could mistake for a denial or an empty page.
 */
async function internal(config: { CONVEX_URL: string; CONVEX_INTERNAL_SECRET: string }) {
  vi.resetModules();
  vi.doMock("@/config", () => config);
  return import("@/convex-internal");
}
const configured = { CONVEX_URL: "https://convex.test", CONVEX_INTERNAL_SECRET: "internal-secret-0123456789abcdef0123" };

afterEach(() => { vi.doUnmock("@/config"); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("internal Convex calls", () => {
  it("sends the internal secret with the arguments and returns the value", async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(Response.json({ status: "success", value: { granted: true } })));
    vi.stubGlobal("fetch", fetch);
    const { convexMutationRequired, convexQueryRequired } = await internal(configured);
    expect(await convexMutationRequired("repoCommentAccess:grant", { repoId: 1 })).toEqual({ granted: true });
    expect(await convexQueryRequired("repoComments:threadSnapshot", { repoId: 1 })).toEqual({ granted: true });
    expect(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body as string) as unknown])).toEqual([
      ["https://convex.test/api/mutation", { path: "repoCommentAccess:grant", args: [{ repoId: 1, internalSecret: configured.CONVEX_INTERNAL_SECRET }] }],
      ["https://convex.test/api/query", { path: "repoComments:threadSnapshot", args: [{ repoId: 1, internalSecret: configured.CONVEX_INTERNAL_SECRET }] }],
    ]);
  });

  it.each([
    ["no Convex URL", { ...configured, CONVEX_URL: "" }],
    ["no internal secret", { ...configured, CONVEX_INTERNAL_SECRET: "" }],
  ])("is unavailable with %s, without calling anything", async (_name, config) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { convexQueryRequired } = await internal(config);
    await expect(convexQueryRequired("repoComments:threadSnapshot", {})).rejects.toMatchObject({ unavailable: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a denial", () => new Response(null, { status: 403 })],
    ["an error envelope", () => Response.json({ status: "error", errorMessage: "private" })],
    ["a success without a value", () => Response.json({ status: "success" })],
    ["a body that is no object", () => Response.json(["success"])],
    ["a transport failure", () => { throw new TypeError("fetch failed"); }],
  ])("is unavailable on %s", async (_name, answer) => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve().then(answer)));
    const { convexMutationRequired } = await internal(configured);
    await expect(convexMutationRequired("repoCommentAccess:grant", {})).rejects.toMatchObject({ unavailable: true, retryAfter: "1" });
  });

  it("passes on the backend's Retry-After for a retryable status", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("busy", { status: 429, headers: { "Retry-After": "7" } }))));
    const { convexMutationRequired } = await internal(configured);
    await expect(convexMutationRequired("repoCommentAccess:grant", {})).rejects.toMatchObject({ retryAfter: "7" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))));
    await expect(convexMutationRequired("repoCommentAccess:grant", {})).rejects.toMatchObject({ retryAfter: "1" });
    // A body that refuses to be cancelled changes nothing.
    const stuck = new ReadableStream({ cancel() { throw new Error("cannot cancel"); } });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(stuck, { status: 502 }))));
    await expect(convexMutationRequired("repoCommentAccess:grant", {})).rejects.toMatchObject({ unavailable: true });
  });

  it("gives up on a backend that never answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { convexQueryRequired } = await internal(configured);
    const call = expect(convexQueryRequired("repoComments:threadSnapshot", {})).rejects.toMatchObject({ unavailable: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await call;
  });
});
