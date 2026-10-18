import { readFileSync } from "node:fs";

import { initMarkdownEngine, markdownToUnsafeHtml } from "../src/ingest/markdown-engine";
import { hostileInputs, runHostileBenchmark } from "./comrak-wasm/benchmark";

const wasm = new URL("../src/ingest/comrak-engine/comrak_engine_bg.wasm", import.meta.url);
initMarkdownEngine(new WebAssembly.Module(readFileSync(wasm)));
runHostileBenchmark(markdownToUnsafeHtml, hostileInputs, console.log);
