import { parse } from "parse5";

const MOBILE_VIEWPORT_SCROLLBAR_STYLE = `<style data-rendro-mobile-viewport>
@media (max-width: 760px) {
  :root { scrollbar-width: none; }
  :root::-webkit-scrollbar { display: none; width: 0; height: 0; }
}
</style>`;

export function injectMobileViewportScrollbarStyle(html: string): string {
  return injectStyle(html, true);
}

function injectStyle(html: string, complete: boolean): string {
  if (html.includes("data-rendro-mobile-viewport")) return html;
  // Parse only a bounded prefix, and splice the original markup rather than
  // serializing publisher HTML. Raw text, comments and quoted attributes can
  // contain closing-tag lookalikes. A truncated/implicit head is not an anchor.
  const document = parse(html.slice(0, 64 * 1024), { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => node.nodeName === "html");
  if (!root || !("childNodes" in root)) return html;
  const head = root.childNodes.find((node) => node.nodeName === "head");
  const body = root.childNodes.find((node) => node.nodeName === "body");
  const headStart = head?.sourceCodeLocation && "startTag" in head.sourceCodeLocation
    ? head.sourceCodeLocation.startTag?.endOffset : undefined;
  // Fragments have implicit head/body elements. Their first parsed child's
  // beginning is also safe, unlike a guessed position inside an unfinished tag.
  const headContent = head && "childNodes" in head ? head.childNodes[0]?.sourceCodeLocation?.startOffset : undefined;
  const bodyContent = body && "childNodes" in body ? body.childNodes[0]?.sourceCodeLocation?.startOffset : undefined;
  // EOF can turn an incomplete '<' into fragment text. Only use implicit
  // fragment anchors when this is genuinely the complete, untruncated input.
  const fragmentOffset = complete && html.length <= 64 * 1024 ? headContent ?? bodyContent : undefined;
  const offset = headStart ?? body?.sourceCodeLocation?.startOffset ?? fragmentOffset;
  // If there is no explicit safe boundary in the prefix, leave the document
  // untouched: cosmetic scrollbar styling must never damage publisher content.
  if (offset === undefined) return html;
  return html.slice(0, offset) + MOBILE_VIEWPORT_SCROLLBAR_STYLE + html.slice(offset);
}

export async function readHtmlStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) html += decoder.decode(result.value, { stream: true });
  }
  return html + decoder.decode();
}

export function injectMobileViewportScrollbarStream(
  stream: ReadableStream<Uint8Array>,
  maxPrefixBytes = 64 * 1024,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let prefix = "";
  let prefixBytes = 0;
  let injected = false;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      if (injected) {
        if (text) controller.enqueue(encoder.encode(text));
        return;
      }
      prefix += text;
      prefixBytes += chunk.byteLength;
      if (/<\/head\s*>|<body\b[^>]*>/i.test(prefix) || prefixBytes >= maxPrefixBytes) {
        const styled = injectStyle(prefix, false);
        // A textual match may only be a lookalike in an unfinished comment.
        // Keep looking for a real boundary, but never buffer past the budget.
        if (styled === prefix && !prefix.includes("data-rendro-mobile-viewport") && prefixBytes < maxPrefixBytes) return;
        controller.enqueue(encoder.encode(styled));
        prefix = "";
        injected = true;
      }
    },
    flush(controller) {
      const tail = decoder.decode();
      if (injected) {
        if (tail) controller.enqueue(encoder.encode(tail));
      } else {
        controller.enqueue(encoder.encode(injectMobileViewportScrollbarStyle(prefix + tail)));
      }
    },
  }));
}
