
// Content-hashed like the fonts: a changed stylesheet always gets a new URL.
export const styleCacheControl = "public, max-age=31536000, immutable";

const hashedStyle = /^\/styles\/[a-z0-9-]+\.[0-9a-f]{10}\.css$/;

/** Headers for a public stylesheet, or `undefined` when the path is not one (serve a 404). */
export function styleResponseHeaders(path: string): Record<string, string> | undefined {
  return hashedStyle.test(path) ? { "Content-Type": "text/css; charset=utf-8", "Cache-Control": styleCacheControl } : undefined;
}

// The link to a self-hosted, hashed stylesheet is Stylesheet (head.tsx).
export { renderStylesheet } from "./head";
