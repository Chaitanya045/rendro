/**
 * Bumping this invalidates every stored render, because it is part of the render key.
 * 2: external images go through the signed image proxy (#224).
 * 3: links and images are emitted relative to the document, so the read path no
 *    longer rewrites them per request (#242); see src/repo-read/frame.ts for the
 *    compatibility shim that still serves version-2 snapshots.
 * 4: task-list checkboxes are named from their item's text and overflowing
 *    `pre`/`table` blocks are keyboard-focusable (#270).
 */
export const RENDERER_VERSION = 4;

/** Larger sources are not rendered; the caller decides how to present them. */
export const MAX_SOURCE_BYTES = 1024 * 1024;
/** Markdown expands (footnote references most of all); cap the HTML handed to the parser. */
export const MAX_INTERMEDIATE_HTML_CHARS = 8 * 1024 * 1024;
/** Counting every '<' bounds tree size before parsing, as share-html does. */
export const MAX_TAG_MARKERS = 50_000;
/** Chromium's tree builder re-parents beyond 512 open elements; reject such trees. */
export const MAX_TREE_DEPTH = 512;
/** Highlighting is skipped for larger blocks, and for code past the per-document budget. */
export const MAX_HIGHLIGHT_BLOCK_CHARS = 64 * 1024;
export const MAX_HIGHLIGHT_DOCUMENT_CHARS = 512 * 1024;

export type RenderErrorReason = "too-large" | "too-complex" | "too-deep" | "unstable" | "engine";

/** A document that cannot be rendered safely within budget. The ingest caller records the failure. */
export class RenderError extends Error {
  constructor(message: string, readonly reason: RenderErrorReason) {
    super(message);
    this.name = "RenderError";
  }
}

export function checkSourceLimits(source: string): void {
  // UTF-16 length is a lower bound for UTF-8 bytes; encode only when it might matter.
  if (source.length > MAX_SOURCE_BYTES || (source.length * 3 > MAX_SOURCE_BYTES && new TextEncoder().encode(source).length > MAX_SOURCE_BYTES)) {
    throw new RenderError("Document exceeds the 1 MiB render limit", "too-large");
  }
  let markers = 0;
  for (let i = source.indexOf("<"); i !== -1; i = source.indexOf("<", i + 1)) {
    if (++markers > MAX_TAG_MARKERS) throw new RenderError("Document exceeds the 50,000 tag marker limit", "too-complex");
  }
}
