import { beforeAll, describe, expect, it } from "vitest";

import type { Element, Properties, Root } from "hast";
import { extractSections, sectionsFromHtml, type PageSection } from "../src/ingest/sections";
import { renderDocument } from "../src/ingest/render";
import { TEST_RENDER_OPTIONS } from "./helpers/ingest-render";
import { initNodeMarkdownEngine } from "./helpers/markdown-engine";

beforeAll(() => initNodeMarkdownEngine());

const options = TEST_RENDER_OPTIONS;

/** A hast tree without the Markdown engine: elements and text only. */
function tree(...children: Array<string | Element>): Root {
  return {
    type: "root",
    children: children.map(child => typeof child === "string" ? { type: "text", value: child } as const : child),
  };
}

const element = (tagName: string, properties: Properties = {}, ...children: Array<string | Element>): Element => ({
  type: "element", tagName, properties,
  children: children.map(child => typeof child === "string" ? { type: "text", value: child } as const : child),
});

const outline = (sections: PageSection[]) => sections.map(section => `${section.slug}|${section.title}|${section.text}`);

describe("extractSections", () => {
  it("splits a rendered document into a preamble plus one section per heading", async () => {
    const rendered = await renderDocument(
      "Lead text before any heading.\n\n# First\n\nUnder the first heading.\n\n## Second\n\nDeeper text.\n",
      "docs/guide/intro.md",
      { rewriteImageUrl: options.rewriteImageUrl },
    );
    expect(outline(rendered.sections)).toEqual([
      "||Lead text before any heading.",
      "user-content-first|First|Under the first heading.",
      "user-content-second|Second|Deeper text.",
    ]);
  });

  it("keeps section text plain prose: no code classes, no link markup, no marker characters", async () => {
    const rendered = await renderDocument(
      "# Setup\n\nRun `npm install` and see the [docs](other.md).\n\n```js\nconst x = 1;\n```\n",
      "docs/setup.md",
      { rewriteImageUrl: options.rewriteImageUrl },
    );
    const joined = rendered.sections.map(section => `${section.title}\n${section.text}`).join("\n");
    expect(joined).toContain("npm install");
    expect(joined).toContain("const x = 1");
    expect(joined).not.toContain("hljs");
    expect(joined).not.toContain('href="other.md"');
    // eslint-disable-next-line no-control-regex -- the assertion is the absence of control code points.
    for (const section of rendered.sections) expect(section.text).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("does not index the footnotes block as a section", async () => {
    const rendered = await renderDocument("Claim[^note].\n\n# Head\n\nText.\n\n[^note]: Source.\n", "docs/n.md", { rewriteImageUrl: options.rewriteImageUrl });
    const joined = rendered.sections.map(section => `${section.title}\n${section.text}`).join("\n");
    expect(joined).toContain("Head\nText.");
    expect(joined).not.toContain("Source.");
  });

  it("continues a section past a heading nested inside a container", () => {
    const sections = extractSections(tree(
      element("blockquote", {}, element("h2", { id: "quoted" }, "Quoted heading"), "Quoted prose."),
      "Trailing text.",
    ));
    expect(outline(sections)).toEqual(["quoted|Quoted heading|Quoted prose.Trailing text."]);
  });

  it("records headings without an id as slugless sections and makes duplicate slugs unique", () => {
    const sections = extractSections(tree(
      element("h1", {}, "No id here"),
      "First slugless section.",
      element("h2", { id: "dup" }, "First dup"),
      "One.",
      element("h3", { id: "dup" }, "Second dup"),
      "Two.",
      element("h2", {}, "Second slugless"),
      "Three.",
    ));
    const slugs = sections.map(section => section.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(outline(sections)).toEqual([
      "|No id here|First slugless section.",
      "dup|First dup|One.",
      "dup-2|Second dup|Two.",
      "section-2|Second slugless|Three.",
    ]);
  });

  it("strips control characters and collapses whitespace in text and titles", () => {
    const sections = extractSections(tree(
      element("h1", { id: "t" }, "Ti\u0002tle", element("em", {}, " ", "with\u0003style")),
      "Body\u0002with\u0003markers   and\n\nnewlines.",
    ));
    expect(outline(sections)).toEqual(["t|Ti tle with style|Body with markers and newlines."]);
  });

  it("caps the number of sections, their text, titles and a page's total text", () => {
    const children: Array<string | Element> = [];
    for (let index = 0; index < 10; index += 1) {
      children.push(element("h2", { id: `h${index}` }, `Heading ${index}`), `text ${"y".repeat(30)} ${index}`);
    }
    const sections = extractSections(tree(...children), { maxSections: 3 });
    expect(sections.map(section => section.slug)).toEqual(["h0", "h1", "h2"]);

    expect(extractSections(tree(element("h1", {}, "T"), "x".repeat(40)), { maxTextChars: 20 })[0].text).toHaveLength(20);
    expect(extractSections(tree(element("h1", {}, "abcdefgh")), { maxTitleChars: 4 })[0].title).toBe("abcd");

    const capped = extractSections(tree(...children), { maxPageChars: 50 });
    expect(capped.map(section => section.text).join("").length).toBeLessThanOrEqual(50);
  });

  it("truncates a later section once the page cap is reached", () => {
    const sections = extractSections(tree(
      element("h1", { id: "a" }, "A"), "a".repeat(20),
      element("h2", { id: "b" }, "B"), "b".repeat(20),
      element("h2", { id: "c" }, "C"), "c".repeat(20),
    ), { maxPageChars: 30 });
    expect(sections.map(section => `${section.slug}:${section.text.length}`)).toEqual(["a:20", "b:10"]);
  });

  it("skips empty text nodes", () => {
    expect(extractSections(tree("", "before", element("h1", { id: "a" }, "A"), ""))).toEqual([{ slug: "", title: "", text: "before" }, { slug: "a", title: "A", text: "" }]);
  });

  it("leaves out sections with no title and no text", () => {
    expect(extractSections(tree(element("h2", { id: "empty" })))).toEqual([]);
    expect(extractSections(tree("      "))).toEqual([]);
  });

  it("ignores comment and doctype nodes, and non-footnote section elements are traversed", () => {
    const sections = extractSections(tree(
      { type: "comment", value: "a note" } as never,
      element("section", {}, "Inside a plain section."),
      element("h2", { id: "after" }, "After"),
    ));
    expect(outline(sections)).toEqual(["||Inside a plain section.", "after|After|"]);
  });

  it("drops nothing but stops collecting once the section cap is reached", () => {
    const children = Array.from({ length: 5 }, (_, index) => element("h2", { id: `h${index}` }, `Heading ${index}`));
    const sections = extractSections(tree(...children), { maxSections: 2 });
    expect(sections.map(section => section.slug)).toEqual(["h0", "h1"]);
  });

  it("counts a zero-width slice as no text", () => {
    const sections = extractSections(tree(element("h1", { id: "a" }, "A"), "x".repeat(4)), { maxPageChars: 4, maxTextChars: 100 });
    expect(sections).toEqual([{ slug: "a", title: "A", text: "xxxx" }]);
  });

  it("treats a snippet marker code point as a separator, not searchable text", async () => {
    const rendered = await renderDocument("# Marked\n\nfindme token\n", "docs/m.md", { rewriteImageUrl: options.rewriteImageUrl });
    // eslint-disable-next-line no-control-regex -- the assertion is the absence of the marker code points.
    for (const section of rendered.sections) expect(section.text).not.toMatch(/[\u0002\u0003]/);
  });
});

describe("sectionsFromHtml", () => {
  it("extracts sections from a stored rendered fragment", () => {
    const sections = sectionsFromHtml('<h1 id="user-content-install">Install</h1>\n<p>Run the installer.</p>\n');
    expect(outline(sections)).toEqual(["user-content-install|Install|Run the installer."]);
  });
});
