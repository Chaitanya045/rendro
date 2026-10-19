import type { Nodes, Root } from "hast";

import { isElement, textOf } from "@/ingest/hast";
import { parseHtmlFragment } from "@/ingest/parse-html";

/**
 * One searchable slice of a rendered page (#251): the text under a heading, or
 * the preamble before the first heading. `slug` is the element id used by a
 * `#fragment` link (the `user-content-` prefixed GitHub slug), or "" when the
 * section has no anchor.
 */
export interface PageSection {
  slug: string;
  title: string;
  text: string;
}

export interface SectionOptions {
  /** A page never contributes more than this many sections. */
  maxSections?: number;
  /** Each section's stored text is capped here. */
  maxTextChars?: number;
  /** A heading's stored title is capped here. */
  maxTitleChars?: number;
  /** The page's stored text across all sections is capped here. */
  maxPageChars?: number;
}

const DEFAULTS = { maxSections: 256, maxTextChars: 8_000, maxTitleChars: 512, maxPageChars: 200_000 };
const HEADING = /^h[1-6]$/;
// The `section[data-footnotes]` block is reference list markup, not prose; the
// renderer already assigns ids in it, but it must not become search results.
const WHITESPACE = /\s+/g;
// eslint-disable-next-line no-control-regex -- the index must not store control code points.
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** Collapse whitespace and strip control characters, so `\u0002`/`\u0003` stay reserved for snippets. */
function clean(value: string, limit: number): string {
  return value.replace(CONTROL, " ").replace(WHITESPACE, " ").trim().slice(0, limit);
}

/**
 * Split a rendered (already sanitized, heading ids assigned) tree into
 * document-order sections. Pre-order traversal, so a heading nested in a
 * blockquote or list still starts a section.
 */
export function extractSections(tree: Root, options: SectionOptions = {}): PageSection[] {
  const maxSections = options.maxSections ?? DEFAULTS.maxSections;
  const maxTextChars = options.maxTextChars ?? DEFAULTS.maxTextChars;
  const maxTitleChars = options.maxTitleChars ?? DEFAULTS.maxTitleChars;
  const maxPageChars = options.maxPageChars ?? DEFAULTS.maxPageChars;

  const sections: PageSection[] = [];
  let current: { slug: string; title: string; chunks: string[] } = { slug: "", title: "", chunks: [] };
  let total = 0;

  const flush = () => {
    const text = clean(current.chunks.join(""), maxTextChars);
    if (sections.length < maxSections && (current.title || text)) sections.push({ slug: current.slug, title: current.title, text });
    current = { slug: "", title: "", chunks: [] };
  };

  const stack: Nodes[] = [...tree.children].reverse();
  while (stack.length && sections.length < maxSections && total < maxPageChars) {
    const node = stack.pop() as Nodes;
    if (node.type === "text") {
      const value = node.value.slice(0, maxPageChars - total);
      if (value) {
        current.chunks.push(value);
        total += value.length;
      }
      continue;
    }
    if (isElement(node)) {
      if (node.tagName === "section" && node.properties.dataFootnotes !== undefined) continue;
      if (HEADING.test(node.tagName)) {
        flush();
        const id = node.properties.id;
        current = { slug: typeof id === "string" ? id : "", title: clean(textOf(node), maxTitleChars), chunks: [] };
        continue;
      }
    }
    if ("children" in node) for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
  flush();

  // Anchor ids are already unique per page, except the preamble and headings
  // whose slug was empty. Key rows by (blob, slug), so make those unique too.
  const seen = new Map<string, number>();
  for (const section of sections) {
    const count = seen.get(section.slug) ?? 0;
    seen.set(section.slug, count + 1);
    if (count > 0) section.slug = section.slug ? `${section.slug}-${count + 1}` : `section-${count + 1}`;
  }
  return sections;
}

/** Sections of a stored rendered fragment (the reuse path never has the tree). */
export function sectionsFromHtml(html: string, options: SectionOptions = {}): PageSection[] {
  return extractSections(parseHtmlFragment(html), options);
}
