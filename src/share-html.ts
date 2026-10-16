import { Parser, Tokenizer, type DefaultTreeAdapterMap } from "parse5";

export class ShareAssetError extends Error {}
export const MAX_HTML_TAG_MARKERS = 50_000;
export const MAX_HTML_ATTRIBUTES = 100_000;
export const MAX_HTML_ATTRIBUTES_PER_TAG = 128;

/** Linear preflight; counting every '<' conservatively includes comments/text. */
export function checkShareHtmlComplexity(input: string): void {
  let tags = 0;
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === 60 && ++tags > MAX_HTML_TAG_MARKERS) {
      throw new ShareAssetError("Share HTML exceeds the 50,000 tag marker limit");
    }
  }
}

/**
 * Check attributes BEFORE parse5's linear duplicate-name lookup, not on the DOM
 * or emitted token. This bounds that lookup to 128 comparisons per attribute.
 * Use the real tokenizer so quotes, comments, raw text and malformed markup
 * cannot hide attributes from a separate approximate lexical scanner.
 * parse5 is pinned; boundary tests protect these protected-method hooks.
 */
class ShareTokenizer extends Tokenizer {
  private attributes = 0;
  private tagAttributes = 0;

  protected override _createStartTagToken(): void {
    this.tagAttributes = 0;
    super._createStartTagToken();
  }

  protected override _createEndTagToken(): void {
    this.tagAttributes = 0;
    super._createEndTagToken();
  }

  protected override _createAttr(first: string): void {
    if (++this.tagAttributes > MAX_HTML_ATTRIBUTES_PER_TAG) {
      throw new ShareAssetError("Share HTML exceeds the 128 attributes per tag limit");
    }
    if (++this.attributes > MAX_HTML_ATTRIBUTES) {
      throw new ShareAssetError("Share HTML exceeds the 100,000 total attributes limit");
    }
    super._createAttr(first);
  }
}

export function parseShareHtml(input: string): DefaultTreeAdapterMap["document"] {
  checkShareHtmlComplexity(input);
  const parser = new Parser<DefaultTreeAdapterMap>();
  parser.tokenizer = new ShareTokenizer(parser.options, parser);
  parser.tokenizer.write(input, true);
  return parser.document;
}
