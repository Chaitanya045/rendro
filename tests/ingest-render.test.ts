import { beforeAll, describe, expect, it } from "vitest";

import { HIGHLIGHT_CSS } from "../src/ingest/highlight-theme";
import { MAX_HIGHLIGHT_BLOCK_CHARS, MAX_HIGHLIGHT_DOCUMENT_CHARS, MAX_INTERMEDIATE_HTML_CHARS, MAX_SOURCE_BYTES, MAX_TAG_MARKERS, RENDERER_VERSION, RenderError } from "../src/ingest/limits";
import { documentKindOf, renderDocument, renderKey } from "../src/ingest/render";
import { outputViolations } from "./helpers/ingest-invariants";
import { initNodeMarkdownEngine } from "./helpers/markdown-engine";

beforeAll(() => initNodeMarkdownEngine());

const md = (source: string, path = "docs/guide/intro.md") => renderDocument(source, path);
const reasonOf = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    if (error instanceof RenderError) return error.reason;
    throw error;
  }
  return null;
};

describe("GitHub-flavoured Markdown", () => {
  it("renders tables, task lists, strikethrough and autolinks", () => {
    const { html } = md("| a | b |\n|:--|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~old~~ www.example.com and https://example.org/x.");
    expect(html).toContain('<th align="left">a</th>');
    expect(html).toContain('<td align="right">2</td>');
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" checked disabled> done</li>');
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" disabled> todo</li>');
    expect(html).toContain("<del>old</del>");
    expect(html).toContain('<a href="http://www.example.com/" rel="nofollow noopener noreferrer">www.example.com</a>');
    expect(html).toContain('<a href="https://example.org/x" rel="nofollow noopener noreferrer">https://example.org/x</a>');
    expect(outputViolations(html)).toEqual([]);
  });

  it("renders footnotes with ids and back-references that resolve to each other", () => {
    const { html } = md("Claim[^note].\n\n[^note]: Source.");
    expect(html).toContain('<sup class="footnote-ref"><a href="#user-content-fn-note" id="user-content-fnref-note" data-footnote-ref="">1</a></sup>');
    expect(html).toContain('<li id="user-content-fn-note">');
    expect(html).toContain('<a href="#user-content-fnref-note" class="footnote-backref" data-footnote-backref="" aria-label="Back to reference 1">↩</a>');
    expect(html).toContain('<section class="footnotes" data-footnotes="">');
  });

  it.each(["note", "tip", "important", "warning", "caution"])("renders the %s alert", (type) => {
    const { html } = md(`> [!${type.toUpperCase()}]\n> Body text.`);
    const title = type.charAt(0).toUpperCase() + type.slice(1);
    expect(html).toBe(`<div class="markdown-alert markdown-alert-${type}"><p class="markdown-alert-title">${title}</p>\n<p>Body text.</p>\n</div>\n`);
  });

  it("recognizes alerts only as GitHub does", () => {
    expect(md("> [!note]\n>\n> Second paragraph.").html).toBe('<div class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">Note</p>\n\n<p>Second paragraph.</p>\n</div>\n');
    // Not the whole first line, an unknown type, nested in a list, or an empty quote: plain blockquotes.
    for (const source of ["> [!NOTE] inline text", "> [!TODO]\n> x", "- > [!NOTE]\n  > x", ">", "> **[!NOTE]**\n> x"]) {
      expect(md(source).html).not.toContain("markdown-alert");
    }
  });

  it("strips front matter and takes its title", () => {
    const rendered = md("---\ntitle: \"Install guide\"\nsidebar_position: 2\n---\n\n# Installing\n\nText");
    expect(rendered.title).toBe("Install guide");
    expect(rendered.html).toBe('<h1 id="user-content-installing">Installing</h1>\n<p>Text</p>\n');
    expect(md("+++\ntitle = \"Hugo page\"\n+++\nBody").title).toBe("Hugo page");
  });

  it("removes MDX import/export blocks but keeps fenced code", () => {
    const rendered = renderDocument("import Tabs from '@theme/Tabs';\nimport {\n  A,\n} from 'x';\n\n# MDX\n\n```js\nimport x from 'y';\n```\n\n<Tabs><p>tab</p></Tabs>\n\nexport const meta = {};\n", "docs/page.mdx");
    expect(rendered.kind).toBe("mdx");
    expect(rendered.html).not.toContain("@theme/Tabs");
    expect(rendered.html).not.toContain("export const");
    expect(rendered.html).toContain('<span class="hljs-keyword">import</span> x <span class="hljs-keyword">from</span>');
    expect(rendered.html).toContain("<p>tab</p>");
  });
});

describe("headings and anchors", () => {
  it("assigns GitHub-compatible slugs with numbered repeats", () => {
    const { html, headings } = md("# Hello, World!\n## Hello, World!\n### `config.yml` & *Options*\n#### Ünïcödé — Straße\n##### 🎉\n###### 🎉\n# Hello, World!");
    expect(headings.map(({ slug }) => slug)).toEqual(["hello-world", "hello-world-1", "configyml--options", "ünïcödé--straße", "", "-1", "hello-world-2"]);
    expect(headings[2]).toEqual({ depth: 3, text: "config.yml & Options", slug: "configyml--options", id: "user-content-configyml--options" });
    // An emoji-only heading has an empty slug and gets no id, as on GitHub.
    expect(headings[4]).toEqual({ depth: 5, text: "🎉", slug: "", id: null });
    expect(html).toContain("<h5>🎉</h5>");
    expect(html).toContain('<h6 id="user-content--1">🎉</h6>');
  });

  it("numbers repeated slugs in document order, across containers", () => {
    const { headings } = renderDocument("<div><h2>Same</h2><div><h3>Same</h3></div></div><h2>Same</h2><details><summary>s</summary><h4>Same</h4></details>", "a.html");
    expect(headings.map(({ depth, slug }) => `${depth}:${slug}`)).toEqual(["2:same", "3:same-1", "2:same-2", "4:same-3"]);
  });

  it("keeps an author id but still advances the slug counter", () => {
    const { headings } = md('<h2 id="custom">Setup</h2>\n\n## Setup');
    expect(headings).toEqual([
      { depth: 2, text: "Setup", slug: "setup", id: "user-content-custom" },
      { depth: 2, text: "Setup", slug: "setup-1", id: "user-content-setup-1" },
    ]);
  });

  it("does not list the footnotes heading", () => {
    expect(md("x[^1]\n\n[^1]: y").headings).toEqual([]);
    const html = renderDocument('<section data-footnotes><h2 id="footnote-label">Footnotes</h2></section><h2>Real</h2>', "a.html");
    expect(html.headings.map(({ text }) => text)).toEqual(["Real"]);
  });

  it("titles a document by its first h1, else its first heading", () => {
    expect(md("## Second\n\n# First").title).toBe("First");
    expect(md("### Only").title).toBe("Only");
    expect(md("No headings.").title).toBeNull();
    expect(md("# ").title).toBeNull();
  });
});

describe("links and images", () => {
  it("rewrites relative links and images to repo paths and prefixes fragments", () => {
    const { html } = md("[a](../api/README.md#Usage) [b](./setup.md) [c](/LICENSE) [d](#install) [e](sub/) [f](https://x.example/) [g](mailto:a@b.example)\n\n![logo](img/logo.png)");
    expect(html).toContain('<a href="/docs/api/README.md#user-content-Usage">a</a>');
    expect(html).toContain('<a href="/docs/guide/setup.md">b</a>');
    expect(html).toContain('<a href="/LICENSE">c</a>');
    expect(html).toContain('<a href="#user-content-install">d</a>');
    expect(html).toContain('<a href="/docs/guide/sub/">e</a>');
    expect(html).toContain('<a href="https://x.example/" rel="nofollow noopener noreferrer">f</a>');
    expect(html).toContain('<a href="mailto:a@b.example">g</a>');
    expect(html).toContain('<img src="/docs/guide/img/logo.png" alt="logo" loading="lazy" decoding="async" referrerpolicy="no-referrer">');
  });

  it("drops links that leave the repository", () => {
    expect(md("[up](../../../x.md)").html).toBe("<p><a>up</a></p>\n");
  });
});

describe("syntax highlighting", () => {
  it("emits classes only, never style attributes", () => {
    const { html } = md("```rust\nfn main() { println!(\"hi\"); }\n```\n\n```ts\nconst x: number = 1;\n```\n\n```dockerfile\nFROM node:22\n```");
    expect(html).toContain('<code class="language-rust hljs"><span class="hljs-keyword">fn</span> <span class="hljs-title function_">main</span>');
    expect(html).toContain('<code class="language-ts hljs">');
    expect(html).toContain('<span class="hljs-keyword">FROM</span>');
    expect(html).not.toMatch(/style=/);
    expect(outputViolations(html)).toEqual([]);
  });

  it("leaves unknown, unnamed and oversized code plain", () => {
    expect(md("```klingon\nqapla'\n```").html).toBe('<pre><code class="language-klingon">qapla\'\n</code></pre>\n');
    expect(md("```\nplain\n```").html).toBe("<pre><code>plain\n</code></pre>\n");
    expect(md("    indented").html).toBe("<pre><code>indented\n</code></pre>\n");
    const big = "x".repeat(MAX_HIGHLIGHT_BLOCK_CHARS + 1);
    expect(md("```js\n" + big + "\n```").html).not.toContain("hljs");
  });

  it("stops highlighting once the per-document budget is spent", () => {
    const block = "```js\n" + "a;".repeat(MAX_HIGHLIGHT_BLOCK_CHARS / 2 - 1) + "\n```\n\n";
    const count = Math.ceil(MAX_HIGHLIGHT_DOCUMENT_CHARS / MAX_HIGHLIGHT_BLOCK_CHARS) + 1;
    const { html } = md(block.repeat(count));
    const highlighted = html.match(/class="language-js hljs"/g)?.length;
    expect(highlighted).toBe(Math.floor(MAX_HIGHLIGHT_DOCUMENT_CHARS / (MAX_HIGHLIGHT_BLOCK_CHARS - 1)));
    expect(html.match(/class="language-js"/g)?.length).toBe(count - (highlighted as number));
  });

  it("only highlights a <pre> whose sole child is <code>", () => {
    expect(renderDocument('<pre><code class="language-js">let a</code> tail</pre><pre>let b</pre>', "a.html").html).toBe('<pre><code class="language-js">let a</code> tail</pre><pre>let b</pre>');
  });

  it("ships a class-only theme for light and dark", () => {
    expect(HIGHLIGHT_CSS).toContain(".hljs-keyword");
    expect(HIGHLIGHT_CSS).toContain("@media (prefers-color-scheme:dark)");
    expect(HIGHLIGHT_CSS).not.toContain("url(");
  });
});

describe("repo HTML documents", () => {
  it("renders the body and takes the <title>", () => {
    const rendered = renderDocument("<!doctype html><html><head><title>\n  API   Reference\n</title><script>x()</script></head><body><h1>API</h1><p>Body</p></body></html>", "site/api.html");
    expect(rendered).toEqual({
      rendererVersion: RENDERER_VERSION,
      kind: "html",
      html: '<h1 id="user-content-api">API</h1><p>Body</p>',
      title: "API Reference",
      headings: [{ depth: 1, text: "API", slug: "api", id: "user-content-api" }],
    });
  });

  it("falls back to the first heading and handles documents without a body", () => {
    expect(renderDocument("<title> </title><h2>Heading</h2>", "a.htm").title).toBe("Heading");
    expect(renderDocument("<frameset><frame src=x></frameset>", "a.html")).toMatchObject({ html: "", title: null, headings: [] });
  });
});

describe("limits", () => {
  it("rejects oversized sources, counting UTF-8 bytes", () => {
    expect(reasonOf(() => md("a".repeat(MAX_SOURCE_BYTES + 1)))).toBe("too-large");
    expect(reasonOf(() => md("é".repeat(MAX_SOURCE_BYTES / 2 + 1)))).toBe("too-large");
    expect(reasonOf(() => md("é".repeat(MAX_SOURCE_BYTES / 2 - 8)))).toBeNull();
  });

  it("rejects sources with too many tag markers before parsing", () => {
    expect(reasonOf(() => md("<".repeat(MAX_TAG_MARKERS)))).toBeNull();
    expect(reasonOf(() => md("<".repeat(MAX_TAG_MARKERS + 1)))).toBe("too-complex");
  });

  it("rejects Markdown whose HTML expands past the intermediate cap", () => {
    // Each reference expands to a full footnote link.
    const source = "x[^a]".repeat(Math.ceil(MAX_INTERMEDIATE_HTML_CHARS / 120)) + "\n\n[^a]: y";
    expect(source.length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(reasonOf(() => md(source))).toBe("too-large");
  });

  it("rejects nesting deeper than browsers build", () => {
    expect(reasonOf(() => renderDocument("<div>".repeat(600), "a.html"))).toBe("too-deep");
    expect(reasonOf(() => md("x\n\n" + "<div>".repeat(600)))).toBe("too-deep");
    expect(reasonOf(() => md(">".repeat(5000) + " x"))).toBe("too-deep");
    expect(reasonOf(() => renderDocument("<div>".repeat(400), "a.html"))).toBeNull();
  });

  it("rejects runaway formatting and attribute counts", () => {
    expect(reasonOf(() => renderDocument("<b>".repeat(600), "a.html"))).toBe("too-deep");
    expect(reasonOf(() => renderDocument(`<p ${Array.from({ length: 129 }, (_, i) => `a${i}`).join(" ")}>`, "a.html"))).toBe("too-complex");
    expect(reasonOf(() => renderDocument(`<p ${Array.from({ length: 128 }, (_, i) => `a${i}`).join(" ")}>`, "a.html"))).toBeNull();
  });
});

describe("document kinds and render keys", () => {
  it("maps extensions to kinds", () => {
    expect(["a.md", "a.MARKDOWN", "a.mdx", "a.html", "a.HTM", "a.txt", "README", ".md"].map(documentKindOf)).toEqual(["markdown", "markdown", "mdx", "html", "html", null, null, null]);
    expect(() => renderDocument("x", "notes.txt")).toThrow(TypeError);
  });

  it("keys renders by version, kind, blob and directory", async () => {
    const sha = "a".repeat(40);
    const key = await renderKey(sha, "docs/guide/intro.md");
    expect(key).toMatch(new RegExp(`^render/v${RENDERER_VERSION}/markdown/${sha}/[0-9a-f]{32}$`));
    // Same directory shares the key; another directory or kind does not.
    expect(await renderKey(sha, "docs/guide/other.md")).toBe(key);
    expect(await renderKey(sha, "docs/intro.md")).not.toBe(key);
    expect(await renderKey(sha, "docs/guide/intro.mdx")).not.toBe(key);
    expect(await renderKey("b".repeat(64), "index.html")).toMatch(/^render\/v\d+\/html\/b{64}\/[0-9a-f]{32}$/);
  });

  it("rejects invalid keys", async () => {
    await expect(renderKey("A".repeat(40), "a.md")).rejects.toThrow(TypeError);
    await expect(renderKey("a".repeat(40), "a.txt")).rejects.toThrow(TypeError);
  });

  it("is deterministic", () => {
    const source = "# T\n\n```js\nlet a = 1\n```\n\n| a |\n|---|\n| b |\n\n[x](y.md)";
    expect(md(source)).toEqual(md(source));
  });
});
