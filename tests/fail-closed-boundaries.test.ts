import { afterEach, describe, expect, it, vi } from "vitest";
import workerApp from "@/worker";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fail-closed API boundaries", () => {
  it("does not expose unhandled exception messages or request paths", async () => {
    const response = await workerApp.request(
      "/select.js",
      undefined,
      { ASSETS: { fetch: () => { throw new Error("storage password leaked in stack"); } } },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });
});
