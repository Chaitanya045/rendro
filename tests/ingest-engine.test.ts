import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RenderError } from "../src/ingest/limits";
import { TEST_RENDER_OPTIONS } from "./helpers/ingest-render";

/*
 * Each test gets a fresh module graph so the engine's per-isolate state
 * (uninitialized, ready, failed) starts over, as it would in a new isolate.
 */
afterEach(() => {
  vi.doUnmock("comrak-wasm");
  vi.resetModules();
});

const wasm = () => new WebAssembly.Module(readFileSync(createRequire(import.meta.url).resolve("comrak-wasm/comrak_wasm_bg.wasm")));

describe("markdown engine lifecycle", () => {
  it("must be initialized before use, and tolerates repeated initialization", async () => {
    const engine = await import("../src/ingest/markdown-engine");
    expect(() => engine.markdownToUnsafeHtml("x")).toThrow("initMarkdownEngine must be called");
    const module = wasm();
    engine.initMarkdownEngine(module);
    engine.initMarkdownEngine(module);
    expect(engine.markdownToUnsafeHtml("*x*")).toBe("<p><em>x</em></p>\n");
  });

  it("refuses all further work after the engine fails", async () => {
    const markdownToHtml = vi.fn(() => { throw new WebAssembly.RuntimeError("unreachable"); });
    vi.doMock("comrak-wasm", () => ({ initSync: vi.fn(), markdownToHtml }));
    const engine = await import("../src/ingest/markdown-engine");
    const { renderDocument } = await import("../src/ingest/render");
    engine.initMarkdownEngine(wasm());
    const reason = (action: () => unknown) => { try { action(); return null; } catch (error) { return error instanceof Error && "reason" in error ? (error as RenderError).reason : error; } };
    await expect(renderDocument("# x", "a.md", TEST_RENDER_OPTIONS)).rejects.toMatchObject({ reason: "engine" });
    expect(reason(() => engine.markdownToUnsafeHtml("y"))).toBe("engine");
    // HTML documents do not use the engine and still render.
    expect((await renderDocument("<p>ok</p>", "a.html", TEST_RENDER_OPTIONS)).html).toBe("<p>ok</p>");
    expect(markdownToHtml).toHaveBeenCalledTimes(1);
  });
});
