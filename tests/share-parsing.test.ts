import { describe, expect, it } from "vitest";
import { srcsetUrls } from "../src/share-srcset";
import { decodeShareSource } from "../src/share-encoding";

describe("WHATWG srcset candidate parsing", () => {
  it.each(["\u00a0", "\u2028", "\u3000", "\u0085", "\u200b", "\ufeff"])("keeps %j inside URL and descriptor tokens", space => {
    expect(srcsetUrls(`private.json${space}1x`)).toEqual([`private.json${space}1x`]);
    expect(srcsetUrls(`image 1x${space}, valid 2x`)).toEqual(["valid"]);
    for (const descriptor of [`1${space}x`, `1${space}w`, `1${space}h 1w`]) {
      expect(srcsetUrls(`private.json ${descriptor}, valid 2x`)).toEqual(["valid"]);
    }
  });
  it.each([
    ["", []], [" ,\t\n\f\r ,, ", []], ["a,b 1x, c 2x", ["a,b", "c"]],
    ["data:image/png;base64,AAAA 1x, next 2x", ["data:image/png;base64,AAAA", "next"]],
    ["a,, b, c", ["a", "b", "c"]], ["a \t 1x \n , b 2x ", ["a", "b"]],
    ["a (x, y), b 2x", ["b"]], ["a (x, y", []], ["a 1x (", []],
    ["a 100w 50h, b 50h 100w", ["a", "b"]], ["a 0x, b -0x, c .5x, d 1e+2x", ["a", "b", "c", "d"]],
    ...["1e9999x", "0w", "0h", "1h", "-1w", "-1x", "+1x", "1.x", "1X", "1w 2w", "1x 2x", "1h 2h 1w", "1x 1w", "1w 1x", "1h 1x", "1x 1h", "1h 1w 1x", "calc(1, 2)", "1x  foo", "1x\v"].map(d => [`a ${d}, b 2x`, ["b"]]),
  ])("parses %j", (input, expected) => expect(srcsetUrls(input as string)).toEqual(expected));
});

const decode = (source: string | Uint8Array, type = "text/html", environment?: string) =>
  decodeShareSource(typeof source === "string" ? Buffer.from(source, "latin1") : source, "index", type, environment);

describe("share source encoding sniff", () => {
  it.each([
    '<meta charset=" WINDOWS-1252 ">', '<META/CHARSET=iso-8859-1>',
    '<meta content="text/html; charset=windows-1252" http-equiv="Content-Type">',
    "<meta http-equiv='content-type' content='text/html; charset=\"windows-1252\"'>",
    '<meta http-equiv=content-type content="charset=\'windows-1252\'">',
    '<meta content="charset nope; charset = windows-1252; foo" http-equiv=content-type>',
    '<meta charset=windows-1252 =bogus a/>', '<meta charset=x-user-defined>', '<meta charset=bogus><meta charset=windows-1252>',
    '<meta charset=windows-1252 charset=utf-8>', '<meta foo bar=1 / charset = windows-1252>',
    '<!-- <meta charset=utf-8> --><meta charset=windows-1252>',
    '<div data-x="<meta charset=utf-8>"></div><meta charset=windows-1252>',
    '<!doctype html><?anything><meta charset=windows-1252>',
    '<meta content="charset=utf-8" charset=windows-1252>',
  ])("recognizes HTML declarations: %s", prefix => {
    expect(decode(prefix + '<img src="caf\xe9.svg">').encoding).toBe("windows-1252");
    expect(decode(prefix + '<img src="caf\xe9.svg">').text).toContain("café.svg");
  });
  it.each([
    '<meta CHARSET charset=windows-1252>', '<meta charset=>',
    '<meta charset=windows-1252 a=" >', '<meta charset=', '<meta charset',
    '<meta charset=bogus content="charset=windows-1252">', '<meta content="charset=bogus">',
    '<meta http-equiv=content-type content="charset=; charset=windows-1252">',
    '<meta http-equiv=content-type content="charset=\'invalid; charset=windows-1252">',
    '', '<!-- <meta charset=windows-1252>', '<meta content="charset=windows-1252">',
    '<meta content="nonsense" http-equiv=content-type>', '<meta charset=bogus>',
    '<meta charset="\u00a0windows-1252">', '<meta charset=utf-16>', '<meta charset=utf-16be>',
    '<meta charset="windows-1252', '<meta foo', '<meta>', '<meta http-equiv=wrong content="charset=windows-1252">',
    '<meta http-equiv=content-type content="charset=\'windows-1252">',
    'x'.repeat(1024) + '<meta charset=windows-1252>', 'x'.repeat(1000) + '<meta charset="windows-1252">',
    '<?unterminated', '<div data-x="<meta charset=windows-1252>">',
  ])("falls back for absent/invalid/late declarations: %s", prefix => {
    expect(decode(prefix).encoding).toBe("utf-8");
  });
  it("honors BOMs before transport and transport before HTML/CSS declarations", () => {
    for (const [bom, encoding] of [[Buffer.from([0xef, 0xbb, 0xbf]), "utf-8"], [Buffer.from([0xff, 0xfe]), "utf-16le"], [Buffer.from([0xfe, 0xff]), "utf-16be"]] as const) {
      expect(decode(bom, "text/html; charset=windows-1252").encoding).toBe(encoding);
    }
    expect(decode('<meta charset=utf-8>caf\xe9', "text/html; charset=iso-8859-1").text).toContain("café");
    expect(decode('@charset "utf-8";caf\xe9', "text/css; charset=windows-1252", "utf-8").text).toContain("café");
  });
  it("uses CSS declarations before inheritance with strict byte syntax", () => {
    expect(decode('@charset "windows-1252";caf\xe9', "text/css", "utf-8").text).toContain("café");
    for (const source of ['@charset "utf-16";', '@charset "utf-16be";']) expect(decode(source, "text/css", "windows-1252").encoding).toBe("utf-8");
    for (const source of ['', "@charset 'utf-8';", ' @charset "utf-8";', '@CHARSET "utf-8";', '@charset "bogus";', '@charset "' + ' '.repeat(1024) + 'utf-8";']) {
      expect(decode(source, "text/css", "windows-1252").encoding).toBe("windows-1252");
    }
  });
});
