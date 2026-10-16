import { afterEach, describe, expect, it, vi } from "vitest";
import { Tokenizer } from "parse5";
import {
  checkShareHtmlComplexity, parseShareHtml, ShareAssetError,
  MAX_HTML_TAG_MARKERS, MAX_HTML_ATTRIBUTES, MAX_HTML_ATTRIBUTES_PER_TAG,
} from "../src/share-html";

afterEach(() => vi.restoreAllMocks());
const attrs = (count: number) => Array.from({ length: count }, (_, i) => ` a${i}`).join("");

describe("bounded share HTML parsing", () => {
  it("bounds tag markers before creating a parser", () => {
    for (const count of [MAX_HTML_TAG_MARKERS - 1, MAX_HTML_TAG_MARKERS]) {
      expect(() => checkShareHtmlComplexity("<br>".repeat(count))).not.toThrow();
    }
    expect(() => parseShareHtml("<br>".repeat(MAX_HTML_TAG_MARKERS + 1))).toThrow("50,000 tag marker limit");
    expect(() => checkShareHtmlComplexity("<!--" + "<".repeat(MAX_HTML_TAG_MARKERS))).toThrow(ShareAssetError);
  });

  it.each(["img", "/div", "img/"])("counts attributes before deduplication on %s", tag => {
    for (const count of [MAX_HTML_ATTRIBUTES_PER_TAG - 1, MAX_HTML_ATTRIBUTES_PER_TAG]) {
      expect(() => parseShareHtml(`<${tag}${attrs(count)}>`)).not.toThrow();
    }
    for (const attributes of [attrs(129), " duplicate".repeat(129), ' a="<>"'.repeat(129), " a=''".repeat(129)]) {
      expect(() => parseShareHtml(`<${tag}${attributes}>`)).toThrow("128 attributes per tag limit");
    }
  });

  it("counts total attributes across tags, including duplicates", () => {
    const base = '<img a>'.repeat(MAX_HTML_ATTRIBUTES % 128);
    const blocks = '<img' + attrs(128) + '>';
    const input = blocks.repeat(Math.floor(MAX_HTML_ATTRIBUTES / 128)) + base;
    expect(() => parseShareHtml(input.slice(0, -7))).not.toThrow();
    expect(() => parseShareHtml(input)).not.toThrow();
    expect(() => parseShareHtml(input + '<img a>')).toThrow("100,000 total attributes limit");
  });

  it("preserves raw text, comments, quoted delimiters, entities and malformed tag recovery", () => {
    const input = `<!-- <img${attrs(200)}> --><script>"<img${attrs(200)}>"</script><style>/* <img${attrs(200)}> */</style>`;
    expect(() => parseShareHtml(input)).not.toThrow();
    expect(() => parseShareHtml(input + `<img a="< > ' &quot;"b=c /${attrs(127)}>`)).toThrow(ShareAssetError);
    expect(() => parseShareHtml(`<script>'<img a="'</script><img${attrs(129)}>`)).toThrow(ShareAssetError);
    expect(() => parseShareHtml(`<svg><g${attrs(129)}>`)).toThrow(ShareAssetError);
  });

  it("uses one linear preflight pass and constant bounded attribute work on adversarial sizes", () => {
    // Count work instead of asserting noisy wall-clock ratios on the shared host.
    for (const count of [40_000, 80_000]) {
      const input = `<img${attrs(count)}>`;
      let reads = 0;
      const counted = { length: input.length, charCodeAt(i: number) { reads++; return input.charCodeAt(i); } };
      checkShareHtmlComplexity(counted as unknown as string);
      expect(reads).toBe(input.length);
    }
    // The base method is called only after our guard accepts the next attribute.
    const base = vi.spyOn(Tokenizer.prototype as unknown as { _createAttr(first: string): void }, "_createAttr");
    for (const count of [40_000, 80_000]) {
      base.mockClear();
      expect(() => parseShareHtml(`<img${attrs(count)}>`)).toThrow(ShareAssetError);
      expect(base).toHaveBeenCalledTimes(MAX_HTML_ATTRIBUTES_PER_TAG);
    }
  });
});
