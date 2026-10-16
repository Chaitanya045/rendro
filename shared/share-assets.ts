import { MAX_HTTP_BODY_BYTES } from "./deployment-limits";
import { isCanonicalStorageKey } from "./storage-path";

export const MAX_SHARE_ASSET_PATHS = 500;
// The Worker bounds the serialized supported metadata object, including braces,
// in UTF-8 bytes. Adding assetPaths retains those braces and adds this member.
export const MAX_SHARE_METADATA_BYTES = 8 * 1024;
export const SHARE_ASSET_JSON_OVERHEAD = ',"assetPaths":'.length;
export const MAX_SHARE_ASSET_BYTES = MAX_HTTP_BODY_BYTES - MAX_SHARE_METADATA_BYTES - SHARE_ASSET_JSON_OVERHEAD;

/** Bounds both the signed payload and the persisted grant. Empty means document-only. */
export function validShareAssets(paths: unknown): paths is string[] {
  return Array.isArray(paths) && paths.length <= MAX_SHARE_ASSET_PATHS
    && paths.every(path => typeof path === "string" && isCanonicalStorageKey(path))
    && new TextEncoder().encode(JSON.stringify(paths)).byteLength <= MAX_SHARE_ASSET_BYTES;
}
