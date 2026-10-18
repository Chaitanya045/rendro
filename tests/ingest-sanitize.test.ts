import type { Root } from "hast";
import { beforeAll, describe, expect, it } from "vitest";

import { RenderError } from "../src/ingest/limits";
import { parseHtmlFragment } from "../src/ingest/parse-html";
import { renderDocument } from "../src/ingest/render";
import { TEST_RENDER_OPTIONS } from "./helpers/ingest-render";
import { contentSchema, outputSchema, sanitizeContent, serializeVerified, stabilize } from "../src/ingest/sanitize";
import { hostileCorpus } from "./fixtures/ingest/hostile-corpus";
import { outputViolations } from "./helpers/ingest-invariants";
import { initNodeMarkdownEngine } from "./helpers/markdown-engine";

beforeAll(() => initNodeMarkdownEngine());

const render = async (kind: "html" | "markdown", source: string) => (await renderDocument(source, kind === "html" ? "docs/page.html" : "docs/page.md", TEST_RENDER_OPTIONS)).html;

describe("hostile corpus", () => {
  it.each(hostileCorpus.map((entry) => [entry.name, entry] as const))("neutralizes %s", async (_name, entry) => {
    const html = await render(entry.kind, entry.source);
    expect(outputViolations(html)).toEqual([]);
    // Markup is escaped in text and attribute values, so a literal "<tag" means a real element.
    expect(html).not.toMatch(/<(?:script|style|iframe|object|embed|svg|math|base|meta|link|form|template|noscript|textarea|xmp|plaintext)\b/i);
    expect(attributeUrls(html, "href|src").filter((url) => /^\s*(?:javascript|vbscript|data|file|blob|intent|feed):/i.test(url))).toEqual([]);
    // A reader's browser fetches nothing from the attacker's host: every image is same-origin (a repo
    // file or the signed proxy), and only the protocol-relative case may keep the host as a plain link.
    expect(attributeUrls(html, "src").filter((url) => !/^\/(?![/\\])/.test(url))).toEqual([]);
    if (entry.name !== "protocol-relative and backslash hosts") expect(attributeUrls(html, "href").filter((url) => url.includes("evil.invalid"))).toEqual([]);
    if (entry.keeps) expect(textContent(html)).toContain(entry.keeps);
    // The output is its own fixed point: parse, sanitize and serialize again changes nothing.
    expect(serializeVerified(parseHtmlFragment(html))).toBe(html);
  });

  it("covers every technique family the brief lists", () => {
    const names = hostileCorpus.map((entry) => entry.name).join("\n");
    for (const family of ["script", "onerror", "javascript", "vbscript", "data URLs", "svg", "math", "mxss|noscript|textarea", "base", "meta", "form", "formaction", "srcset", "ping", "css url", "comment", "cdata", "entit"]) {
      expect(names, family).toMatch(new RegExp(family, "i"));
    }
    expect(hostileCorpus.length).toBeGreaterThanOrEqual(100);
  });
});

/** Values of the named URL attributes in the serialized output. */
function attributeUrls(html: string, names: string): string[] {
  return [...html.matchAll(new RegExp(`\\s(?:${names})="([^"]*)"`, "g"))].map((match) => match[1] as string);
}

function textContent(html: string): string {
  const out: string[] = [];
  const stack = [...parseHtmlFragment(html).children];
  while (stack.length) {
    const node = stack.shift() as Root["children"][number];
    if (node.type === "text") out.push(node.value);
    else if ("children" in node) stack.unshift(...node.children);
  }
  return out.join("");
}

describe("allowlist details", () => {
  it("keeps GitHub-style content markup", async () => {
    const html = await render("html", [
      '<p align="center"><img src="logo.png" alt="Logo" width="120" height="40"></p>',
      '<details open><summary>More</summary><kbd>Ctrl</kbd>+<kbd>C</kbd></details>',
      '<table><caption>c</caption><colgroup><col></colgroup><thead><tr><th scope="col" colspan="2">h</th></tr></thead><tbody><tr><td rowspan="1">d</td></tr></tbody></table>',
      '<ol start="3" reversed><li>three</li></ol><dl><dt>t</dt><dd>d</dd></dl><ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>',
      '<p dir="rtl" lang="ar" title="t">x<sub>2</sub><sup>3</sup><mark>m</mark><del>d</del><ins>i</ins><abbr title="a">A</abbr></p>',
    ].join(""));
    expect(html).toContain('<p align="center"><img src="/docs/logo.png" alt="Logo" width="120" height="40"');
    expect(html).toContain("<details open><summary>More</summary><kbd>Ctrl</kbd>+<kbd>C</kbd></details>");
    expect(html).toContain('<th scope="col" colspan="2">h</th>');
    expect(html).toContain('<ol start="3" reversed>');
    expect(html).toContain('<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>');
    expect(html).toContain('<p dir="rtl" lang="ar" title="t">');
    expect(outputViolations(html)).toEqual([]);
  });

  it("lets only same-origin image sources through the output schema", () => {
    // A transform that forgot to proxy an external image cannot leak it: the output pass drops the src.
    const tree = parseHtmlFragment('<img src="https://img.example/a.png" alt="a"><img src="//img.example/b.png"><img src="/img/sig/url" alt="c"><img src="/docs/d.png">');
    expect(serializeVerified(tree)).toBe('<img alt="a"><img><img src="/img/sig/url" alt="c"><img src="/docs/d.png">');
  });

  it("prefixes author ids and names so they cannot clobber globals", async () => {
    const html = await render("html", '<a id="install" name="anchor" href="#install">i</a><p id="user-content-x">p</p>');
    expect(html).toBe('<a id="user-content-install" name="user-content-anchor" href="#user-content-install">i</a><p id="user-content-user-content-x">p</p>');
  });

  it("unwraps unknown elements but drops raw-text and embedding elements with their content", async () => {
    expect(await render("html", "<custom-el><font color=red>kept</font></custom-el><center>c</center>")).toBe("keptc");
    expect(await render("html", "<object><p>fallback</p></object><button>b</button><select><option>o</option></select><video>v</video>")).toBe("b");
  });

  it("drops table parts outside a table instead of letting the browser re-parent them", () => {
    const tree: Root = { type: "root", children: [{ type: "element", tagName: "tr", properties: {}, children: [{ type: "element", tagName: "td", properties: {}, children: [{ type: "text", value: "x" }] }] }] };
    expect(serializeVerified(sanitizeContent(tree))).toBe("x");
  });

  it("restricts input to disabled checkboxes", async () => {
    expect(await render("html", '<input type="text" value="v" name="n"><input type="checkbox" checked>')).toBe('<input type="checkbox" disabled><input type="checkbox" checked disabled>');
  });

  it("only allows the classes the pipeline emits", async () => {
    const html = await render("html", '<div class="markdown-alert markdown-alert-note x"><p class="markdown-alert-title">t</p></div><span class="hljs-keyword">k</span><code class="language-js evil">c</code>');
    expect(html).toBe('<div><p>t</p></div><span>k</span><code class="language-js">c</code>');
  });

  it("drops classes that would fail the output schema without leaving class=\"\"", () => {
    const tree: Root = { type: "root", children: [{ type: "element", tagName: "span", properties: { className: ["language-xml"] }, children: [{ type: "text", value: "x" }] }] };
    expect(serializeVerified(tree)).toBe("<span>x</span>");
  });

  it("keeps a single schema base for content and output", () => {
    for (const key of ["tagNames", "strip", "protocols", "ancestors", "required"] as const) expect(outputSchema[key]).toBe(contentSchema[key]);
    expect(contentSchema.clobberPrefix).toBe("user-content-");
    expect(outputSchema.clobber).toEqual([]);
  });
});

describe("stabilize", () => {
  it("returns once a pass is idempotent", () => {
    expect(stabilize("ab", (value) => value.replace("b", ""))).toBe("a");
    expect(stabilize("a", (value) => value)).toBe("a");
  });

  it("fails closed when the output never settles", () => {
    let counter = 0;
    const error = (() => { try { stabilize("x", () => `x${++counter}`); } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(RenderError);
    expect((error as RenderError).reason).toBe("unstable");
    expect(counter).toBe(3);
  });
});
