import { afterEach, describe, expect, it, vi } from "vitest";
import * as minio from "@/minio";
import worker from "@/worker";
import { assetContentType, assetHeaders, isHtmlAsset } from "@/routes/asset-headers";
import { cookie, publisherIsolationFixture } from "./fixtures/publisher-isolation";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  "text/css", "text/plain", "text/html", "text/javascript", "text/xml", "text/csv",
  "application/javascript", "application/ecmascript", "application/json", "application/xml",
  "application/xhtml+xml", "image/svg+xml", "application/ld+json",
])("preserves the charset of streamed %s without changing its isolation policy", type => {
  const stored = `${type.toUpperCase()}; CHARSET="WiNdOwS-1252"; unused=value`;
  const headers = assetHeaders("file", true, stored);
  expect(headers["Content-Type"]).toBe(`${type}; charset=windows-1252`);
  expect(headers["Content-Security-Policy"]).toBe(assetHeaders("file", true, type)["Content-Security-Policy"]);
  expect(headers["Access-Control-Allow-Origin"]).toBe("null");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  expect(isHtmlAsset("file", stored)).toBe(type === "text/html");
});

it.each([
  ["utf8", "utf-8"], ["LATIN1", "windows-1252"], ["US-ASCII", "windows-1252"],
  ["Shift_JIS", "shift_jis"], ["windows-31j", "shift_jis"], ["utf-16", "utf-16le"],
  ["UTF-16BE", "utf-16be"], ["GB18030", "gb18030"], ["ISO-8859-16", "iso-8859-16"],
  ["x-user-defined", "x-user-defined"], ["replacement", "replacement"],
  ["ISO_8859-1:1987", "windows-1252"],
])("allows WHATWG label %s with its canonical encoding", (label, encoding) => {
  expect(assetContentType("file", `text/plain; charset="${label}"`)).toBe(`text/plain; charset=${encoding}`);
});

it("discards unrelated parameters without interpreting their quoted contents", () => {
  expect(assetContentType("file", 'text/plain; note="value; charset=utf-7"; CHARSET = windows-1252\t; other=""'))
    .toBe("text/plain; charset=windows-1252");
  expect(assetContentType("file", 'text/plain; note="; charset=windows-1252"')).toBe("text/plain");
  expect(assetContentType("file", "text/plain; ignored=value")).toBe("text/plain");
});

it.each([
  "charset=utf-7", "charset=made-up", "charset=", 'charset=""', "charset='windows-1252'",
  'charset="windows-1252', 'charset="windows-1252"junk', 'charset="windows-1252\\"',
  "charset=windows-1252,utf-8", "charset=windows-1252; charset=utf-8",
  "charset=windows-1252; CHARSET=windows-1252", "charset=windows-1252; junk",
  "charset=windows-1252;", "charset=windows-1252\r\nX-Injected: yes",
  'charset="windows-1252\n"', "\ncharset=windows-1252", "charset*=windows-1252",
  "not-charset=windows-1252", "charset=windows-1252; injected=<html>",
])("rejects malformed, ambiguous or unallowlisted parameters: %j", parameters => {
  expect(assetContentType("file", `text/plain; ${parameters}`)).toBe("text/plain");
  expect(assetContentType("file.css", `text/css; ${parameters}`)).toBe("text/css; charset=utf-8");
});

it("retains existing defaults and does not attach charsets to binary or invalid types", () => {
  for (const [path, stored, expected] of [
    ["file.css", undefined, "text/css; charset=utf-8"], ["file.css", "text/css", "text/css; charset=utf-8"],
    ["file.html", undefined, "text/html; charset=utf-8"], ["file.html", "text/html", "text/html; charset=utf-8"],
    ["file.js", undefined, "application/javascript; charset=utf-8"], ["file.json", undefined, "application/json; charset=utf-8"],
    ["file", "text/plain", "text/plain"], ["file", "application/javascript", "application/javascript"],
    ["file", "application/json", "application/json"], ["file", "text/xml", "text/xml"],
    ["file.png", "image/png; charset=windows-1252", "image/png"],
    ["file.woff2", "text/plain; charset=windows-1252", "font/woff2"],
    ["file", "text/html,application/xml; charset=windows-1252", "application/octet-stream"],
  ]) expect(assetContentType(path!, stored)).toBe(expected);
});

describe("HTML encoding parity with main", () => {
  it("retains original non-UTF-8 bytes/charset on private streams and UTF-8 decoding on buffered routes", async () => {
    const { routes, files } = await publisherIsolationFixture();
    vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ files: files.map(file => ({
      path: file.path, contentType: "text/html; charset=windows-1252",
    })) }));
    vi.mocked(minio.headObject).mockResolvedValue({ contentType: "text/html; charset=windows-1252" });
    const bytes = new Uint8Array(Buffer.from('<!doctype html><html><head></head><body><p>caf\xe9</p></body></html>', "latin1"));
    vi.mocked(minio.getObjectStream).mockImplementation(() => Promise.resolve(new Response(bytes).body));
    for (const route of routes) {
      const response = await worker.request(`https://rendro.test${route.url(0)}`, {
        headers: route.signedIn ? { Cookie: cookie } : {},
      });
      expect(response.status, route.name).toBe(200);
      const privateStream = ["private", "private ticket", "legacy private", "legacy ticket"].includes(route.name);
      expect(response.headers.get("Content-Type"), route.name).toBe(`text/html; charset=${privateStream ? "windows-1252" : "utf-8"}`);
      const body = new Uint8Array(await response.arrayBuffer());
      // Streaming injectors leave invalid UTF-8 untouched; extension-only shares
      // already lacked the stored charset on main. Buffered routes decode UTF-8.
      if (privateStream || route.name === "share") expect(body, route.name).toEqual(bytes);
      else expect(new TextDecoder().decode(body), route.name).toContain("caf\ufffd");
    }
  });
});
