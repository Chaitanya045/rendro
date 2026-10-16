import { describe, expect, it } from "vitest";
import { hasCssImports, rewriteCssUrls } from "@/viewer/css-urls";

const rewrite = (css: string) => rewriteCssUrls(css, value => {
  const url = new URL(value, "https://rendro.test/view/old/files/guide/index.html");
  if (!url.href.startsWith("https://rendro.test/view/old/files/")) return value;
  return url.href.replace("/view/old/", "/view/new/");
});

describe("CSS resource URL token rewriting", () => {
  it.each([
    'url(image.png)', 'URL( image.png )', 'url("image.png")', "url('image.png')",
    String.raw`u\72l(im\61ge.png)`, String.raw`url("im\61ge.png")`,
  ])("resolves scoped URLs in %s", input => {
    expect(rewrite(`background:${input}`)).toContain('"https://rendro.test/view/new/files/guide/image.png"');
  });

  it("handles escapes, imports, nested functions and custom properties", () => {
    const css = String.raw`@\69mport /* keep */ "theme.css" screen;
.a { --picture: url(images/a\(b\).svg); background: image-set(url('a.png') 1x, url(b.png) 2x); }`;
    const result = rewrite(css);
    expect(result).toContain('@\\69mport /* keep */ "https://rendro.test/view/new/files/guide/theme.css" screen;');
    expect(result).toContain('url("https://rendro.test/view/new/files/guide/images/a(b).svg")');
    expect(result).toContain('url("https://rendro.test/view/new/files/guide/a.png")');
    expect(result).toContain('url("https://rendro.test/view/new/files/guide/b.png")');
  });

  it("rewrites string URL candidates without touching nested descriptors or other strings", () => {
    const css = String.raw`.a { background: image-set("a.png" 1x type("image/png"), 'b.png' type("image/png") 2x);
mask-image: -webkit-image-set("c.png" 1x, url(d.png) 2x);
--escaped: image\2d set(/* keep */ "e.png" 1x, var(--fallback, "ordinary") 2x);
--source: src("f.png"); content: "ordinary"; }`;
    const result = rewrite(css);
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      expect(result).toContain(`"https://rendro.test/view/new/files/guide/${name}.png"`);
    }
    expect(result.match(/type\("image\/png"\)/g)).toHaveLength(2);
    expect(result).toContain('var(--fallback, "ordinary")');
    expect(result).toContain('content: "ordinary"');
  });

  it.each([
    '@font-face { src: url("font.woff2") format("woff2") }',
    '.a { cursor: url("font.woff2"), auto }',
    '.a { mask: url("font.woff2"); mask-image: url("font.woff2") }',
    '.a { list-style-image: url("font.woff2") }',
    '.a { border-image: url("font.woff2") 30 }',
    '.a { content: url("font.woff2") }',
  ])("covers URL-valued properties: %s", css => {
    expect(rewrite(css)).toContain('url("https://rendro.test/view/new/files/guide/font.woff2")');
    if (css.includes("format")) expect(rewrite(css)).toContain('format("woff2")');
  });

  it("preserves fragments and non-scoped URL forms in every URL context", () => {
    for (const value of ["#id", "data:image/png;base64,AAAA", "blob:https://rendro.test/id",
      "https://external.test/a.png", "//external.test/a.png", "/public/a.png"]) {
      const css = `@import "${value}"; .a { filter: url("${value}"); background: image-set("${value}" 1x); --src: src("${value}") }`;
      expect(rewrite(css)).toBe(css);
    }
  });

  it("preserves Unicode URL characters and only treats ASCII-prefixed hashes as fragments", () => {
    for (const whitespace of ["\u00a0", "\u2028", "\u3000", "\u0085", "\u200b", "\ufeff"]) {
      const urls: string[] = [];
      const input = `@import "${whitespace}#sheet"; p{background:url(${whitespace}#image)}`;
      expect(rewriteCssUrls(input, value => { urls.push(value); return value; })).toBe(input);
      expect(urls).toEqual([`${whitespace}#sheet`, `${whitespace}#image`]);
    }
    expect(rewriteCssUrls('p{filter:url("  #fragment")}', () => { throw new Error("Local fragment"); })).toBe('p{filter:url("  #fragment")}');
  });

  it("escapes replacement strings and preserves ordinary bracket/parenthesis blocks", () => {
    const input = 'a[data-x="ordinary"] { --block: ("ordinary"); background:url(image) }';
    expect(rewriteCssUrls(input, () => 'a"\\\n\u007f')).toBe('a[data-x="ordinary"] { --block: ("ordinary"); background:url("a\\22 \\5c \\a \\7f ") }');
  });

  it("leaves comments, ordinary strings, malformed tokens and out-of-scope URLs alone", () => {
    const css = String.raw`/* url(image.png) */ .a { content: 'url(image.png)'; --text: "theme.css";
background: url(https://external.test/a.png), url(data:image/png;base64,AAAA), url(/public/a.png);
broken: url(bad"url); }`;
    expect(rewrite(css)).toBe(css);
  });
});

describe("CSS import detection", () => {
  it.each(['@import "a.css";', '@IMPORT url(a.css);', String.raw`@\69mport "a.css";`])("recognizes %s", css => {
    expect(hasCssImports(css)).toBe(true);
  });
  it("ignores imports inside ordinary strings and comments", () => {
    expect(hasCssImports('/* @import "a.css"; */ .a { content: "@import b.css;"; background: url(a.png) }')).toBe(false);
  });
});
