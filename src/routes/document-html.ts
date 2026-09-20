const MOBILE_VIEWPORT_SCROLLBAR_STYLE = `<style data-rendro-mobile-viewport>
@media (max-width: 760px) {
  :root { scrollbar-width: none; }
  :root::-webkit-scrollbar { display: none; width: 0; height: 0; }
}
</style>`;

export function injectMobileViewportScrollbarStyle(html: string): string {
  if (html.includes("data-rendro-mobile-viewport")) return html;
  const headClose = /<\/head\s*>/i;
  if (headClose.test(html)) {
    return html.replace(headClose, (match) => `${MOBILE_VIEWPORT_SCROLLBAR_STYLE}${match}`);
  }
  const bodyOpen = /<body\b[^>]*>/i;
  if (bodyOpen.test(html)) {
    return html.replace(bodyOpen, (match) => `${MOBILE_VIEWPORT_SCROLLBAR_STYLE}${match}`);
  }
  const doctype = /<!doctype\s+html[^>]*>/i;
  if (doctype.test(html)) {
    return html.replace(doctype, (match) => `${match}${MOBILE_VIEWPORT_SCROLLBAR_STYLE}`);
  }
  return `${MOBILE_VIEWPORT_SCROLLBAR_STYLE}${html}`;
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
        controller.enqueue(encoder.encode(injectMobileViewportScrollbarStyle(prefix)));
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
