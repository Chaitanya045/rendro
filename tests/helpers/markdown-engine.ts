import { readFileSync } from "node:fs";

import { initMarkdownEngine } from "@/ingest/markdown-engine";

/** Node compiles the comrak module from disk; the Worker imports it as a WebAssembly.Module. */
export function initNodeMarkdownEngine(): void {
  initMarkdownEngine(new WebAssembly.Module(readFileSync(new URL("../../src/ingest/comrak-engine/comrak_engine_bg.wasm", import.meta.url))));
}
