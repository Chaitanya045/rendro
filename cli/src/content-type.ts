import { extname } from "node:path";

const types: Record<string, string> = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Extensions identify media types, not encodings. Only a BOM declares a charset. */
export function contentType(path: string, bytes: Uint8Array): string {
  const type = types[extname(path).toLowerCase()] ?? "application/octet-stream";
  if (!/^(?:text\/|application\/json$|image\/svg\+xml$)/.test(type)) return type;
  // UTF-32LE shares UTF-16LE's prefix; do not mislabel an unsupported encoding.
  if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) return type;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return `${type}; charset=utf-8`;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return `${type}; charset=utf-16le`;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return `${type}; charset=utf-16be`;
  return type;
}
