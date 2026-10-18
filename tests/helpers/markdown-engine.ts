import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { initMarkdownEngine } from "@/ingest/markdown-engine";

/** Node compiles the comrak module from disk; the Worker imports it as a WebAssembly.Module. */
export function initNodeMarkdownEngine(): void {
  const require = createRequire(import.meta.url);
  initMarkdownEngine(new WebAssembly.Module(readFileSync(require.resolve("comrak-wasm/comrak_wasm_bg.wasm"))));
}
