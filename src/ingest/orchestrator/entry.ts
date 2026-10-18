/**
 * The ingest Worker's main module (wrangler.ingest.toml). Wrangler bundles the
 * comrak binary as a WebAssembly.Module; it is instantiated once per isolate
 * before any render.
 */
import comrak from "comrak-wasm/comrak_wasm_bg.wasm";
import { initMarkdownEngine } from "../markdown-engine";

initMarkdownEngine(comrak);

export { default, RepoIngestCoordinator } from "./worker";
