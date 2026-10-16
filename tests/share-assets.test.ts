import { describe, expect, it, vi } from "vitest";
import { collectShareAssets, isShareDocument } from "../src/share-assets";
import { validShareAssets } from "../shared/share-assets";

type File = { path: string; contentType: string; body?: string | Uint8Array<ArrayBuffer> };
function fixture(html: string, files: File[] = [], documentPath = "guide/index.html") {
  const entries: File[] = [{ path: documentPath, contentType: "text/html", body: html }, ...files];
  const read = vi.fn((path: string) => {
    const body = entries.find(file => file.path === path)?.body;
    return Promise.resolve(body === undefined ? null : new Response(body).body);
  });
  return { entries, read, collect: () => collectShareAssets({ files: entries }, documentPath, read) };
}
const resource = (path: string, contentType = "image/png", body = "") => ({ path, contentType, body });

describe("share dependency discovery", () => {
  it.each(["index.html", "guide/index.html"])("includes direct resources and one stylesheet level for %s", async documentPath => {
    const dir = documentPath === "index.html" ? "" : "guide/";
    const f = fixture(`<!doctype html><link rel="STYLESHEET" href="style.css"><link rel="icon" href="icon">
      <link rel="preload" href="font"><link rel="modulepreload" href="module">
      <img src="image" srcset="small 1x, large 2x"><picture><source srcset="wide 800w, wider 1600w"></picture>
      <video src="movie" poster="poster"><source src="source"><track src="track"></video><audio src="audio"></audio>
      <script src="script"></script><object data="object"></object><embed src="embed"><input type="image" src="button">
      <svg><image href="svg-image"/><use href="sprite#icon"/></svg>
      <link rel="preload" imagesrcset="preloaded 1x"><div style="background:url(inline)"></div>
      <style>p{background:url(block)} /* url(private) */ p::before{content:'url(private)'}</style>
      <a href="private">Private</a><iframe src="private"></iframe><link rel="alternate" href="private">
      <template><img src="private"></template><img><link>`, [
      resource(dir + "style.css", "text/css", '@font-face{src:url(css-font)} p{background:url(css-image)} @import "import.css";'),
      resource(dir + "import.css", "text/css", 'p{background:url(private)}'),
      ...["icon", "font", "module", "image", "small", "large", "wide", "wider", "movie", "poster", "source", "track", "audio", "script", "object", "embed", "button", "svg-image", "sprite", "preloaded", "inline", "block", "css-font", "css-image", "private"].map(path => resource(dir + path)),
    ], documentPath);
    const result = await f.collect();
    expect(result).toEqual(f.entries.slice(1).filter(file => file.path !== dir + "private").map(file => file.path).sort());
    expect(f.read.mock.calls.map(([path]) => path)).toEqual([documentPath, dir + "style.css"]);
  });

  it("normalizes URL paths once and excludes navigation, external, absent and HTML resources", async () => {
    const f = fixture(`<img src="../assets/a%20b.png?size=2#image">
      <img srcset="data:image/png;base64,AAAA 1x, ../assets/percent%2520.png 2x">
      <img src="./sub/../same.png"><img src="/root.png"><img src="../assets/%2Fbad.png"><img src="bad%zz">
      <img src="https://share.invalid/root.png"><img src="//share.invalid/root.png"><img src="https://outside.test/root.png"><img src="//outside.test/root.png"><img src="data:image/png,xx">
      <img src="https://user:pass@share.invalid/root.png"><img src="http://[invalid"><img src=" "><img src="#icon">
      <script src="secret.js"></script><object data="other.htm"></object><embed src="other.xhtml">
      <img srcset="same.png 1x ( private.json"><img src="missing"><img src="index.html"><img src="same.png"><img srcset="same.png, /root.png 2x, same.png calc(1,2)">`, [
      resource("assets/a b.png"), resource("assets/percent%20.png"), resource("guide/same.png"), resource("root.png"),
      resource("guide/AAAA"), resource("guide/private.json", "application/json"), resource("guide/secret.js", " Text/Html ; charset=utf-8"), resource("guide/other.htm", "text/html"), resource("guide/other.xhtml", "application/xhtml+xml"),
    ]);
    expect(await f.collect()).toEqual(["assets/a b.png", "assets/percent%20.png", "guide/same.png", "root.png"]);
  });

  it.each([['<base href="../assets/"><base href="/ignored/">', ["assets/image"]], ['<base href="http://[invalid">', ["guide/image"]], ['<base href="https://outside.test/">', []], ['<base href="https://share.invalid/">', []], ['<base><base href="">', ["guide/image"]]])("respects the first base: %s", async (base, expected) => {
    expect(await fixture(base + '<img src="image">', [resource("assets/image"), resource("guide/image")]).collect()).toEqual(expected);
  });

  it("decodes CSS escapes, imports, and manifest charsets without following imported CSS", async () => {
    const f = fixture('<link rel="stylesheet" href="style"><img src="already">', [
      resource("guide/style", "text/css; charset=windows-1252", 'p{background:u\\72l("caf\\e9.png")} @\\69mport url(import); @import "second";'),
      resource("guide/café.png"), resource("guide/import", "text/css", "url(private)"), resource("guide/second", "text/css"), resource("guide/already"),
    ]);
    expect(await f.collect()).toEqual(["guide/already", "guide/café.png", "guide/import", "guide/second", "guide/style"]);
  });

  it.each(["\u00a0", "\u2028", "\u3000", "\u0085", "\u200b", "\ufeff"])("does not split or trim Unicode URL characters %j", async whitespace => {
    const exact = `private.json${whitespace}1x`;
    const f = fixture(`<img srcset="${exact}"><img src="${whitespace}image${whitespace}">
      <style>@import "${whitespace}sheet"; p{background:url(${whitespace}background)}</style>
      <link rel="alternate${whitespace}preload" href="private.json">`, [
      resource("guide/private.json", "application/json"), resource("guide/" + exact),
      ...["image", `${whitespace}image${whitespace}`, "sheet", `${whitespace}sheet`, "background", `${whitespace}background`].map(p => resource("guide/" + p)),
    ]);
    expect(await f.collect()).toEqual([exact, `${whitespace}image${whitespace}`, `${whitespace}sheet`, `${whitespace}background`].map(p => "guide/" + p).sort());
  });

  it("traverses wide documents below the byte limit without an argument stack overflow", async () => {
    expect(await fixture('<i></i>'.repeat(150000) + '<img src="image">', [resource("guide/image")]).collect()).toEqual(["guide/image"]);
  });

  it("sniffs declarations and BOMs across storage chunks", async () => {
    const data = new TextEncoder().encode('\ufeff<meta charset=windows-1252><img src="café.png">');
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
      for (const byte of data) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const f = fixture("", [resource("guide/café.png")]);
    f.read.mockResolvedValueOnce(stream);
    expect(await f.collect()).toEqual(["guide/café.png"]);
  });

  it("fails clearly when the runtime cannot decode a declared encoding", async () => {
    const f = fixture('<link rel="stylesheet" href="style">', [resource("guide/style", "text/css; charset=replacement", "x")]);
    await expect(f.collect()).rejects.toThrow("unsupported text encoding");
  });

  it("rejects missing/non-HTML documents and missing source objects", async () => {
    for (const files of [[], [resource("index.html", "application/xhtml+xml")], [resource("index.html", "image/png")]]) {
      await expect(collectShareAssets({ files }, "index.html", vi.fn())).rejects.toThrow("HTML document");
    }
    const f = fixture('<link rel="stylesheet" href="style">', [{ path: "guide/style", contentType: "text/css" }]);
    await expect(f.collect()).rejects.toThrow("unavailable");
    f.read.mockResolvedValue(null);
    await expect(f.collect()).rejects.toThrow("unavailable");
  });

  it("fails clearly at the path count, payload byte, and cumulative source byte limits", async () => {
    const files = Array.from({ length: 501 }, (_, i) => resource(`guide/${i}.png`));
    await expect(fixture(files.map(file => `<img src="/${file.path}">`).join(""), files).collect()).rejects.toThrow("500 paths / 64 KiB");
    const long = "x".repeat(64 * 1024);
    await expect(fixture(`<img src="${long}">`, [resource("guide/" + long)]).collect()).rejects.toThrow("500 paths / 64 KiB");
    const f = fixture('<link rel="stylesheet" href="style">', [resource("guide/style", "text/css", " ".repeat(8 * 1024 * 1024))]);
    await expect(f.collect()).rejects.toThrow("8 MiB");
    expect(validShareAssets(files.slice(0, 500).map(file => file.path))).toBe(true);
    for (const invalid of [undefined, null, [1], ["../file"], Array(501).fill("a"), [long]]) expect(validShareAssets(invalid)).toBe(false);
    expect(validShareAssets([])).toBe(true);
    expect(isShareDocument("application/xhtml+xml")).toBe(true);
  });
});
