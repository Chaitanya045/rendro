/**
 * The content step ingest calls for each commit: detect the docs, render each
 * page, build the sidebar. `contentPipeline()` (content-pipeline.ts) adapts the
 * pure modules of #215 (src/ingest/detect.ts, render.ts, sidebar.ts); tests
 * substitute their own to inject failures.
 */

/** A recursive tree entry, as #215's detectDocs takes it. */
export interface PipelineTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface PipelineDocSet {
  /** Repo path of the docs root; "" is the repository root. */
  root: string;
  generator: string;
  signal: string;
  kind: string;
  entry: string;
  /** Renderable pages under the root, sorted by path. */
  pages: string[];
  truncated: boolean;
}

export interface PipelineDetection {
  primary: PipelineDocSet | null;
  docSets: PipelineDocSet[];
}

export interface RenderedPage {
  /** Sanitized HTML for the page body. */
  html: string;
  title: string | null;
  /** Heading outline (ids and text) for the table of contents and comment anchors. */
  headings?: unknown[];
}

export interface ContentPipeline {
  /** Part of every render and snapshot key, so a renderer change rebuilds cleanly. */
  readonly rendererVersion: number;
  /** Pages larger than this are recorded as too large without being fetched. */
  readonly maxSourceBytes: number;
  readonly maxConfigBytes: number;
  /** Small config files (mkdocs.yml, book.toml, ...) detection needs to read. */
  configFilesToRead(entries: readonly PipelineTreeEntry[]): string[];
  detect(entries: readonly PipelineTreeEntry[], configs: ReadonlyMap<string, string>): PipelineDetection;
  /** Storage key (below the repo prefix) of a page's rendered output. */
  renderKey(blobSha: string, path: string): Promise<string>;
  /** Render one page. Throws PageRenderError for an expected per-page failure. */
  render(source: string, path: string): RenderedPage;
  /** Non-page files under the docs root that the viewer serves (images, stylesheets, fonts). */
  isAsset(path: string): boolean;
  sidebar(docSet: PipelineDocSet, titles: ReadonlyMap<string, string | null>): unknown;
}

/** A page that cannot be rendered (too large, too complex). The snapshot records it and carries on. */
export class PageRenderError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "PageRenderError";
  }
}
