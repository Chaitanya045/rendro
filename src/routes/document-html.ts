import { parse, type DefaultTreeAdapterMap } from "parse5";

type ParsedElement = DefaultTreeAdapterMap["element"];

// parse5 follows the HTML tree-construction rules: every input, even empty or
// truncated, produces <html> and <head>. Only <body> is optional (framesets).
function parseDocument(html: string) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => node.nodeName === "html") as ParsedElement;
  const head = root.childNodes.find((node) => node.nodeName === "head") as ParsedElement;
  const body = root.childNodes.find((node) => node.nodeName === "body") as ParsedElement | undefined;
  return { document, head, body, root };
}

/** Bump when the injectors change what they emit for the same input: it is
 * part of the validator of head-injected representations (object-delivery.ts). */
export const HEAD_INJECTION_VERSION = 1;

const MOBILE_VIEWPORT_SCROLLBAR_STYLE = `<style data-rendro-mobile-viewport>
@media (max-width: 760px) {
  :root { scrollbar-width: none; }
  :root::-webkit-scrollbar { display: none; width: 0; height: 0; }
}
</style>`;

export function injectMobileViewportScrollbarStyle(html: string): string {
  return injectMarkup(html, MOBILE_VIEWPORT_SCROLLBAR_STYLE, true, "data-rendro-mobile-viewport");
}

function markupInsertionOffset(html: string, complete: boolean): number | undefined {
  // Parse only a bounded prefix, and splice the original markup rather than
  // serializing publisher HTML. Raw text, comments and quoted attributes can
  // contain closing-tag lookalikes. A truncated/implicit head is not an anchor.
  const { head, body } = parseDocument(html.slice(0, 64 * 1024));
  const headStart = head.sourceCodeLocation?.startTag?.endOffset;
  // Fragments have implicit head/body elements. Their first parsed child's
  // beginning is also safe, unlike a guessed position inside an unfinished tag.
  const headContent = head.childNodes[0]?.sourceCodeLocation?.startOffset;
  const bodyContent = body?.childNodes[0]?.sourceCodeLocation?.startOffset;
  // EOF can turn an incomplete '<' into fragment text. Only use implicit
  // fragment anchors when this is genuinely the complete, untruncated input.
  const fragmentOffset = complete && html.length <= 64 * 1024 ? headContent ?? bodyContent : undefined;
  const offset = headStart ?? body?.sourceCodeLocation?.startOffset ?? fragmentOffset;
  // If there is no explicit safe boundary in the prefix, leave the document
  // untouched: cosmetic scrollbar styling must never damage publisher content.
  return offset;
}

function injectMarkup(html: string, markup: string, complete: boolean, marker?: string): string {
  if (marker && html.includes(marker)) return html;
  const offset = markupInsertionOffset(html, complete);
  return offset === undefined ? html : html.slice(0, offset) + markup + html.slice(offset);
}

export async function readHtmlStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    html += decoder.decode(result.value, { stream: true });
  }
  return html + decoder.decode();
}

export function injectMobileViewportScrollbarStream(
  stream: ReadableStream<Uint8Array>,
  maxPrefixBytes = 64 * 1024,
): ReadableStream<Uint8Array> {
  return injectHtmlHeadStream(
    stream,
    MOBILE_VIEWPORT_SCROLLBAR_STYLE,
    "data-rendro-mobile-viewport",
    maxPrefixBytes,
  );
}

/**
 * Inserts trusted integration markup at a parser-confirmed head/body boundary
 * while buffering at most a bounded prefix. Publisher bytes after that prefix
 * continue streaming unchanged; raw-text/comment lookalikes are never anchors.
 */
export function injectHtmlHeadStream(
  stream: ReadableStream<Uint8Array>,
  markup: string,
  marker?: string,
  maxPrefixBytes = 64 * 1024,
): ReadableStream<Uint8Array> {
  return injectHtmlPrefixStream(stream, (html, complete) => {
    const offset = markupInsertionOffset(html, complete);
    return offset === undefined ? undefined : { offset, markup };
  }, marker, maxPrefixBytes, /<head\b[^>]*>|<\/head\s*>|<body\b[^>]*>/i);
}

/**
 * Resource bases need an earlier boundary than cosmetic integrations. Inspect
 * the bounded head before emitting any bytes, so a publisher base is known and
 * implicit heads get the integration before their first child, not at <body>.
 * Valid publisher bases precede URL-bearing resources. On an oversized head,
 * that contract lets us decide from the bounded prefix without buffering a file.
 */
export function injectViewerHeadStream(
  stream: ReadableStream<Uint8Array>,
  markup: (publisherBase: string | undefined) => string,
  maxPrefixBytes = 64 * 1024,
): ReadableStream<Uint8Array> {
  return injectHtmlPrefixStream(stream, (html, complete) => {
    const { document, root, head, body } = parseDocument(html);
    const children = head.childNodes;
    const headLocation = head.sourceCodeLocation;
    const headClosed = headLocation?.endTag;
    const bodyContent = body?.childNodes[0]?.sourceCodeLocation?.startOffset;
    const bodyElement = body?.childNodes.some(node =>
      node.sourceCodeLocation && "startTag" in node.sourceCodeLocation && node.sourceCodeLocation.startTag);
    // EOF in a partial '<title' can produce implicit body text. Only a complete
    // element or explicit head close proves the head has ended before EOF.
    if (!complete && !headClosed && !body?.sourceCodeLocation && !bodyElement) return undefined;
    const publisherBase = children.find(node => node.nodeName === "base"
      && "attrs" in node && node.attrs.some(attr => attr.name === "href"));
    const href = publisherBase && "attrs" in publisherBase
      ? publisherBase.attrs.find(attr => attr.name === "href")?.value : undefined;
    const headStart = headLocation?.startTag?.endOffset;
    const rootStart = root.sourceCodeLocation?.startTag?.endOffset;
    const doctype = document.childNodes.find(node => node.nodeName === "#documentType");
    const offset = headStart ?? children[0]?.sourceCodeLocation?.startOffset
      ?? body?.sourceCodeLocation?.startOffset ?? bodyContent
      ?? rootStart ?? doctype?.sourceCodeLocation?.endOffset ?? 0;
    return { offset, markup: markup(href) };
  }, undefined, maxPrefixBytes, />/, true);
}

function injectHtmlPrefixStream(
  stream: ReadableStream<Uint8Array>,
  insertion: (html: string, complete: boolean) => { offset: number; markup: string } | undefined,
  marker: string | undefined,
  maxPrefixBytes: number,
  candidatePattern: RegExp,
  decideAtLimit = false,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const prefix = new Uint8Array(maxPrefixBytes);
  let prefixLength = 0;
  let decided = false;

  const decodePrefix = (
    bytes: Uint8Array,
    complete: boolean,
  ): { html: string; bomBytes: number } | null => {
    try {
      return {
        html: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !complete }),
        bomBytes: bytes.length >= 3
          && bytes[0] === 0xef
          && bytes[1] === 0xbb
          && bytes[2] === 0xbf ? 3 : 0,
      };
    } catch {
      return null;
    }
  };

  const emitDecision = (
    controller: TransformStreamDefaultController<Uint8Array>,
    complete: boolean,
  ): boolean => {
    const bytes = prefix.subarray(0, prefixLength);
    // Keep an incomplete trailing code point out of the parsed string. If no
    // safe insertion point exists, the original bytes are emitted verbatim.
    const decoded = decodePrefix(bytes, complete);
    // Without a one-to-one UTF-8 mapping, a parser character offset cannot be
    // translated safely back into the publisher's original byte stream.
    if (decoded === null) {
      // Empty input always decodes, so a failure implies bytes were buffered.
      controller.enqueue(bytes);
      decided = true;
      return true;
    }
    const { html, bomBytes } = decoded;
    if (marker && html.includes(marker)) {
      controller.enqueue(bytes);
      decided = true;
      return true;
    }
    const decision = insertion(html, complete || (decideAtLimit && prefixLength >= maxPrefixBytes));
    if (decision !== undefined) {
      const { offset, markup } = decision;
      const byteOffset = bomBytes + encoder.encode(html.slice(0, offset)).byteLength;
      if (byteOffset > 0) controller.enqueue(bytes.subarray(0, byteOffset));
      controller.enqueue(encoder.encode(markup));
      if (byteOffset < bytes.byteLength) controller.enqueue(bytes.subarray(byteOffset));
      decided = true;
      return true;
    }
    if (complete || prefixLength >= maxPrefixBytes) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      decided = true;
      return true;
    }
    return false;
  };

  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (decided) {
        controller.enqueue(chunk);
        return;
      }

      const take = Math.min(chunk.byteLength, maxPrefixBytes - prefixLength);
      if (take > 0) {
        prefix.set(chunk.subarray(0, take), prefixLength);
        prefixLength += take;
      }
      const candidate = decodePrefix(prefix.subarray(0, prefixLength), false);
      if (
        candidate === null
        || candidatePattern.test(candidate.html)
        || prefixLength >= maxPrefixBytes
      ) {
        emitDecision(controller, false);
      }
      if (decided && take < chunk.byteLength) controller.enqueue(chunk.subarray(take));
    },
    flush(controller) {
      if (!decided) emitDecision(controller, true);
    },
  }));
}
