import { describe, expect, it } from "vitest";
import { escapeHtml } from "@/routes/html";
import {
  injectHtmlHeadStream, injectMobileViewportScrollbarStream, injectMobileViewportScrollbarStyle,
  injectViewerHeadStream, readHtmlStream,
} from "@/routes/document-html";

const markup = '<base data-rendro-viewer href="/ticket/">';
const encoder = new TextEncoder();
function chunked(...chunks: Array<string | Uint8Array>) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    controller.close();
  } });
}
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

// The parser synthesizes <html> and <head> for any input, even ones that are
// not documents at all; framesets are the only documents without a <body>.
const degenerate = ["", "<", "\0", "text", "<!-- only a comment -->", "<!doctype html>", "<![CDATA[x]]>", "<p", "<frameset></frameset>",
  "<html><head></head><frameset><frame></frameset></html>", "</html>", "<html>", "<head>", "<body>", "<title>"];

describe("HTML injection anchors", () => {
  it.each(degenerate)("never damages publisher bytes for %j", async source => {
    for (const split of [0, Math.floor(source.length / 2), source.length]) {
      const bytes = encoder.encode(source);
      const viewer = await text(injectViewerHeadStream(chunked(bytes.slice(0, split), bytes.slice(split)), () => markup));
      expect(viewer.replace(markup, "")).toBe(source);
      expect(viewer.split(markup).length).toBeLessThanOrEqual(2);
      const mobile = await text(injectMobileViewportScrollbarStream(chunked(bytes.slice(0, split), bytes.slice(split))));
      expect(mobile.replace(/<style data-rendro-mobile-viewport>[\s\S]*?<\/style>/, "")).toBe(source);
      expect(injectMobileViewportScrollbarStyle(source).replace(/<style data-rendro-mobile-viewport>[\s\S]*?<\/style>/, "")).toBe(source);
    }
  });

  it("anchors a viewer base before a leading comment of an otherwise empty document", async () => {
    expect(await text(injectViewerHeadStream(chunked("<!-- c -->"), () => markup))).toBe(`${markup}<!-- c -->`);
    expect(await text(injectViewerHeadStream(chunked(""), () => markup))).toBe(markup);
  });

  it("inserts into framesets, which have a head but no body", async () => {
    const source = "<html><head><title>T</title></head><frameset><frame src=a.html></frameset></html>";
    expect(await text(injectViewerHeadStream(chunked(source), () => markup))).toBe(source.replace("<head>", `<head>${markup}`));
    expect(injectMobileViewportScrollbarStyle(source)).toContain('<head><style data-rendro-mobile-viewport>');
    // Without any explicit head or body there is no safe anchor for cosmetic markup.
    const bare = "<frameset><frame src=a.html></frameset>";
    expect(injectMobileViewportScrollbarStyle(bare)).toBe(bare);
    expect(await text(injectMobileViewportScrollbarStream(chunked(bare)))).toBe(bare);
  });

  it("passes through a document that already carries the cosmetic marker, across later chunks", async () => {
    const source = '<!doctype html><head><style data-rendro-mobile-viewport>x{}</style></head><body>';
    const output = await text(injectMobileViewportScrollbarStream(chunked(source, "<p>later</p>")));
    expect(output).toBe(`${source}<p>later</p>`);
  });

  it("tolerates empty chunks and a decision that is already made when the stream ends", async () => {
    const source = "<!doctype html><html><head></head><body>Docs</body></html>";
    const output = await text(injectMobileViewportScrollbarStream(chunked(new Uint8Array(0), source, new Uint8Array(0), "<p>tail</p>")));
    expect(output).toBe(source.replace("<head>", '<head><style data-rendro-mobile-viewport>\n@media (max-width: 760px) {\n  :root { scrollbar-width: none; }\n  :root::-webkit-scrollbar { display: none; width: 0; height: 0; }\n}\n</style>') + "<p>tail</p>");
    expect(await text(injectHtmlHeadStream(chunked(new Uint8Array(0)), markup))).toBe("");
  });

  it("emits invalid UTF-8 verbatim because parser offsets cannot be mapped to bytes", async () => {
    const bytes = Uint8Array.from([...encoder.encode("<head>"), 0xff, 0xfe, ...encoder.encode("</head>")]);
    expect(Buffer.from(await new Response(injectHtmlHeadStream(chunked(bytes), markup)).arrayBuffer())).toEqual(Buffer.from(bytes));
  });

  it("decodes multi-byte text split across chunks when buffering a whole stream", async () => {
    const bytes = encoder.encode("héllo ✓");
    expect(await readHtmlStream(chunked(bytes.slice(0, 2), bytes.slice(2, 8), bytes.slice(8)))).toBe("héllo ✓");
  });
});

describe("escapeHtml", () => {
  it("escapes the five markup-significant characters, including repeats, and nothing else", () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;amp;&lt;/a&gt;");
    expect(escapeHtml("plain text é ✓")).toBe("plain text é ✓");
    expect(escapeHtml("")).toBe("");
  });
});
