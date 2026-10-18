// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createFramePreloader, framePrefetchUrl, prefetchPermitted } from "@/lazy-tree/prefetch";

const ORIGIN = "https://rendro.test";

describe("prefetchPermitted", () => {
  it("allows a prefetch when no connection information is available", () => {
    expect(prefetchPermitted(undefined)).toBe(true);
    expect(prefetchPermitted(null)).toBe(true);
    expect(prefetchPermitted({})).toBe(true);
  });

  it("refuses a metered connection", () => {
    expect(prefetchPermitted({ saveData: true })).toBe(false);
    // saveData is checked before effectiveType, so any effectiveType is refused.
    expect(prefetchPermitted({ saveData: true, effectiveType: "4g" })).toBe(false);
  });

  it.each(["slow-2g", "2g", "3g"])("refuses a %s connection", effectiveType => {
    expect(prefetchPermitted({ effectiveType })).toBe(false);
  });

  it.each(["4g", "5g", "unknown"])("allows a %s connection", effectiveType => {
    expect(prefetchPermitted({ effectiveType })).toBe(true);
  });
});

describe("framePrefetchUrl", () => {
  it("resolves a same-origin frame document and drops the fragment", () => {
    expect(framePrefetchUrl("/r/octo/docs/@abc/files/a.md#sec", `${ORIGIN}/shell`, ORIGIN))
      .toBe(`${ORIGIN}/r/octo/docs/@abc/files/a.md`);
    expect(framePrefetchUrl("files/a.md", `${ORIGIN}/r/octo/docs/@abc/`, ORIGIN))
      .toBe(`${ORIGIN}/r/octo/docs/@abc/files/a.md`);
  });

  it.each([
    ["a missing href", undefined],
    ["an empty href", ""],
    ["a non-string href", 7],
    ["an oversized href", `/${"a".repeat(4096)}`],
    ["an unparseable href", "http://["],
    ["another origin", "https://outside.test/files/a.md"],
    ["a protocol-relative other origin", "//outside.test/files/a.md"],
  ])("refuses %s", (_name, href) => {
    expect(framePrefetchUrl(href, `${ORIGIN}/shell`, ORIGIN)).toBeNull();
  });
});

interface Harness {
  host: HTMLElement;
  frames: HTMLIFrameElement[];
  preloader: ReturnType<typeof createFramePreloader>;
  announce: (frame: HTMLIFrameElement) => boolean;
}

function preloader(limit?: number): Harness {
  const host = document.createElement("div");
  document.body.append(host);
  const frames: HTMLIFrameElement[] = [];
  const windows = new Map<HTMLIFrameElement, unknown>();
  const pool = createFramePreloader({
    host: () => host,
    ...(limit === undefined ? {} : { limit }),
    createFrame: () => {
      const frame = document.createElement("iframe");
      windows.set(frame, { frame });
      frames.push(frame);
      return frame;
    },
    windowOf: frame => (windows.get(frame) ?? null) as MessageEventSource | null,
  });
  return { host, frames, preloader: pool, announce: frame => pool.ready(windows.get(frame) as MessageEventSource) };
}

describe("createFramePreloader", () => {
  it("loads a hidden frame for a warmed href and adopts it once it has announced itself", () => {
    const { host, preloader: pool, announce } = preloader();
    pool.warm("/files/a.md", "allow-scripts");
    expect(pool.size).toBe(1);
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("data-preload")).toBe("/files/a.md");
    expect(frame.getAttribute("src")).toBe("/files/a.md");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.style.visibility).toBe("hidden");
    expect(frame.dataset.state).toBeUndefined();
    // A frame that has not spoken is not adopted: a failed navigation still
    // fires `load` on an error page, so silence is the only failure signal.
    expect(pool.take("/files/a.md")).toBeNull();
    expect(pool.size).toBe(0);
    // The cancelled buffer stays in place, emptied, to be reused.
    expect(frame.isConnected).toBe(true);
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.hasAttribute("data-preload")).toBe(false);
    // A cancelled frame never gets adopted, even when it announces later.
    pool.warm("/files/a.md", null);
    const loaded = host.querySelector("iframe")!;
    expect(announce(loaded)).toBe(true);
    expect(loaded.dataset.state).toBe("ready");
    expect(pool.take("/files/a.md")).toBe(loaded);
    expect(pool.size).toBe(0);
    expect(loaded.isConnected).toBe(true);
  });

  it("reuses a freed buffer instead of adding another frame", () => {
    const { host, frames, preloader: pool } = preloader();
    pool.warm("/files/a.md", null);
    pool.take("/files/a.md");
    pool.warm("/files/b.md", null);
    expect(frames).toHaveLength(1);
    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(host.querySelector("iframe")!.getAttribute("data-preload")).toBe("/files/b.md");
  });

  it("never reuses the reader's own content frame", () => {
    const { host, frames, preloader: pool } = preloader();
    const active = document.createElement("iframe");
    active.id = "content-frame";
    active.setAttribute("src", "/files/current.md");
    host.append(active);
    pool.warm("/files/a.md", null);
    expect(frames).toHaveLength(1);
    expect(active.hasAttribute("data-preload")).toBe(false);
    expect(host.querySelectorAll("iframe")).toHaveLength(2);
  });

  it("ignores a repeat, an empty and a non-string href", () => {
    const { host, preloader: pool } = preloader();
    pool.warm("/files/a.md", null);
    pool.warm("/files/a.md", null);
    pool.warm("", null);
    pool.warm(5, null);
    expect(pool.size).toBe(1);
    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    // A frame warmed without a sandbox attribute gets none.
    expect(host.querySelector("iframe")!.hasAttribute("sandbox")).toBe(false);
  });

  it("returns null for a href it is not holding", () => {
    const { preloader: pool } = preloader();
    expect(pool.take("/files/missing.md")).toBeNull();
  });

  it("does not treat a null or unknown window as a preload", () => {
    const { preloader: pool } = preloader();
    pool.warm("/files/a.md", null);
    expect(pool.ready(null)).toBe(false);
    expect(pool.ready({} as unknown as MessageEventSource)).toBe(false);
    expect(pool.size).toBe(1);
  });

  it("keeps only the newest preloads, reusing the oldest frame", () => {
    const { host, frames, preloader: pool } = preloader(2);
    pool.warm("/files/a.md", null);
    pool.warm("/files/b.md", null);
    pool.warm("/files/c.md", null);
    expect(pool.size).toBe(2);
    expect(frames).toHaveLength(2);
    expect(host.querySelectorAll("iframe")).toHaveLength(2);
    expect(host.querySelector('iframe[data-preload="/files/a.md"]')).toBeNull();
    expect(host.querySelector('iframe[data-preload="/files/c.md"]')).not.toBeNull();
  });
});
