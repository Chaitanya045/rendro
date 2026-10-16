import { Parser, Tokenizer, type DefaultTreeAdapterMap, type Token } from "parse5";

import { shareTree } from "@/share-tree";
import { WorkBudget, ShareAssetError } from "@/share-budget";
export { ShareAssetError } from "@/share-budget";
export const MAX_HTML_DEPTH = 512;
export const MAX_HTML_TAG_MARKERS = 50_000;
export const MAX_HTML_ATTRIBUTES = 100_000;
export const MAX_HTML_ATTRIBUTES_PER_TAG = 128;

/** Linear preflight; counting every '<' conservatively includes comments/text. */
export function checkShareHtmlComplexity(input: string, budget = new WorkBudget()): void {
  let tags = 0;
  for (let i = 0; i < input.length; i++) {
    budget.charge();
    if (input.charCodeAt(i) === 60 && ++tags > MAX_HTML_TAG_MARKERS) {
      throw new ShareAssetError("Share HTML exceeds the 50,000 tag marker limit", "tags");
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
  constructor(private parser: ShareParser, private budget: WorkBudget) {
    super(parser.options, parser);
  }

  protected override _callState(cp: number): void {
    this.budget.charge();
    super._callState(cp);
  }

  protected override emitCurrentTagToken(): void {
    this.parser.checkWork();
    super.emitCurrentTagToken();
  }

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
    this.budget.charge(128);
    if (++this.tagAttributes > MAX_HTML_ATTRIBUTES_PER_TAG) {
      throw new ShareAssetError("Share HTML exceeds the 128 attributes per tag limit", "attributes");
    }
    if (++this.attributes > MAX_HTML_ATTRIBUTES) {
      throw new ShareAssetError("Share HTML exceeds the 100,000 total attributes limit", "attributes");
    }
    super._createAttr(first);
  }
}

/** Bound the REAL parser stacks, including implicit nodes and template modes.
 * Stack/formatting scans in pinned parse5 are at most 512 entries; reserve their
 * work before processing a token. Linked siblings avoid array scans during
 * tree repair. No completed DOM/depth approximation is used for admission.
 */
class ShareParser extends Parser<DefaultTreeAdapterMap> {
  constructor(private budget: WorkBudget, adapter: ReturnType<typeof shareTree>["adapter"]) {
    super({ treeAdapter: adapter });
  }

  checkWork(): void {
    const depth = this.openElements.stackTop + 1;
    const formatting = this.activeFormattingElements.entries.length;
    if (depth > MAX_HTML_DEPTH || formatting > MAX_HTML_DEPTH) this.budget.fail();
    // Adoption agency has at most eight rounds, with stack/list searches in
    // its inner loop. Reserve their product, not merely one stack scan.
    this.budget.charge(1 + depth + formatting + 8 * depth * (formatting + 1));
  }

  override onItemPush(node: DefaultTreeAdapterMap["parentNode"], tid: number, isTop: boolean): void {
    this.checkWork();
    super.onItemPush(node, tid, isTop);
  }

  override onEof(token: Token.EOFToken): void {
    this.checkWork();
    super.onEof(token);
  }
}

export function parseShareHtml(input: string, budget = new WorkBudget()): DefaultTreeAdapterMap["document"] {
  checkShareHtmlComplexity(input, budget);
  const tree = shareTree(budget);
  const parser = new ShareParser(budget, tree.adapter);
  parser.tokenizer = new ShareTokenizer(parser, budget);
  parser.tokenizer.write(input, true);
  tree.finish();
  budget.check();
  return parser.document;
}
