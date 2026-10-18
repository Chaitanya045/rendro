import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { contentPipeline, isDocsAsset } from "../src/ingest/orchestrator/content-pipeline";
import { PageRenderError } from "../src/ingest/orchestrator/pipeline";
import { initNodeMarkdownEngine } from "./helpers/markdown-engine";

const SHA = "a".repeat(40);
const blob = (path: string, size = 10) => ({ path, type: "blob" as const, sha: SHA, size });

beforeAll(() => initNodeMarkdownEngine());

describe("contentPipeline: the #215 modules behind the orchestrator", () => {
  const pipeline = contentPipeline();

  it("delegates detection, config reads, render keys and the sidebar", async () => {
    expect(pipeline).toMatchObject({ rendererVersion: RENDERER_VERSION, maxSourceBytes: 1024 * 1024, maxConfigBytes: 64 * 1024 });
    const entries = [blob("mkdocs.yml"), blob("manual/index.md"), blob("manual/guide.md"), blob("README.md")];
    expect(pipeline.configFilesToRead(entries)).toEqual(["mkdocs.yml"]);
    const detection = pipeline.detect(entries, new Map([["mkdocs.yml", "docs_dir: manual\n"]]));
    expect(detection.primary).toMatchObject({ root: "manual", generator: "mkdocs", entry: "manual/index.md" });
    expect(await pipeline.renderKey(SHA, "manual/index.md")).toMatch(new RegExp(`^render/v${RENDERER_VERSION}/markdown/${SHA}/[0-9a-f]{32}$`));
    expect(pipeline.sidebar(detection.primary as never, new Map([["manual/index.md", "Manual"]]))).toMatchObject({ root: "manual", entry: "manual/index.md" });
  });

  it("renders sanitized HTML with a title and heading outline", () => {
    const rendered = pipeline.render("# Hello\n\n<script>alert(1)</script>\n\n## Next", "docs/a.md");
    expect(rendered.title).toBe("Hello");
    expect(rendered.html).not.toContain("<script");
    expect(rendered.headings).toEqual([
      expect.objectContaining({ depth: 1, text: "Hello" }) as unknown,
      expect.objectContaining({ depth: 2, text: "Next" }) as unknown,
    ]);
  });

  it("turns every RenderError into a per-page failure and lets other errors through", () => {
    const reason = (source: string, path: string) => {
      try {
        pipeline.render(source, path);
        return null;
      } catch (error) {
        return error instanceof PageRenderError ? error.reason : error;
      }
    };
    expect(reason("x".repeat(1024 * 1024 + 1), "a.md")).toBe("too-large");
    expect(reason("<".repeat(50_001), "a.md")).toBe("too-complex");
    expect(reason(`${"<div>".repeat(600)}x`, "a.html")).toBe("too-deep");
    expect(reason("x", "a.txt")).toBeInstanceOf(TypeError);
  });

  it("selects image assets outside vendored and hidden folders", () => {
    for (const path of ["docs/a.png", "docs/b.JPG", "c.svg", "d/e.webp"]) expect(isDocsAsset(path), path).toBe(true);
    for (const path of ["docs/a.css", "docs/a.js", "node_modules/x/a.png", "docs/.cache/a.png", "vendor/a.gif"]) expect(isDocsAsset(path), path).toBe(false);
    expect(pipeline.isAsset("docs/a.png")).toBe(true);
  });
});

describe("contentPipeline: image URL hook (image proxy, #224)", () => {
  const markdown = "![a](https://images.example.com/a.png) ![b](http://img.test/b.gif) ![c](./local.png)";

  it("leaves external images as they are without a hook", () => {
    const html = contentPipeline().render(markdown, "docs/x.md").html;
    expect(html).toContain('src="https://images.example.com/a.png"');
    expect(html).toContain('src="/docs/local.png"');
  });

  it("rewrites external images only, and the sanitizer still checks the result", () => {
    const seen: Array<[string, string]> = [];
    const pipeline = contentPipeline({
      rewriteImageUrl: (url, docPath) => {
        seen.push([url, docPath]);
        if (url.includes("img.test")) return "javascript:alert(1)";
        return `https://camo.rendro.test/i?u=${encodeURIComponent(url)}`;
      },
    });
    const html = pipeline.render(markdown, "docs/x.md").html;
    expect(seen).toEqual([["https://images.example.com/a.png", "docs/x.md"], ["http://img.test/b.gif", "docs/x.md"]]);
    expect(html).toContain('src="https://camo.rendro.test/i?u=https%3A%2F%2Fimages.example.com%2Fa.png"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="/docs/local.png"');
  });

  it("drops a source the hook refuses", () => {
    const html = contentPipeline({ rewriteImageUrl: () => null }).render("![a](https://x.test/a.png)", "a.md").html;
    expect(html).not.toContain("x.test");
    expect(html).toContain("<img");
  });
});

describe("contentPipeline: a crashed Markdown engine", () => {
  afterEach(() => {
    vi.doUnmock("comrak-wasm");
    vi.resetModules();
  });

  it("fails the page that crashed it, then refuses Markdown for the attempt instead of failing good pages", async () => {
    // A fresh module graph is a fresh isolate: the engine starts uninitialized.
    vi.resetModules();
    const markdownToHtml = vi.fn(() => { throw new WebAssembly.RuntimeError("unreachable"); });
    vi.doMock("comrak-wasm", () => ({ initSync: vi.fn(), markdownToHtml }));
    const engine = await import("../src/ingest/markdown-engine");
    const adapter = await import("../src/ingest/orchestrator/content-pipeline");
    const errors = await import("../src/ingest/orchestrator/errors");
    const pipelineModule = await import("../src/ingest/orchestrator/pipeline");
    engine.initMarkdownEngine(new WebAssembly.Module(readFileSync(createRequire(import.meta.url).resolve("comrak-wasm/comrak_wasm_bg.wasm"))));
    const pipeline = adapter.contentPipeline();
    const thrown = (path: string) => { try { pipeline.render("# x", path); return null; } catch (error) { return error; } };
    const first = thrown("a.md");
    expect(first).toBeInstanceOf(pipelineModule.PageRenderError);
    expect(first).toMatchObject({ reason: "engine" });
    const later = thrown("b.md");
    expect(later).toBeInstanceOf(errors.IngestError);
    expect(later).toMatchObject({ reason: "markdown-engine-unavailable", permanent: false });
    // HTML pages need no engine.
    expect(pipeline.render("<h1>ok</h1>", "c.html").title).toBe("ok");
  });

  it("the Worker entry initializes the engine before exporting the Worker", async () => {
    vi.resetModules();
    const module = new WebAssembly.Module(readFileSync(createRequire(import.meta.url).resolve("comrak-wasm/comrak_wasm_bg.wasm")));
    vi.doMock("comrak-wasm/comrak_wasm_bg.wasm", () => ({ default: module }));
    const entry = await import("../src/ingest/orchestrator/entry");
    const worker = await import("../src/ingest/orchestrator/worker");
    expect(entry.default).toBe(worker.default);
    expect(entry.RepoIngestCoordinator).toBe(worker.RepoIngestCoordinator);
    const engine = await import("../src/ingest/markdown-engine");
    expect(engine.markdownToUnsafeHtml("*x*")).toBe("<p><em>x</em></p>\n");
    vi.doUnmock("comrak-wasm/comrak_wasm_bg.wasm");
  });
});
