import type { Root } from "hast";
import { sanitize, type Schema } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";

import { walkElements } from "@/ingest/hast";
import { RenderError } from "@/ingest/limits";
import { parseHtmlFragment } from "@/ingest/parse-html";
import { USER_CONTENT_PREFIX } from "@/ingest/paths";

/*
 * The security boundary for repository content. Markdown output and repo HTML
 * are parsed by parse5 (a spec-compliant HTML tree builder) into hast, then
 * filtered by an explicit allowlist. Nothing is filtered as a string.
 *
 * Two schemas:
 * - `contentSchema` applies to author content. Ids and names get the
 *   `user-content-` prefix so they cannot clobber DOM globals the viewer's
 *   scripts rely on.
 * - `outputSchema` adds the classes and attributes the trusted transforms emit
 *   (highlighting, alerts, link and image attributes). The serialized result
 *   must be a fixed point of parse -> sanitize(outputSchema) -> serialize.
 *   That catches mutation-XSS-style parser differentials, and any transform
 *   that emits something the allowlist does not permit.
 */

/** Removed with their content. Every other unknown element is unwrapped and its children kept. */
const STRIP = [
  "applet", "audio", "base", "basefont", "bgsound", "canvas", "datalist", "embed", "frame", "frameset",
  "head", "iframe", "link", "map", "math", "meta", "noembed", "noframes", "noscript", "object", "optgroup", "option",
  "param", "plaintext", "portal", "script", "select", "style", "svg", "template", "textarea", "title", "video", "xmp",
];

const TAG_NAMES = [
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div",
  "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins",
  "kbd", "li", "mark", "ol", "p", "picture", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "span",
  "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul",
  "var", "wbr",
];

/** Table parts outside a table would be dropped or re-parented by the browser's parser. */
const ANCESTORS: Schema["ancestors"] = Object.fromEntries(
  ["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"].map((tag) => [tag, ["table"]]),
);

const LANGUAGE_CLASS = /^language-[\w#+.-]{1,64}$/;
const prefixed = new RegExp(`^${USER_CONTENT_PREFIX}`);

type Attributes = NonNullable<Schema["attributes"]>;

const LINK_ATTRIBUTES: Attributes[string] = ["href", "dataFootnoteRef", "dataFootnoteBackref", ["className", "footnote-backref"]];
const IMAGE_ATTRIBUTES: Attributes[string] = ["src", "alt", "width", "height"];

const contentAttributes: Attributes = {
  "*": ["align", "dir", "id", "lang", "title", "ariaLabel"],
  a: [...LINK_ATTRIBUTES, "name", "ariaDescribedBy"],
  code: [["className", LANGUAGE_CLASS]],
  details: ["open"],
  h2: [["className", "sr-only"]],
  img: IMAGE_ATTRIBUTES,
  input: [["type", "checkbox"], ["disabled", true], "checked"],
  li: [["className", "task-list-item"]],
  ol: ["start", "reversed", ["className", "contains-task-list"]],
  section: ["dataFootnotes", ["className", "footnotes"]],
  sup: [["className", "footnote-ref"]],
  td: ["colSpan", "rowSpan"],
  th: ["colSpan", "rowSpan", "scope", "abbr"],
  ul: [["className", "contains-task-list"]],
};

const base: Schema = {
  allowComments: false,
  allowDoctypes: false,
  ancestors: ANCESTORS,
  protocols: { href: ["http", "https", "mailto"], src: ["http", "https"] },
  required: { input: { type: "checkbox", disabled: true } },
  strip: STRIP,
  tagNames: TAG_NAMES,
};

export const contentSchema: Schema = {
  ...base,
  attributes: contentAttributes,
  clobber: ["ariaDescribedBy", "id", "name"],
  clobberPrefix: USER_CONTENT_PREFIX,
};

export const outputSchema: Schema = {
  ...base,
  attributes: {
    ...contentAttributes,
    "*": ["align", "dir", ["id", prefixed], "lang", "title", "ariaLabel"],
    a: [...LINK_ATTRIBUTES, ["name", prefixed], ["ariaDescribedBy", prefixed], ["rel", "nofollow", "noopener", "noreferrer"]],
    code: [["className", LANGUAGE_CLASS, "hljs"]],
    div: [["className", "markdown-alert", /^markdown-alert-(?:note|tip|important|warning|caution)$/]],
    // Only root-relative sources: repo files and the signed image proxy. No external host survives.
    img: [["src", /^\/(?![/\\])/], "alt", "width", "height", ["loading", "lazy"], ["decoding", "async"], ["referrerPolicy", "no-referrer"]],
    p: [["className", "markdown-alert-title"]],
    // highlight.js emits hljs-<scope> plus sub-scope classes such as "function_".
    span: [["className", /^hljs-[a-z][a-z0-9-]{0,40}$/, /^[a-z][a-z0-9]{0,40}_+$/]],
  },
  clobber: [],
};

export function sanitizeContent(tree: Root): Root {
  return sanitize(tree, contentSchema) as Root;
}

function outputPass(tree: Root): string {
  const clean = sanitize(tree, outputSchema) as Root;
  // Removing every disallowed class leaves an empty list, which would serialize as class="".
  walkElements(clean, (node) => {
    if (Array.isArray(node.properties.className) && !node.properties.className.length) delete node.properties.className;
  });
  return toHtml(clean);
}

/**
 * Serialize transformed content and prove the HTML is stable: parsing it
 * again and re-applying the allowlist must reproduce it byte for byte.
 */
export function serializeVerified(tree: Root): string {
  // The viewer places the fragment in <body>, so it is re-parsed in that context.
  return stabilize(outputPass(tree), (html) => outputPass(parseHtmlFragment(html)));
}

/** Re-run `pass` until it returns its input. Fail closed if it never settles. */
export function stabilize(html: string, pass: (html: string) => string, maxPasses = 3): string {
  let current = html;
  for (let i = 0; i < maxPasses; i++) {
    const next = pass(current);
    if (next === current) return current;
    current = next;
  }
  throw new RenderError("Sanitized output did not reach a stable form", "unstable");
}
