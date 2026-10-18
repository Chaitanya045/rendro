import { defaultTreeAdapter, html as namespaces, parseFragment, type DefaultTreeAdapterMap } from "parse5";

/*
 * An independent statement of what sanitized ingest output may contain,
 * checked with parse5's stock parser rather than the pipeline's own one. If
 * the sanitizer's schema drifts, these tests fail rather than follow it.
 */
export const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div",
  "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins",
  "kbd", "li", "mark", "ol", "p", "picture", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "span",
  "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul",
  "var", "wbr",
]);

export const ALLOWED_ATTRIBUTES = new Set([
  "align", "dir", "id", "lang", "title", "aria-label", "aria-describedby", "href", "name", "rel", "class",
  "data-footnote-ref", "data-footnote-backref", "data-footnotes", "src", "alt", "width", "height", "loading",
  "decoding", "referrerpolicy", "type", "disabled", "checked", "open", "start", "reversed", "colspan", "rowspan",
  "scope", "abbr",
]);

const SAFE_HREF = /^(?:https?:\/\/[^\s]+|mailto:[^\s]*|\/(?![/\\])[^\s]*|#[^\s]*)$/i;
// Images are same-origin only: repo files, or external images through the signed proxy (/img/).
const SAFE_SRC = /^\/(?![/\\])[^\s]*$/;

type Node = DefaultTreeAdapterMap["node"];

/** Every violation of the output contract, as readable strings; empty means safe. */
export function outputViolations(html: string): string[] {
  const context = defaultTreeAdapter.createElement("body", namespaces.NS.HTML, []);
  const violations: string[] = [];
  const stack: Node[] = [...parseFragment(context, html, {}).childNodes];
  while (stack.length) {
    const node = stack.pop() as Node;
    if (node.nodeName === "#comment") violations.push("comment node");
    if (!("tagName" in node)) continue;
    const tag = node.tagName;
    if (node.namespaceURI !== namespaces.NS.HTML) violations.push(`foreign element <${tag}>`);
    if (!ALLOWED_TAGS.has(tag)) violations.push(`element <${tag}>`);
    for (const { name, value } of node.attrs) {
      if (!ALLOWED_ATTRIBUTES.has(name)) violations.push(`attribute ${name} on <${tag}>`);
      if (name === "href" && !SAFE_HREF.test(value)) violations.push(`href ${JSON.stringify(value)}`);
      if (name === "src" && !SAFE_SRC.test(value)) violations.push(`src ${JSON.stringify(value)}`);
      if ((name === "id" || name === "name" || name === "aria-describedby") && !value.split(/\s+/).every((part) => part.startsWith("user-content-"))) {
        violations.push(`${name} ${JSON.stringify(value)} lacks the user-content- prefix`);
      }
      if (name === "type" && !(tag === "input" && value === "checkbox")) violations.push(`type ${value} on <${tag}>`);
    }
    stack.push(...node.childNodes);
  }
  return violations;
}
