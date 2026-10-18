import { initSync, markdownToHtml } from "./comrak-engine/comrak_engine.js";

import { RenderError } from "@/ingest/limits";

/*
 * comrak is a Rust port of cmark-gfm, the renderer GitHub uses. Rather than a
 * third-party npm package, it is run as WebAssembly built from the upstream
 * `comrak` crate by `wasm/comrak-engine` (pinned; see docs/TECHNICAL.md). The
 * build exposes one renderer with the fixed options Rendro uses — the GFM
 * extensions, raw-HTML passthrough (`unsafe`) and task-list classes — and its
 * only imports are wasm-bindgen value-marshalling helpers, so it has no ambient
 * authority. Raw HTML is passed through (`unsafe`) on purpose: the output is
 * untrusted and goes to the parse5 + allowlist sanitizer next, which is the
 * security boundary. Heading ids and alerts are added after sanitizing, in
 * transforms.ts.
 */

let state: "uninitialized" | "ready" | "failed" = "uninitialized";

/**
 * Instantiate comrak from its compiled module. Workers import the committed
 * `comrak-engine/comrak_engine_bg.wasm` as a WebAssembly.Module; Node compiles the file.
 */
export function initMarkdownEngine(module: WebAssembly.Module): void {
  initSync({ module });
  if (state === "uninitialized") state = "ready";
}

/** True once comrak has crashed in this isolate; every later Markdown render is refused. */
export function markdownEngineFailed(): boolean {
  return state === "failed";
}

export function markdownToUnsafeHtml(markdown: string): string {
  if (state === "uninitialized") throw new Error("initMarkdownEngine must be called before rendering Markdown");
  if (state === "failed") throw new RenderError("The Markdown engine failed earlier in this isolate", "engine");
  try {
    return markdownToHtml(markdown);
  } catch {
    // A Rust panic leaves the instance in an undefined state, and wasm-bindgen
    // cannot instantiate a second copy. Refuse further work in this isolate.
    state = "failed";
    throw new RenderError("The Markdown engine failed", "engine");
  }
}
