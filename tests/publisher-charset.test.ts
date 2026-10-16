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
  expect(assetContentType("file.css", `text/css; ${parameters}`)).toBe("text/css");
  expect(assetContentType("file.html", `text/html; ${parameters}`)).toBe("text/html");
});

it("retains existing defaults and does not attach charsets to binary or invalid types", () => {
  for (const [path, stored, expected] of [
    ["file.css", undefined, "text/css; charset=utf-8"], ["file.css", "text/css", "text/css"],
    ["file.html", undefined, "text/html; charset=utf-8"], ["file.html", "text/html", "text/html"],
    ["file.js", undefined, "application/javascript; charset=utf-8"], ["file.json", undefined, "application/json; charset=utf-8"],
    ["file", "text/plain", "text/plain"], ["file", "application/javascript", "application/javascript"],
    ["file", "application/json", "application/json"], ["file", "text/xml", "text/xml"],
    ["file.png", "image/png; charset=windows-1252", "image/png"],
    ["file.woff2", "text/plain; charset=windows-1252", "font/woff2"],
    ["file", "text/html,application/xml; charset=windows-1252", "application/octet-stream"],
  ]) expect(assetContentType(path!, stored)).toBe(expected);
});

describe("HTML encoding parity with main", () => {
  it.each([
    ["text/html; charset=windows-1252", "text/html; charset=windows-1252"],
    ["text/html", "text/html"],
    ["TEXT/HTML; ignored=value", "text/html"],
    ["text/html; charset=unknown", "text/html"],
  ])("preserves private stream bytes and declares buffered UTF-8 for %s", async (stored, expected) => {
    const { routes, files } = await publisherIsolationFixture();
    vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ files: files.map(file => ({
      path: file.path, contentType: stored,
    })) }));
    vi.mocked(minio.headObject).mockResolvedValue({ contentType: stored });
    const bytes = new Uint8Array(Buffer.from('<!doctype html><html><head></head><body><p>caf\xe9</p></body></html>', "latin1"));
    vi.mocked(minio.getObjectStream).mockImplementation(() => Promise.resolve(new Response(bytes).body));
    for (const route of routes) {
      const response = await worker.request(`https://rendro.test${route.url(0)}`, {
        headers: route.signedIn ? { Cookie: cookie } : {},
      });
      expect(response.status, route.name).toBe(200);
      const privateStream = ["share", "private", "private ticket", "legacy private", "legacy ticket"].includes(route.name);
      expect(response.headers.get("Content-Type"), route.name).toBe(privateStream ? expected : "text/html; charset=utf-8");
      const body = new Uint8Array(await response.arrayBuffer());
      // Streaming injectors preserve bytes and manifest charsets. Buffered routes decode UTF-8.
      if (privateStream || route.name === "share") expect(body, route.name).toEqual(bytes);
      else expect(new TextDecoder().decode(body), route.name).toContain("caf\ufffd");
    }
  });
});

// These are main's extension defaults, independent of stored MIME metadata.
it.each([
  ["css", "text/css; charset=utf-8"], ["html", "text/html; charset=utf-8"],
  ["js", "application/javascript; charset=utf-8"], ["json", "application/json; charset=utf-8"],
  ["gif", "image/gif"], ["jpeg", "image/jpeg"], ["jpg", "image/jpeg"],
  ["png", "image/png"], ["svg", "image/svg+xml"], ["webp", "image/webp"],
  ["woff2", "font/woff2"], ["woff", "font/woff"], ["ttf", "font/ttf"],
  ["otf", "font/otf"], ["eot", "application/vnd.ms-fontobject"],
  ["xml", "application/octet-stream"], ["xhtml", "application/octet-stream"],
  ["unknown", "application/octet-stream"],
])("retains main's extension fallback for .%s without stored metadata", (extension, expected) => {
  expect(assetContentType(`file.${extension}`)).toBe(expected);
});

it.each(["text/css", "text/html"])("keeps an absent charset distinct from a fallback for %s", type => {
  for (const stored of [type, `${type}; ignored=value`, `${type}; ignored="charset=utf-8"`]) {
    expect(assetContentType("file", stored)).toBe(type);
  }
});

it.each(["public", "legacy publication", "legacy share"])(
  "labels re-encoded HTML as UTF-8 through %s regardless of stored or in-band charset", async name => {
    const { routes } = await publisherIsolationFixture();
    const route = routes.find(route => route.name === name)!;
    const html = '<!doctype html><html><head><meta charset="windows-1252"></head><body><p>café</p></body></html>';
    vi.mocked(minio.getObjectStream).mockImplementation(() => Promise.resolve(new Response(html).body));
    for (const stored of ["text/html", "text/html; charset=windows-1252", "text/html; charset=utf-8", "text/html; charset=unknown"]) {
      vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ files: [{ path: "index.html", contentType: stored }] }));
      vi.mocked(minio.headObject).mockResolvedValue({ contentType: stored });
      const response = await worker.request(`https://rendro.test${route.url(0)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toContain("<p>café</p>");
    }
  },
);
