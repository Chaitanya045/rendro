import type { Element, Root } from "hast";
import GithubSlugger from "github-slugger";

import { imageProxyPath } from "@/image-proxy";
import { element, isElement, textOf, walkElements } from "@/ingest/hast";
import { rewriteUrl, USER_CONTENT_PREFIX } from "@/ingest/paths";

export interface Heading {
  depth: number;
  text: string;
  /** GitHub's slug for the heading text, as used in `#fragment` links. */
  slug: string;
  /** The element id: the slug with the user-content- prefix. Absent when the slug is empty. */
  id: string | null;
}

/**
 * Runs on the untrusted tree before sanitization. It resolves link and image
 * URLs against the document's repo path and drops any it cannot resolve
 * safely. The sanitizer then checks protocols again.
 */
export function rewriteUrls(tree: Root, docPath: string): void {
  walkElements(tree, (node) => {
    for (const [key, context] of [["href", "href"], ["src", "src"]] as const) {
      const value = node.properties[key];
      if (value === undefined || value === null) continue;
      const rewritten = typeof value === "string" ? rewriteUrl(value, docPath, context) : null;
      if (rewritten === null) delete node.properties[key];
      else node.properties[key] = rewritten;
    }
  });
}

const HEADING = /^h([1-6])$/;

/**
 * Give headings GitHub-compatible ids: github-slugger over the text, with -1,
 * -2 suffixes for repeats, prefixed like every other sanitized id. An id the
 * author set is kept, but its heading still takes a slug, so later repeats
 * are numbered the way GitHub numbers them.
 */
export function assignHeadingIds(tree: Root): Heading[] {
  const slugger = new GithubSlugger();
  const headings: Heading[] = [];
  walkElements(tree, (node) => {
    if (node.tagName === "section" && node.properties.dataFootnotes !== undefined) return "skip";
    const depth = HEADING.exec(node.tagName)?.[1];
    if (!depth) return;
    const text = textOf(node).replace(/\s+/g, " ").trim();
    const slug = slugger.slug(text);
    if (typeof node.properties.id !== "string" && slug) node.properties.id = USER_CONTENT_PREFIX + slug;
    const id = node.properties.id;
    headings.push({ depth: Number(depth), text, slug, id: typeof id === "string" ? id : null });
    return "skip";
  });
  return headings;
}

const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;
const ALERT_TITLES = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" } as const;

/** GitHub alerts: a top-level blockquote whose first line is exactly `[!TYPE]`. */
export function convertAlerts(tree: Root): void {
  for (const node of tree.children) {
    if (!isElement(node, "blockquote")) continue;
    const paragraph = node.children.find((child) => child.type !== "text" || child.value.trim() !== "");
    if (!isElement(paragraph, "p")) continue;
    const [first] = paragraph.children;
    if (first?.type !== "text") continue;
    const match = ALERT.exec(first.value);
    if (!match) continue;
    const type = (match[1]).toLowerCase() as keyof typeof ALERT_TITLES;
    first.value = first.value.slice(match[0].length);
    if (!first.value) paragraph.children.shift();
    if (!paragraph.children.length) node.children.splice(node.children.indexOf(paragraph), 1);
    node.tagName = "div";
    node.properties = { className: ["markdown-alert", `markdown-alert-${type}`] };
    node.children.unshift(element("p", { className: ["markdown-alert-title"] }, [{ type: "text", value: ALERT_TITLES[type] }]));
  }
}

/** Fixed attributes on sanitized links and images; the output schema allows exactly these. */
export function decorateLinksAndImages(tree: Root): void {
  walkElements(tree, (node: Element) => {
    if (node.tagName === "a" && typeof node.properties.href === "string" && /^https?:/.test(node.properties.href)) {
      node.properties.rel = ["nofollow", "noopener", "noreferrer"];
    } else if (node.tagName === "img") {
      Object.assign(node.properties, { loading: "lazy", decoding: "async", referrerPolicy: "no-referrer" });
    }
  });
}

/**
 * Runs on the sanitized tree. Every external image becomes a signed
 * same-origin proxy path (src/image-proxy.ts), so a reader's browser never
 * requests a third-party host. An image that cannot be proxied (a blocked
 * target or an overlong URL) loses its src. Repo-relative images are already
 * same-origin. The output schema accepts only root-relative image sources.
 */
export async function proxyExternalImages(tree: Root, secret: string): Promise<void> {
  const images: Array<{ node: Element; src: string }> = [];
  walkElements(tree, (node) => {
    const src = node.properties.src;
    if (node.tagName === "img" && typeof src === "string" && /^https?:/.test(src)) images.push({ node, src });
  });
  const paths = new Map<string, Promise<string | null>>();
  for (const { src } of images) if (!paths.has(src)) paths.set(src, imageProxyPath(secret, src));
  for (const { node, src } of images) {
    const path = await paths.get(src);
    if (path) node.properties.src = path;
    else delete node.properties.src;
  }
}

/** First h1, else the first heading of any level. */
export function titleFromHeadings(headings: Heading[]): string | null {
  const heading = headings.find((candidate) => candidate.depth === 1) ?? headings[0];
  return heading?.text || null;
}
