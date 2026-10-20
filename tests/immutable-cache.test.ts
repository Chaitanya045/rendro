import { describe, expect, it, vi } from "vitest";
import { ImmutableMetadataCache } from "../src/immutable-cache";

const load = <T>(value: T, weight: number | null) => vi.fn(() => Promise.resolve({ value, weight }));

describe("immutable metadata cache", () => {
  it("coalesces concurrent misses into one load and serves later hits", async () => {
    const cache = new ImmutableMetadataCache(10_000, 5_000);
    let release!: (value: { value: string; weight: number }) => void;
    const loader = vi.fn(() => new Promise<{ value: string; weight: number }>(resolve => { release = resolve; }));
    const first = cache.get("key", loader);
    const second = cache.get("key", loader);
    release({ value: "parsed", weight: 300 });
    expect(await Promise.all([first, second])).toEqual(["parsed", "parsed"]);
    expect(await cache.get("key", loader)).toBe("parsed");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.weight).toBe(300);
  });

  it("charges a minimum weight and evicts least recently used entries by weight", async () => {
    const cache = new ImmutableMetadataCache(1_000, 1_000);
    await cache.get("a", load("a", 1));
    expect(cache.weight).toBe(256);
    await cache.get("b", load("b", 400));
    await cache.get("a", load("unused", 1)); // touch: b is now least recent
    await cache.get("c", load("c", 400));
    expect(cache.size).toBe(2);
    const reload = load("b2", 400);
    expect(await cache.get("b", reload)).toBe("b2");
    expect(reload).toHaveBeenCalledOnce();
    expect(cache.weight).toBeLessThanOrEqual(1_000);
  });

  it("keeps a slow load that settles after newer entries and evicts those instead", async () => {
    const cache = new ImmutableMetadataCache(1_000, 1_000);
    let release!: (value: { value: string; weight: number }) => void;
    const slow = cache.get("slow", () => new Promise<{ value: string; weight: number }>(resolve => { release = resolve; }));
    await cache.get("newer", load("newer", 600));
    release({ value: "slow", weight: 600 });
    expect(await slow).toBe("slow");
    expect(cache.size).toBe(1);
    expect(await cache.get("slow", load("unused", 1))).toBe("slow");
  });

  it("does not retain oversized, unretainable or failed loads", async () => {
    const cache = new ImmutableMetadataCache(10_000, 1_000);
    expect(await cache.get("big", load("big", 1_001))).toBe("big");
    expect(await cache.get("none", load(null, null))).toBeNull();
    await expect(cache.get("error", () => Promise.reject(new Error("storage unavailable")))).rejects.toThrow("storage unavailable");
    expect(cache.size).toBe(0);
    expect(cache.weight).toBe(0);
    const retry = load("ok", 10);
    expect(await cache.get("error", retry)).toBe("ok");
    expect(retry).toHaveBeenCalledOnce();
  });

  it("never resurrects loads that finish after clear()", async () => {
    const cache = new ImmutableMetadataCache(10_000, 10_000);
    let release!: (value: { value: string; weight: number }) => void;
    let reject!: (error: Error) => void;
    const pending = cache.get("key", () => new Promise<{ value: string; weight: number }>(resolve => { release = resolve; }));
    const failing = cache.get("failing", () => new Promise<{ value: string; weight: number }>((_resolve, fail) => { reject = fail; }));
    cache.clear();
    const replacement = cache.get("failing", load("replacement", 10));
    release({ value: "stale", weight: 10 });
    reject(new Error("late failure"));
    expect(await pending).toBe("stale");
    await expect(failing).rejects.toThrow("late failure");
    expect(await replacement).toBe("replacement");
    expect(cache.size).toBe(1);
    expect(await cache.get("failing", load("unused", 10))).toBe("replacement");
  });
});
