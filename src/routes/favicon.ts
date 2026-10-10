/** Shared by every Rendro-owned HTML document. */
export function renderFaviconLinks(): string {
  return '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32" type="image/x-icon"><link rel="icon" href="/favicon.svg" sizes="any" type="image/svg+xml">';
}

export const faviconAssets = {
  "/favicon.svg": "image/svg+xml",
  "/favicon.ico": "image/x-icon",
} as const;

// Stable URLs should refresh regularly rather than remain immutable.
export const faviconCacheControl = "public, max-age=86400";
