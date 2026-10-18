import type { Root } from "hast";
import { describe, expect, it } from "vitest";

import { detectDocs } from "../src/ingest/detect";
import { textOf, walkElements } from "../src/ingest/hast";
import { RenderError } from "../src/ingest/limits";
import { MAX_PARSE_WORK, parseHtmlDocument, parseHtmlFragment } from "../src/ingest/parse-html";
import { compareCodeUnits } from "../src/ingest/paths";
import { buildSidebar, naturalCompare } from "../src/ingest/sidebar";
import { rewriteUrls } from "../src/ingest/transforms";
import { tree } from "./fixtures/ingest/repo-layouts";

describe("hast helpers", () => {
  it("collects text without recursing, ignoring comments", () => {
    const root: Root = { type: "root", children: [{ type: "comment", value: "c" }, { type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "a" }, { type: "element", tagName: "b", properties: {}, children: [{ type: "text", value: "b" }] }] }] };
    expect(textOf(root)).toBe("ab");
  });

  it("walks elements in document order and honours skip", () => {
    const seen: string[] = [];
    walkElements(parseHtmlFragment("<div><p><i>x</i></p><pre><code>y</code></pre></div><ul><li>z</li></ul>"), (node) => {
      seen.push(node.tagName);
      return node.tagName === "pre" ? "skip" : undefined;
    });
    expect(seen).toEqual(["div", "p", "i", "pre", "ul", "li"]);
  });

  it("drops URL properties that are not strings", () => {
    // The parser never produces this; the transform must still refuse it.
    const root = { type: "root", children: [{ type: "element", tagName: "a", properties: { href: 5, src: null }, children: [] }] } as unknown as Root;
    rewriteUrls(root, "a.md");
    expect(root.children[0]).toMatchObject({ properties: { src: null } });
    expect("href" in (root.children[0] as { properties: object }).properties).toBe(false);
  });
});

describe("bounded parser", () => {
  it("charges work for formatting-element scans and fails closed", () => {
    // Distinct attributes defeat the parser's three-duplicates rule, so the formatting list grows with the stack.
    const nested = (count: number) => Array.from({ length: count }, (_, i) => `<b data-i="${i}">`).join("");
    expect(() => parseHtmlDocument(nested(150))).not.toThrow();
    const error = (() => { try { parseHtmlDocument(nested(400)); } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).reason).toBe("too-complex");
    expect(MAX_PARSE_WORK).toBe(32_000_000);
  });
});

describe("ordering", () => {
  it("compares code units", () => {
    expect([compareCodeUnits("a", "b"), compareCodeUnits("b", "a"), compareCodeUnits("a", "a"), compareCodeUnits("Z", "a")]).toEqual([-1, 1, 0, -1]);
    expect([naturalCompare("x", ""), naturalCompare("", "x"), naturalCompare("", "")]).toEqual([1, -1, 0]);
  });

  it("breaks detection ties by signal path", () => {
    expect(detectDocs(tree(["mkdocs.yml", "mkdocs.yaml", "docs/a.md"])).primary).toMatchObject({ root: "docs", signal: "mkdocs.yaml" });
  });

  it("breaks sidebar ties between same-named pages by path", () => {
    const sidebar = buildSidebar({ root: "", entry: "index.md", pages: ["index.md", "setup.mdx", "setup.md"], truncated: false }, new Map());
    expect(sidebar.nodes.map(({ path }) => path)).toEqual(["index.md", "setup.md", "setup.mdx"]);
  });
});
