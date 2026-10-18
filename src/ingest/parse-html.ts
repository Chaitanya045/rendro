import type { Root } from "hast";
import { fromParse5 } from "hast-util-from-parse5";
import { defaultTreeAdapter, html as namespaces, Parser, Tokenizer, type DefaultTreeAdapterMap, type ParserOptions, type Token } from "parse5";

import { MAX_TREE_DEPTH, RenderError } from "@/ingest/limits";

/** Matches share-html: parse5's duplicate-attribute check is linear per attribute. */
export const MAX_ATTRIBUTES_PER_TAG = 128;
/** Reserved parser work for one document; real docs use a few million units. */
export const MAX_PARSE_WORK = 32_000_000;

/*
 * parse5 is the same spec-compliant tree builder the existing share code
 * uses, with the same guards on its real stacks. Its open-element and
 * formatting-list scans grow with depth, so unbounded nesting is quadratic.
 * Browsers stop nesting at 512 levels anyway. The guards fail closed before
 * that work happens.
 */
class BoundedTokenizer extends Tokenizer {
  private tagAttributes = 0;

  constructor(private parser: BoundedParser) {
    super(parser.options, parser);
  }

  protected override _createStartTagToken(): void {
    this.tagAttributes = 0;
    super._createStartTagToken();
  }

  protected override _createEndTagToken(): void {
    this.tagAttributes = 0;
    super._createEndTagToken();
  }

  protected override _createAttr(first: string): void {
    this.parser.charge(MAX_ATTRIBUTES_PER_TAG);
    if (++this.tagAttributes > MAX_ATTRIBUTES_PER_TAG) throw new RenderError("An element has more than 128 attributes", "too-complex");
    super._createAttr(first);
  }
}

class BoundedParser extends Parser<DefaultTreeAdapterMap> {
  private work = 0;

  // getFragmentParser constructs through `new this`, so install the tokenizer here.
  constructor(options?: ParserOptions<DefaultTreeAdapterMap>, document?: DefaultTreeAdapterMap["document"], fragmentContext?: DefaultTreeAdapterMap["element"] | null) {
    super(options, document, fragmentContext);
    this.tokenizer = new BoundedTokenizer(this);
  }

  charge(units: number): void {
    this.work += units;
    if (this.work > MAX_PARSE_WORK) throw new RenderError("Document is too complex to parse", "too-complex");
  }

  private checkStacks(): void {
    const depth = this.openElements.stackTop + 1;
    const formatting = this.activeFormattingElements.entries.length;
    if (depth > MAX_TREE_DEPTH || formatting > MAX_TREE_DEPTH) throw new RenderError("Document nesting exceeds 512 levels", "too-deep");
    // The adoption agency runs up to eight rounds of stack and list searches.
    this.charge(1 + depth + formatting + 8 * depth * (formatting + 1));
  }

  override onItemPush(node: DefaultTreeAdapterMap["parentNode"], tid: number, isTop: boolean): void {
    this.checkStacks();
    super.onItemPush(node, tid, isTop);
  }

  override onEof(token: Token.EOFToken): void {
    this.checkStacks();
    super.onEof(token);
  }
}

/** Parse a complete HTML document (a repo .html file) into hast. */
export function parseHtmlDocument(html: string): Root {
  const parser = new BoundedParser();
  parser.tokenizer.write(html, true);
  return fromParse5(parser.document) as Root;
}

/** Parse HTML as the children of <body>, as innerHTML does, into a hast root. */
export function parseHtmlFragment(html: string): Root {
  const parser = BoundedParser.getFragmentParser<DefaultTreeAdapterMap>(defaultTreeAdapter.createElement("body", namespaces.NS.HTML, []));
  parser.tokenizer.write(html, true);
  return fromParse5(parser.getFragment()) as Root;
}
