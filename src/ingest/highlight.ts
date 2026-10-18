import type { ElementContent, Root } from "hast";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import haskell from "highlight.js/lib/languages/haskell";
import nginx from "highlight.js/lib/languages/nginx";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import scala from "highlight.js/lib/languages/scala";
import { common, createLowlight } from "lowlight";

import { classList, isElement, textOf, walkElements } from "@/ingest/hast";
import { MAX_HIGHLIGHT_BLOCK_CHARS, MAX_HIGHLIGHT_DOCUMENT_CHARS } from "@/ingest/limits";

/*
 * highlight.js (through lowlight, which emits hast) writes only `hljs-*`
 * classes. The output needs no inline styles, so it works under a strict CSP;
 * HIGHLIGHT_CSS supplies the colours. A fence is highlighted only when its
 * language is named and known. There is no auto-detection, which is slow and
 * often wrong.
 */
let lowlight: ReturnType<typeof createLowlight> | undefined;

function highlighter(): ReturnType<typeof createLowlight> {
  if (!lowlight) {
    lowlight = createLowlight(common);
    lowlight.register({ dart, dockerfile, elixir, haskell, nginx, powershell, protobuf, scala });
    lowlight.registerAlias({ markdown: ["mdx"] });
  }
  return lowlight;
}

export function highlightCodeBlocks(tree: Root): void {
  const engine = highlighter();
  let budget = MAX_HIGHLIGHT_DOCUMENT_CHARS;
  walkElements(tree, (pre) => {
    if (pre.tagName !== "pre") return;
    const [code] = pre.children;
    if (pre.children.length !== 1 || !isElement(code, "code")) return "skip";
    const language = classList(code).find((name) => name.startsWith("language-"))?.slice("language-".length).toLowerCase();
    if (!language || !engine.registered(language)) return "skip";
    const text = textOf(code);
    if (text.length > MAX_HIGHLIGHT_BLOCK_CHARS || text.length > budget) return "skip";
    budget -= text.length;
    code.children = engine.highlight(language, text).children as ElementContent[];
    code.properties.className = [...classList(code), "hljs"];
    return "skip";
  });
}
