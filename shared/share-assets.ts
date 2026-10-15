import { isCanonicalStorageKey } from "./storage-path";

/** Bounds both the signed payload and the persisted grant. Empty means document-only. */
export function validShareAssets(paths: unknown): paths is string[] {
  return Array.isArray(paths) && paths.length <= 500
    && paths.every(path => typeof path === "string" && isCanonicalStorageKey(path))
    && new TextEncoder().encode(JSON.stringify(paths)).byteLength <= 64 * 1024;
}
