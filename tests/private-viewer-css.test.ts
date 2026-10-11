import { describe, expect, it } from "vitest";
import { rewriteCssUrls } from "@/viewer/css-urls";

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

  it("leaves comments, ordinary strings, malformed tokens and out-of-scope URLs alone", () => {
    const css = String.raw`/* url(image.png) */ .a { content: 'url(image.png)'; --text: "theme.css";
background: url(https://external.test/a.png), url(data:image/png;base64,AAAA), url(/public/a.png);
broken: url(bad"url); }`;
    expect(rewrite(css)).toBe(css);
  });
});
