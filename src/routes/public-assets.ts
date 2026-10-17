import { faviconAssets, faviconCacheControl } from "./favicon";
import { fontCacheControl } from "./fonts";
import { versionedBundles } from "./versioned-bundles";

/*
 * Every static file the Worker and the Node server expose. All of them are public: they are served
 * before session middleware (no identity lookup, no cache eviction) from an explicit allowlist, so a
 * new file in public/ is a 404 until it is added here. Fonts live under /fonts/* (see ./fonts) and
 * hashed stylesheets under /styles/* (see ./styles).
 *
 * Versioned bundles map their public path to the version recorded in scripts/asset-versions.json,
 * which CI checks against the built bytes. A URL is immutable only for the current version; any other
 * (or missing) version gets the current bytes with `no-store`, so a stale or foreign URL is never
 * cached under bytes it does not name. Old versions are not kept: a rollout-straddling request gets
 * the new bundle uncached rather than a 404 (the management shell already falls back on a version
 * mismatch).
 */
/** Same policy as content-hashed fonts: the URL names its bytes. */
export const bundleCacheControl = fontCacheControl;
const unversionedCacheControl = "no-store";
// Stable URLs (also embedded in external previews) refresh daily rather than being immutable.
const imageAssets: Readonly<Record<string, string>> = { "/landing-product.webp": "image/webp" };

/** Exact paths served from ./public, excluding /fonts/* and /styles/*, which have their own contracts. */
export const publicAssetPaths: readonly string[] = [
  ...Object.keys(versionedBundles), ...Object.keys(faviconAssets), ...Object.keys(imageAssets),
];

/** Headers for a public static asset, or `undefined` when `path` is not on the allowlist. */
export function publicAssetHeaders(path: string, search: string): Record<string, string> | undefined {
  const version = Object.hasOwn(versionedBundles, path) ? versionedBundles[path] : undefined;
  if (version !== undefined) {
    return {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": search === `?v=${version}` ? bundleCacheControl : unversionedCacheControl,
    };
  }
  const contentType = Object.hasOwn(faviconAssets, path) ? faviconAssets[path as keyof typeof faviconAssets]
    : Object.hasOwn(imageAssets, path) ? imageAssets[path] : undefined;
  return contentType === undefined ? undefined : { "Content-Type": contentType, "Cache-Control": faviconCacheControl };
}
