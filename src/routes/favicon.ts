// Every Rendro-owned HTML document links both: FaviconLinks (head.tsx).
export { renderFaviconLinks } from "./head";

export const faviconAssets = {
  "/favicon.svg": "image/svg+xml",
  "/favicon.ico": "image/x-icon",
} as const;

// Stable URLs should refresh regularly rather than remain immutable.
export const faviconCacheControl = "public, max-age=86400";
