import { expect, it } from "vitest";
import { contentType } from "../cli/src/content-type";

it.each([
  ["style.css", "text/css"], ["index.HTML", "text/html"], ["app.js", "text/javascript"],
  ["data.json", "application/json"], ["app.js.map", "application/json"],
  ["readme.txt", "text/plain"], ["image.svg", "image/svg+xml"],
  ["image.gif", "image/gif"], ["favicon.ico", "image/x-icon"],
  ["photo.jpeg", "image/jpeg"], ["photo.jpg", "image/jpeg"], ["photo.png", "image/png"],
  ["photo.webp", "image/webp"], ["font.woff", "font/woff"], ["font.woff2", "font/woff2"],
  ["unknown.bin", "application/octet-stream"], ["LICENSE", "application/octet-stream"],
])("uses only the media type for %s without a BOM", (path, expected) => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("plain ASCII"), Buffer.from("café €"),
    Buffer.from('@charset "windows-1252"; p::before{content:"caf\xe9 \x80"}', "latin1"),
    Buffer.from('<meta charset="windows-1252"><p>caf\xe9</p>', "latin1")]) {
    expect(contentType(path, bytes)).toBe(expected);
  }
});
it.each([
  [[0xef, 0xbb, 0xbf], "utf-8"], [[0xff, 0xfe], "utf-16le"], [[0xfe, 0xff], "utf-16be"],
])("records a complete BOM %j only for recognized text media", (bom, charset) => {
  for (const path of ["style.css", "index.html", "app.js", "data.json", "app.map", "readme.txt", "image.svg"]) {
    expect(contentType(path, Uint8Array.from(bom))).toBe(`${contentType(path, new Uint8Array())}; charset=${charset}`);
  }
  expect(contentType("image.png", Uint8Array.from(bom))).toBe("image/png");
  expect(contentType("unknown", Uint8Array.from(bom))).toBe("application/octet-stream");
});
it.for([
  [], [0xef], [0xef, 0xbb], [0xef, 0x00, 0xbf], [0xef, 0xbb, 0x00],
  [0xff], [0xff, 0x00], [0xfe], [0xfe, 0x00],
  [0xff, 0xfe, 0, 0], [0, 0, 0xfe, 0xff],
])("does not guess from truncated, invalid or UTF-32 BOM bytes %j", bytes => {
  expect(contentType("file.txt", Uint8Array.from(bytes))).toBe("text/plain");
});
it("recognizes UTF-16LE when the third or fourth byte is nonzero", () => {
  expect(contentType("file.txt", Uint8Array.from([0xff, 0xfe, 65, 0]))).toBe("text/plain; charset=utf-16le");
  expect(contentType("file.txt", Uint8Array.from([0xff, 0xfe, 0, 65]))).toBe("text/plain; charset=utf-16le");
});
