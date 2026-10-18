import { initSync, markdownToHtml } from "comrak-wasm";

import { RenderError } from "@/ingest/limits";

/*
 * comrak is a Rust port of cmark-gfm, the renderer GitHub uses. It is run
 * as WebAssembly. Its only imports are wasm-bindgen's value-marshalling
 * helpers for the options object below, so it has no ambient authority.
 * Raw HTML is passed through (`unsafe`) on purpose: the output is untrusted
 * and goes to the parse5 + allowlist sanitizer next, which is the security
 * boundary. Heading ids and alerts are added after sanitizing, in transforms.ts.
 */
const OPTIONS = {
  extension: { strikethrough: true, table: true, autolink: true, tasklist: true, footnotes: true },
  render: { unsafe: true, tasklistClasses: true },
};

let state: "uninitialized" | "ready" | "failed" = "uninitialized";

/**
 * Instantiate comrak from its compiled module. Workers import
 * `comrak-wasm/comrak_wasm_bg.wasm` as a WebAssembly.Module; Node compiles the file.
 */
export function initMarkdownEngine(module: WebAssembly.Module): void {
  initSync({ module });
  if (state === "uninitialized") state = "ready";
}

export function markdownToUnsafeHtml(markdown: string): string {
  if (state === "uninitialized") throw new Error("initMarkdownEngine must be called before rendering Markdown");
  if (state === "failed") throw new RenderError("The Markdown engine failed earlier in this isolate", "engine");
  try {
    return markdownToHtml(markdown, OPTIONS);
  } catch {
    // A Rust panic leaves the instance in an undefined state, and wasm-bindgen
    // cannot instantiate a second copy. Refuse further work in this isolate.
    state = "failed";
    throw new RenderError("The Markdown engine failed", "engine");
  }
}
