import { describe, expect, it, vi } from "vitest";
import { coalesceMessage, createDocumentNavigationGate, createMessageRateLimit } from "@/viewer/message-limits";

describe("parent-owned message limits", () => {
  function fixture(supported = true) {
    let now = 0;
    const activation = { isActive: false };
    const host = { performance: { now: () => now }, navigator: supported ? { userActivation: activation } : {} } as unknown as Window;
    return { gate: createDocumentNavigationGate(host), activation, advance: (time: number) => { now = time; } };
  }

  it("requires positive activation and ignores current targets without spending authorization", () => {
    const { gate, activation } = fixture();
    expect(gate.request("other?x#y", "current")).toBe("confirm");
    activation.isActive = true;
    expect(gate.request("current", "current")).toBeNull();
    expect(gate.request("other?x#y", "current")).toBe("push");
    expect(gate.request("next", "other?x#y")).toBe("confirm");
  });

  it("does not rearm with elapsed time or iframe replacement while activation stays true", () => {
    const { gate, activation, advance } = fixture();
    activation.isActive = true;
    expect(gate.request("first", "start")).toBe("push");
    for (const time of [1100, 2200, 3400, 4500, 6000, 60_000]) {
      advance(time);
      gate.observe();
      expect(gate.request(`frame-${time}`, "first")).toBe("confirm");
    }
  });

  it("rearms only after observing inactivity and requires a subsequent activation", () => {
    const { gate, activation } = fixture();
    activation.isActive = true;
    expect(gate.request("first", "start")).toBe("push");
    activation.isActive = false;
    gate.observe();
    expect(gate.request("second", "first")).toBe("confirm");
    activation.isActive = true;
    expect(gate.request("second", "first")).toBe("push");
  });

  it("requires confirmation when another click hides expiry between observer ticks", () => {
    const { gate, activation, advance } = fixture();
    activation.isActive = true;
    expect(gate.request("first", "start")).toBe("push");
    activation.isActive = false;
    advance(5300);
    // A delayed observer never saw false before the next browser gesture.
    activation.isActive = true;
    expect(gate.request("second", "first")).toBe("confirm");
    activation.isActive = false;
    gate.observe();
    activation.isActive = true;
    expect(gate.request("second", "first")).toBe("push");
  });

  it("coalesces confirmations and prevents their activation authorizing another frame", () => {
    const { gate, activation } = fixture();
    activation.isActive = true;
    expect(gate.request("first", "start")).toBe("push");
    expect(gate.confirm()).toBe("replace");
    expect(gate.request("third", "second")).toBe("confirm");
    expect(gate.confirm()).toBe("replace");
    activation.isActive = false;
    gate.observe();
    activation.isActive = true;
    expect(gate.confirm()).toBe("push");
    expect(gate.request("fourth", "third")).toBe("confirm");
  });

  it("reserves parent input until observed inactivity without creating a history burst", () => {
    const { gate, activation, advance } = fixture();
    activation.isActive = true;
    gate.reserveParentInput();
    expect(gate.request("current", "current")).toBeNull();
    for (const time of [0, 5000, 60_000]) {
      advance(time);
      gate.observe();
      gate.reserveParentInput();
      expect(gate.request("attack", "current")).toBe("confirm");
    }
    expect(gate.confirm()).toBe("push");
    expect(gate.request("another", "current")).toBe("confirm");
    activation.isActive = false;
    gate.observe();
    activation.isActive = true;
    expect(gate.request("document-link", "current")).toBe("push");
  });

  it("parent input neither ends a navigation burst nor renews its fallback timestamp", () => {
    for (const supported of [true, false]) {
      const { gate, activation, advance } = fixture(supported);
      activation.isActive = true;
      expect(gate.confirm()).toBe("push");
      advance(4000);
      gate.reserveParentInput();
      expect(gate.request("attack", "current")).toBe("confirm");
      advance(5001);
      expect(gate.confirm()).toBe(supported ? "replace" : "push");
    }
  });

  it("parent input after traversal preserves the restored history entry", () => {
    const { gate, activation } = fixture();
    activation.isActive = true;
    gate.confirm();
    gate.suspend();
    gate.reserveParentInput();
    expect(gate.request("attack", "restored")).toBe("confirm");
    expect(gate.confirm()).toBe("push");
  });

  it("blocks activation reuse after Back/Forward, even with no preceding message navigation", () => {
    const { gate, activation } = fixture();
    activation.isActive = true;
    gate.suspend();
    expect(gate.request("next", "restored")).toBe("confirm");
    expect(gate.confirm()).toBe("push");
    expect(gate.request("another", "next")).toBe("confirm");
    expect(gate.confirm()).toBe("replace");
    gate.suspend();
    expect(gate.request("next", "restored")).toBe("confirm");
    expect(gate.confirm()).toBe("push");
  });

  it("fails closed without the API, allowing only parent confirmations and grouping their history", () => {
    const { gate, advance } = fixture(false);
    expect(gate.request("first", "start")).toBe("confirm");
    expect(gate.confirm()).toBe("push");
    for (const time of [1100, 2200, 3400, 4500]) {
      advance(time);
      gate.observe();
      expect(gate.request("next", "first")).toBe("confirm");
    }
    expect(gate.confirm()).toBe("replace");
    advance(10_000);
    expect(gate.request("next", "first")).toBe("confirm");
    expect(gate.confirm()).toBe("push");
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

  it("drops a pending trailing fragment when cancelled, and cancelling with nothing pending is harmless", () => {
    vi.useFakeTimers();
    try {
      const apply = vi.fn();
      const host = { performance: { now: () => Date.now() }, setTimeout, clearTimeout } as unknown as Window;
      const update = coalesceMessage(apply, host);
      update.cancel();
      update("#first");
      update("#stale");
      expect(vi.getTimerCount()).toBe(1);
      update.cancel();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(100);
      expect(apply.mock.calls).toEqual([["#first"]]);
      // The next report starts afresh rather than waiting on the cancelled timer.
      update("#next");
      expect(apply.mock.calls).toEqual([["#first"], ["#next"]]);
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
