/**
 * The ingest Worker's main module (wrangler.ingest.toml). Wrangler bundles the
 * comrak WebAssembly module; it is instantiated once per isolate before any render.
 */
import comrakEngine from "../comrak-engine/comrak_engine_bg.wasm";
import { initMarkdownEngine } from "../markdown-engine";

initMarkdownEngine(comrakEngine);

export { default, RepoIngestCoordinator } from "./worker";
