import { describe, expect, it, vi } from "vitest";
import { coalesceMessage, createDocumentNavigationGate, createMessageRateLimit } from "@/viewer/message-limits";

describe("parent-owned message limits", () => {
  it("rejects script navigation, duplicates and bursts without trusting message gesture claims", () => {
    let now = 0;
    const activation = { isActive: false };
    const host = { performance: { now: () => now }, navigator: { userActivation: activation } } as unknown as Window;
    const accept = createDocumentNavigationGate(host);
    expect(accept("other?x#y", "current")).toBeNull();
    activation.isActive = true;
    expect(accept("current", "current")).toBeNull();
    expect(accept("other?x#y", "current")).toBe("push");
    for (let i = 0; i < 100; i++) expect(accept(`other?${i}`, "other?x#y")).toBeNull();
    now = 1000;
    expect(accept("other?x#y", "other?x#y")).toBeNull();
    expect(accept("next", "other?x#y")).toBe("push");
    now = 2000;
    activation.isActive = false;
    expect(accept("current", "next")).toBeNull();
    activation.isActive = true;
    expect(accept("other?x#y", "current")).toBe("push");
  });

  it("bounds unsupported browsers and replaces sustained navigation history", () => {
    let now = 0;
    const host = { performance: { now: () => now }, navigator: {} } as unknown as Window;
    const accept = createDocumentNavigationGate(host);
    expect(accept("first", "start")).toBe("replace");
    expect(accept("second", "first")).toBeNull();
    now = 1000;
    expect(accept("second", "first")).toBe("replace");
    now = 6000;
    expect(accept("third", "second")).toBe("replace");
  });

  it("coalesces floods with one timer and delivers the final fragment", () => {
    vi.useFakeTimers();
    try {
      const apply = vi.fn();
      const host = { performance: { now: () => Date.now() }, setTimeout } as unknown as Window;
      const update = coalesceMessage(apply, host);
      for (let i = 0; i < 1000; i++) update(`#${i}`);
      expect(apply.mock.calls).toEqual([["#0"]]);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(100);
      expect(apply.mock.calls).toEqual([["#0"], ["#999"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("rate limits completed as well as in-flight work", () => {
    let now = 0;
    const allow = createMessageRateLimit(30_000, () => now);
    expect(allow()).toBe(true);
    for (let i = 0; i < 100; i++) expect(allow()).toBe(false);
    now = 30_000;
    expect(allow()).toBe(true);
  });
});
