import { describe, expect, it } from "vitest";
import { createShareToken, createShareUrl, verifyShareToken } from "@/share-links";

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
});
