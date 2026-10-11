const fontTypes: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
};

const assetTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function assetContentType(path: string, storedType?: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  // Older manifests can store fonts as application/octet-stream. Preserve
  // publisher-provided MIME types for all other files.
  return fontTypes[extension] ?? storedType ?? assetTypes[extension] ?? "application/octet-stream";
}

/** Call only after the route's publication, share, or session/ticket checks. */
export function assetHeaders(path: string, allowOpaqueOrigin: boolean, storedType?: string): Record<string, string> {
  return {
    "Content-Type": assetContentType(path, storedType),
    "X-Content-Type-Options": "nosniff",
    // Fixed opaque origin, never reflected and never credentialed. Canonical
    // cookie-authenticated private URLs must not opt into this allowance.
    ...(allowOpaqueOrigin ? { "Access-Control-Allow-Origin": "null" } : {}),
  };
}
