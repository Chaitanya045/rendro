import type { Context } from "hono";
import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";

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

/** Classify failures without reading storage or revealing whether an asset exists. */
export function assetError(c: Context, html: () => string, status: ClientErrorStatusCode | ServerErrorStatusCode = 404): Response {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const accept = c.req.header("Accept") ?? "";
  let path = c.req.path;
  try { path = decodeURIComponent(path); } catch { /* Invalid paths still fail closed. */ }
  // Browser document Accept headers also advertise image formats.
  const htmlRequest = /(?:^|,)\s*(?:text\/html|application\/xhtml\+xml)(?:\s*[;,]|$)/i.test(accept);
  const resource = (!htmlRequest && /(?:^|,)\s*(?:image\/|font\/|text\/css|(?:application|text)\/(?:javascript|ecmascript)|application\/(?:json|[\w.+-]+\+json|font-|x-font-|vnd.ms-fontobject))/i.test(accept))
    || /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf|eot|css|m?js|json)$/i.test(path);
  if (resource) {
    // An empty untyped response avoids Chromium ORB for opaque no-cors loads.
    // Keep the denial status and never grant error-response CORS access.
    c.set("emptyAssetError", true);
    c.header("Content-Type", undefined);
    c.header("X-Content-Type-Options", undefined);
    return c.body(null, status);
  }
  return c.html(html(), status);
}
