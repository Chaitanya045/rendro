import { jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { nonceAttribute, nonceContext, requestNonce } from "@/middleware/html-nonce";
import { InlineScript, InlineStyle, renderHtml, scriptJson } from "@/routes/trusted-html";

describe("the audited unescaped-HTML helper (#288)", () => {
  it("reads the request nonce for string and JSX callers alike", () => {
    expect(nonceAttribute()).toBe("");
    expect(requestNonce()).toBeUndefined();
    nonceContext.run("abc", () => {
      expect(nonceAttribute()).toBe(' nonce="abc"');
      expect(requestNonce()).toBe("abc");
    });
  });

  it("writes inline code verbatim, with the request's nonce first and only inside a request", () => {
    const code = 'if(a<b&&c>"d")x();';
    expect(nonceContext.run("abc", () => renderHtml(InlineScript({ code, id: "boot" })))).toBe(`<script nonce="abc" id="boot">${code}</script>`);
    expect(nonceContext.run("abc", () => renderHtml(InlineStyle({ code: "a>b{}", "data-rendro-theme": "" })))).toBe('<style nonce="abc" data-rendro-theme="">a>b{}</style>');
    expect(renderHtml(InlineScript({ code }))).toBe(`<script>${code}</script>`);
    expect(nonceContext.run("", () => renderHtml(InlineStyle({ code: "a{}" })))).toBe("<style>a{}</style>");
  });

  it("encodes script data as JSON that cannot end the script or a string literal", () => {
    const value = { text: "</script><!--\u2028\u2029", list: ["<b>"] };
    const encoded = scriptJson(value);
    expect(encoded).not.toMatch(/[<\u2028\u2029]/);
    expect(encoded).toContain("\\u003c/script>\\u003c!--\\u2028\\u2029");
    expect(JSON.parse(encoded)).toEqual(value);
    expect(scriptJson(null)).toBe("null");
  });

  it("renders a page in place, with the doctype, and never moves metadata elements into the head", () => {
    const page = jsx("html", null, jsx("head", null, jsx("title", null, "T")), jsx("body", null,
      jsx("link", { rel: "preload", href: "/a.woff2", as: "font" }), jsx("script", { async: true, src: "/rum.js" })));
    expect(renderHtml(page, "<!DOCTYPE html>\n")).toBe('<!DOCTYPE html>\n<html><head><title>T</title></head><body><link rel="preload" href="/a.woff2" as="font"/><script async="" src="/rum.js"></script></body></html>');
  });

  it("refuses an asynchronous component", () => {
    const Later = () => Promise.resolve(jsx("p", null, "later"));
    expect(() => renderHtml(jsx("div", null, jsx(Later, null)))).toThrow("Server pages render synchronously");
  });
});
