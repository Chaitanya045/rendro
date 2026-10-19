/**
 * Anchors for comments on repository docs (#254): `(blobSha, headingSlug,
 * textQuote{prefix, exact, suffix}, offset)` inside the rendered page. A page's
 * sections run from one heading (ingest's `user-content-<slug>` ids, #215) to
 * the next; text before the first heading is the section with slug "". A
 * heading without an id cannot be named, so it does not start a section.
 *
 * Finding an anchor again never guesses:
 * - The section must still exist.
 * - On the blob the comment was made on, the quote must sit exactly at its offset.
 * - Otherwise (a new commit changed the page, or the offset is wrong) the quote is
 *   searched in that section: exactly one occurrence with its full prefix and
 *   suffix wins; failing that, the only occurrence of the quote at all; anything
 *   else is no match.
 * No match means orphaned: listed in the drawer, never pinned to other text.
 * Anchors are untrusted data, so every outcome is one of these checks.
 */

export type RepoAnchor = {
  kind: "repo-text";
  blobSha: string;
  headingSlug: string;
  prefix: string;
  exact: string;
  suffix: string;
  offset: number;
};

export const QUOTE_CONTEXT = 32;
export const MAX_QUOTE_LENGTH = 4_096;
const HEADING = /^H[1-6]$/;
const SLUG_PREFIX = "user-content-";

type Section = { slug: string; start: Node; text: string; nodes: Array<{ node: Text; at: number }> };

/** The rendered page's sections, in document order. The page is static, so callers may keep the result. */
export function pageSections(root: Element): Section[] {
  const sections: Section[] = [{ slug: "", start: root, text: "", nodes: [] }];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      // A heading without an id (emoji-only, as on GitHub) cannot be named, so it stays in the section before it.
      if (HEADING.test(element.tagName) && element.id) sections.push({ slug: element.id.startsWith(SLUG_PREFIX) ? element.id.slice(SLUG_PREFIX.length) : element.id, start: element, text: "", nodes: [] });
      continue;
    }
    const section = sections[sections.length - 1];
    section.nodes.push({ node: node as Text, at: section.text.length });
    section.text += (node as Text).data;
  }
  return sections;
}

/** The section a node is in: the last heading at or before it, or the text before the first heading. */
function sectionOf(root: Element, sections: Section[], node: Node): Section | null {
  if (!root.contains(node)) return null;
  for (let index = sections.length - 1; index > 0; index -= 1) {
    const { start } = sections[index];
    if (start === node || start.contains(node) || (start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return sections[index];
  }
  return sections[0];
}

/** The node a boundary point falls on: the text node itself, else the child after (start) or before (end) it. */
function boundaryNode(container: Node, offset: number, end: boolean): Node {
  if (container.nodeType === Node.TEXT_NODE) return container;
  return container.childNodes[end ? offset - 1 : offset] ?? container;
}

/** A boundary point's offset in its section's text. */
function offsetIn(section: Section, container: Node, offset: number): number {
  const range = container.ownerDocument!.createRange();
  if (section.slug === "") range.setStart(section.start, 0);
  else range.setStartBefore(section.start);
  range.setEnd(container, offset);
  return range.toString().length;
}

/** The anchor for a selection inside `root`, or null when it is empty, too long or crosses a heading. */
export function repoAnchorFor(root: Element, sections: Section[], range: Range, blobSha: string): RepoAnchor | null {
  const section = sectionOf(root, sections, boundaryNode(range.startContainer, range.startOffset, false));
  if (!section || sectionOf(root, sections, boundaryNode(range.endContainer, range.endOffset, true)) !== section) return null;
  const start = offsetIn(section, range.startContainer, range.startOffset);
  const end = offsetIn(section, range.endContainer, range.endOffset);
  const exact = section.text.slice(start, end);
  if (!exact.trim() || exact.length > MAX_QUOTE_LENGTH) return null;
  return {
    kind: "repo-text", blobSha, headingSlug: section.slug, exact, offset: start,
    prefix: section.text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
    suffix: section.text.slice(end, end + QUOTE_CONTEXT),
  };
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) found.push(index);
  return found;
}

/** Where the anchor's quote is in its section now, or null (orphaned). */
export function locateRepoAnchor(sections: Section[], anchor: RepoAnchor, blobSha: string): { section: Section; start: number } | null {
  // Slug "" is only ever the text before the first heading, never a heading without an id.
  const section = anchor.headingSlug === "" ? sections[0] : sections.find(candidate => candidate.slug === anchor.headingSlug && candidate !== sections[0]);
  if (!section || !anchor.exact) return null;
  const { text } = section;
  if (anchor.blobSha === blobSha && text.startsWith(anchor.exact, anchor.offset)) return { section, start: anchor.offset };
  const all = occurrences(text, anchor.exact);
  const end = (index: number) => index + anchor.exact.length;
  const contextual = all.filter(index => text.slice(Math.max(0, index - anchor.prefix.length), index) === anchor.prefix
    && text.slice(end(index), end(index) + anchor.suffix.length) === anchor.suffix);
  if (contextual.length === 1) return { section, start: contextual[0] };
  if (contextual.length === 0 && all.length === 1) return { section, start: all[0] };
  return null;
}

/** A DOM range over `[start, start + length)` of a section's text. */
export function sectionRange(section: Section, start: number, length: number): Range | null {
  const at = (position: number, edge: "start" | "end") => {
    for (const entry of section.nodes) {
      const inside = edge === "start" ? position < entry.at + entry.node.data.length : position <= entry.at + entry.node.data.length;
      if (position >= entry.at && inside) return { node: entry.node, offset: position - entry.at };
    }
    return null;
  };
  const from = at(start, "start");
  const to = at(start + length, "end");
  if (!from || !to) return null;
  const range = from.node.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** Shape check for an anchor arriving over the parent protocol (drafts and creates). */
export function validRepoAnchor(value: Record<string, unknown>): boolean {
  return value.kind === "repo-text"
    && typeof value.blobSha === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.blobSha)
    && typeof value.headingSlug === "string" && value.headingSlug.length <= 256 && !/\s/.test(value.headingSlug)
    && typeof value.exact === "string" && Boolean(value.exact.trim()) && value.exact.length <= MAX_QUOTE_LENGTH
    && typeof value.prefix === "string" && value.prefix.length <= 64
    && typeof value.suffix === "string" && value.suffix.length <= 64
    && Number.isSafeInteger(value.offset) && (value.offset as number) >= 0 && (value.offset as number) <= 10_000_000;
}
