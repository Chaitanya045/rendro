import { configFilesToRead, detectDocs, MAX_CONFIG_BYTES } from "../detect";
import { MAX_SOURCE_BYTES, RENDERER_VERSION, RenderError } from "../limits";
import { markdownEngineFailed } from "../markdown-engine";
import { renderDocument, renderKey, type RenderOptions } from "../render";
import { buildSidebar } from "../sidebar";
import { IngestError } from "./errors";
import { PageRenderError, type ContentPipeline } from "./pipeline";

export interface ContentPipelineOptions {
  /** External image rewrite: the image proxy (#224). See RenderOptions.rewriteImageUrl. */
  rewriteImageUrl?: RenderOptions["rewriteImageUrl"];
}

/**
 * Images are the only non-page files rendered docs reference: the sanitizer
 * strips stylesheets, scripts and media elements.
 */
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;
const IGNORED = new Set(["node_modules", "vendor", "third_party", "bower_components", "jspm_packages"]);

export function isDocsAsset(path: string): boolean {
  return ASSET.test(path) && path.split("/").every((segment) => !IGNORED.has(segment) && !segment.startsWith("."));
}

/**
 * The #215 content pipeline behind the orchestrator's ContentPipeline. The
 * Markdown engine must be initialized once per isolate first (the ingest
 * Worker's entry module does it).
 *
 * Every RenderError is a property of the file and becomes a per-page failure,
 * except one: after comrak crashes, the isolate refuses all further Markdown.
 * The page that crashed it is recorded as failed (reason `engine`); later
 * pages fail the attempt instead, so it is retried rather than marking pages
 * that are fine as broken.
 */
export function contentPipeline(options: ContentPipelineOptions = {}): ContentPipeline {
  const renderOptions: RenderOptions = options.rewriteImageUrl ? { rewriteImageUrl: options.rewriteImageUrl } : {};
  return {
    rendererVersion: RENDERER_VERSION,
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxConfigBytes: MAX_CONFIG_BYTES,
    configFilesToRead,
    detect: (entries, configs) => detectDocs(entries, { configs }),
    renderKey,
    async render(source, path) {
      const engineWasDown = markdownEngineFailed();
      try {
        const rendered = await renderDocument(source, path, renderOptions);
        return { html: rendered.html, title: rendered.title, headings: rendered.headings };
      } catch (error) {
        if (!(error instanceof RenderError)) throw error;
        if (error.reason === "engine" && engineWasDown) {
          throw new IngestError("markdown-engine-unavailable", "The Markdown engine failed earlier in this isolate", false);
        }
        throw new PageRenderError(error.message, error.reason);
      }
    },
    isAsset: isDocsAsset,
    sidebar: (docSet, titles) => buildSidebar(docSet, titles),
  };
}
