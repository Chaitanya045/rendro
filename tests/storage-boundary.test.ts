import { describe, expect, it } from "vitest";
import { decodeStoragePath, isCanonicalStorageKey } from "@/storage-boundary";

/** Repository paths (#234) are decoded once at the routing boundary; percent signs in a canonical key are data. */
describe("canonical storage keys", () => {
  it.each(["index.html", "guide/a b.html", "100%.html", "literal%25.html", "Case.html", "é.html", "é.html", "folder./index.html"])(
    "accepts and round-trips %s", path => {
      expect(isCanonicalStorageKey(path)).toBe(true);
      expect(decodeStoragePath(path.split("/").map(encodeURIComponent).join("/"))).toBe(path);
    },
  );

  it.each(["../index.html", "/index.html", "guide//index.html", "guide/./index.html", "guide/../index.html", "\\index.html", "\0index.html", "\x1findex.html", "\x7findex.html"])(
    "rejects structurally unsafe canonical keys: %s", path => {
      expect(isCanonicalStorageKey(path)).toBe(false);
      expect(decodeStoragePath(path.split("/").map(encodeURIComponent).join("/"))).toBeNull();
    },
  );

  it.each(["%2e%2e/index.html", "guide%2findex.html", "%2findex.html", "%5cindex.html", "%00index.html", "%E0%A4%A"])(
    "never lets an encoded separator, traversal or malformed escape change the key: %s", encoded => {
      expect(decodeStoragePath(encoded)).toBeNull();
    },
  );

  it("decodes exactly once, so a double-encoded escape stays literal data", () => {
    expect(decodeStoragePath("%252e%252e/index.html")).toBe("%2e%2e/index.html");
    expect(decodeStoragePath("")).toBeNull();
  });
});
