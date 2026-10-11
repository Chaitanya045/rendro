import { describe, expect, it } from "vitest";
import { injectViewerHeadStream } from "@/routes/document-html";
import { viewerHtmlForms } from "./fixtures/private-viewer-html";

const markup = '<base data-rendro-viewer href="/ticket/files/guide/index.html">';
const encoder = new TextEncoder();
function stream(bytes: Uint8Array, split: number) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, split));
    controller.enqueue(bytes.slice(split));
    controller.close();
  } });
}

describe("early viewer head streaming", () => {
  it.each(viewerHtmlForms)("inserts before the first resource across every byte split: %s", async (_name, source) => {
    const bytes = encoder.encode(source);
    for (let split = 0; split <= bytes.length; split++) {
      const output = await new Response(injectViewerHeadStream(stream(bytes, split), () => markup)).text();
      expect(output.replace(markup, "")).toBe(source);
      expect(output.indexOf(markup)).toBeLessThan(output.toLowerCase().indexOf("<link "));
      expect(output.split(markup)).toHaveLength(2);
    }
  });

  it.each(["<!doctype html>", "<!doctype html><html>", "<!-- prelude --><!doctype html>"])("handles complete resource-free start %s", async source => {
    const output = await new Response(injectViewerHeadStream(new Response(source).body!, () => markup)).text();
    expect(output).toBe(source + markup);
  });

  it("finds a publisher base even when it arrives after title/meta in another chunk", async () => {
    const source = '<!doctype html><title>Not a <base href="wrong/"> tag</title><meta charset="utf-8"><BASE HREF="../shared/?a=1&amp;b=2"><link href="site.css" rel="stylesheet"><body>Docs';
    const bytes = encoder.encode(source);
    for (let split = 0; split <= bytes.length; split++) {
      const bases: Array<string | undefined> = [];
      const output = await new Response(injectViewerHeadStream(stream(bytes, split), base => {
        bases.push(base); return markup;
      })).text();
      expect(bases).toEqual(["../shared/?a=1&b=2"]);
      expect(output.replace(markup, "")).toBe(source);
      expect(output.indexOf(markup)).toBeLessThan(output.indexOf("<link"));
    }
  });

  it("preserves a BOM and releases a bounded oversized head before EOF", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const reader = injectViewerHeadStream(input, () => markup, 128).getReader();
    const source = '\ufeff<!doctype html><html><head><link href="site.css"><!--' + 'x'.repeat(1000);
    controller.enqueue(encoder.encode(source));
    const chunks = [];
    for (let i = 0; i < 4; i++) chunks.push((await reader.read()).value!);
    const result = Buffer.concat(chunks);
    expect(result.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(result.toString().replace(markup, "")).toBe(source);
    await reader.cancel();
  });
});
