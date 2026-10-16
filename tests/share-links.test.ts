import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createShareToken, createShareUrl, isShareableDocKey, verifyShareToken } from "@/share-links";

describe("share signer", () => {
  it("round-trips signed document keys", () => {
    const token = createShareToken("gmail/index.html", 100);
    expect(verifyShareToken(token, 101)).toEqual({ ok: true, key: "gmail/index.html", expiresAt: 604900 });
  });

  it("rejects a tampered signature", () => {
    const token = createShareToken("gmail/index.html", 100);
    const tampered = `${token.slice(0, -1)}x`;
    expect(verifyShareToken(tampered, 101)).toEqual({ ok: false, status: 403, reason: "invalid" });
  });

  it("returns gone for expired tokens", () => {
    const token = createShareToken("gmail/index.html", 100);
    expect(verifyShareToken(token, 604901)).toEqual({ ok: false, status: 410, reason: "expired" });
  });

  it("refuses to sign unsafe keys", () => {
    expect(() => createShareToken("gmail/..\\secret.html", 100)).toThrow("Invalid share key");
  });

  it("rejects malformed tokens", () => {
    expect(verifyShareToken("not-a-token", 101)).toEqual({ ok: false, status: 403, reason: "invalid" });
  });

  it("builds public share URLs whose token verifies", () => {
    const url = createShareUrl("https://rendro.test", "gmail/guide.html", 100);
    const parsed = new URL(url);
    const token = parsed.pathname.slice("/share/".length);
    expect(parsed.origin).toBe("https://rendro.test");
    expect(parsed.hash).toBe("#gmail/guide.html");
    expect(verifyShareToken(token, 101)).toEqual({ ok: true, key: "gmail/guide.html", expiresAt: 604900 });
  });

  // Anyone holding the signing key's output must still not widen what a token can open.
  const signed = (raw: string, encode = true) => {
    const payload = encode ? Buffer.from(raw).toString("base64url") : raw;
    return `${payload}.${createHmac("sha256", process.env.AUTH_SECRET!).update(payload).digest("base64url")}`;
  };
  const invalid = { ok: false, status: 403, reason: "invalid" };
  it.each([
    ["undecodable payload", signed("%%%", false)],
    ["non-JSON payload", signed("not json")],
    ["JSON null", signed("null")],
    ["JSON string", signed('"gmail/index.html"')],
    ["JSON number", signed("5")],
    ["missing fields", signed("{}")],
    ["non-string key", signed('{"k":1,"e":9999999999}')],
    ["non-numeric expiry", signed('{"k":"gmail/index.html","e":"9999999999"}')],
    ["non-HTML key", signed('{"k":"gmail/index.txt","e":9999999999}')],
    ["traversing key", signed('{"k":"gmail/../index.html","e":9999999999}')],
    ["reserved modern root", signed('{"k":"tenants/a/index.html","e":9999999999}')],
    ["empty signature", `${Buffer.from("{}").toString("base64url")}.`],
    ["empty payload", ".signature"],
    ["extra segment", `${createShareToken("gmail/index.html", 100)}.extra`],
    ["signature of another length", `${createShareToken("gmail/index.html", 100)}A`],
  ])("rejects a %s as invalid, never as expired", (_name, token) => {
    expect(verifyShareToken(token, 101)).toEqual(invalid);
  });

  it.each([["fractional", "1.5"], ["unsafe", "1e300"], ["past", "100"]])("reports a %s expiry as gone", (_name, expiry) => {
    expect(verifyShareToken(signed(`{"k":"gmail/index.html","e":${expiry}}`), 101)).toEqual({ ok: false, status: 410, reason: "expired" });
  });

  it("accepts the exact expiry second and rejects the next", () => {
    const token = createShareToken("gmail/index.html", 100);
    expect(verifyShareToken(token, 604900)).toMatchObject({ ok: true });
    expect(verifyShareToken(token, 604901)).toMatchObject({ ok: false, status: 410 });
  });

  it("only treats HTML documents in a canonical legacy namespace as shareable", () => {
    expect(isShareableDocKey("gmail/a/b.html")).toBe(true);
    for (const key of ["gmail/a.js", "tenants/a.html", "gmail//a.html", "gmail/a\\b.html", "gmail/a\0.html", "gmail/..a/../b.html", "a.html", ""]) {
      expect(isShareableDocKey(key), key).toBe(false);
    }
  });

  it("encodes each path segment in the share fragment", () => {
    expect(createShareUrl("https://rendro.test", "gmail/a b/ü#?.html", 100).split("#")[1]).toBe("gmail/a%20b/%C3%BC%23%3F.html");
  });
});
