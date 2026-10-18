import type { Root } from "hast";

import { splitFrontMatter, stripMdxEsm } from "@/ingest/config-values";
import { documentParts, isElement, textOf } from "@/ingest/hast";
import { highlightCodeBlocks } from "@/ingest/highlight";
import { checkSourceLimits, MAX_INTERMEDIATE_HTML_CHARS, RENDERER_VERSION, RenderError } from "@/ingest/limits";
import { markdownToUnsafeHtml } from "@/ingest/markdown-engine";
import { parseHtmlDocument, parseHtmlFragment } from "@/ingest/parse-html";
import { dirnameOf, extensionOf } from "@/ingest/paths";
import { sanitizeContent, serializeVerified } from "@/ingest/sanitize";
import { assignHeadingIds, convertAlerts, decorateLinksAndImages, proxyExternalImages, rewriteUrls, titleFromHeadings, type Heading } from "@/ingest/transforms";

export type DocumentKind = "markdown" | "mdx" | "html";

const KINDS: Record<string, DocumentKind> = { ".md": "markdown", ".markdown": "markdown", ".mdx": "mdx", ".html": "html", ".htm": "html" };

export function documentKindOf(path: string): DocumentKind | null {
  return KINDS[extensionOf(path)] ?? null;
}

export interface RenderedDocument {
  rendererVersion: number;
  kind: DocumentKind;
  /** Sanitized HTML fragment for the document body. */
  html: string;
  title: string | null;
  headings: Heading[];
}

export interface RenderOptions {
  /**
   * IMAGE_PROXY_SECRET: external images are rewritten to same-origin proxy
   * URLs signed with it (#224). The output depends on the secret but the
   * render key does not, so rotating it must bump RENDERER_VERSION.
   */
  imageProxySecret: string;
}

/**
 * Render one repository file at `path` into sanitized HTML. Pure apart from
 * WebCrypto (image proxy signatures); rejects with RenderError when the file
 * exceeds a limit or its output cannot be proven stable.
 */
export async function renderDocument(source: string, path: string, options: RenderOptions): Promise<RenderedDocument> {
  const kind = documentKindOf(path);
  if (!kind) throw new TypeError(`Not a renderable document: ${path}`);
  checkSourceLimits(source);
  const { tree, title } = kind === "html" ? parseRepoHtml(source) : parseMarkdown(source, kind === "mdx");
  return { rendererVersion: RENDERER_VERSION, kind, ...await finish(tree, path, title, options) };
}

function parseMarkdown(source: string, mdx: boolean): { tree: Root; title: string | null } {
  const { body, title } = splitFrontMatter(source);
  const html = markdownToUnsafeHtml(mdx ? stripMdxEsm(body) : body);
  if (html.length > MAX_INTERMEDIATE_HTML_CHARS) throw new RenderError("Rendered Markdown exceeds the 8 MiB limit", "too-large");
  return { tree: parseHtmlFragment(html), title };
}

function parseRepoHtml(source: string): { tree: Root; title: string | null } {
  const { head, body } = documentParts(parseHtmlDocument(source));
  const titleElement = head.find((child) => isElement(child, "title"));
  const title = titleElement ? textOf(titleElement).replace(/\s+/g, " ").trim() : "";
  return { tree: { type: "root", children: body }, title: title || null };
}

async function finish(tree: Root, path: string, title: string | null, options: RenderOptions): Promise<Pick<RenderedDocument, "html" | "title" | "headings">> {
  rewriteUrls(tree, path);
  const clean = sanitizeContent(tree);
  convertAlerts(clean);
  const headings = assignHeadingIds(clean);
  decorateLinksAndImages(clean);
  highlightCodeBlocks(clean);
  await proxyExternalImages(clean, options.imageProxySecret);
  return { html: serializeVerified(clean), title: title ?? titleFromHeadings(headings), headings };
}

const BLOB_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Storage key for a rendered blob. Output depends on the renderer version, the
 * document kind, the blob and the document's directory (relative links
 * resolve against it), so all four are in the key. An unchanged file in the
 * same directory reuses its render across commits.
 */
export async function renderKey(blobSha: string, path: string): Promise<string> {
  const kind = documentKindOf(path);
  if (!kind || !BLOB_SHA.test(blobSha)) throw new TypeError("renderKey needs a renderable path and a git blob SHA");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dirnameOf(path))));
  const dir = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `render/v${RENDERER_VERSION}/${kind}/${blobSha}/${dir}`;
}
