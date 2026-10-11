/** URL paths are decoded exactly once at the routing boundary. JSON and stored
 * paths are already literal keys. Reject ambiguous structure before storage access;
 * percent signs in a canonical key are data, never another URL encoding. */
export function isCanonicalStorageKey(key: string): boolean {
  return !!key && !key.includes("\\")
    && [...key].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    && key.split("/").every(part => !!part && part !== "." && part !== "..");
}

export function decodeStoragePath(encoded: string): string | null {
  try {
    const path = encoded.split("/").map(part => {
      const decoded = decodeURIComponent(part);
      // Encoded separators must not change namespace/path segmentation.
      return decoded.includes("/") ? "" : decoded;
    }).join("/");
    return isCanonicalStorageKey(path) ? path : null;
  } catch { return null; }
}
