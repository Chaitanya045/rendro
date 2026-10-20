import type { Context } from "hono";
import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";

/** Browser document Accept headers also advertise image formats, so only an explicit HTML entry counts. */
export function acceptsHtml(c: Context): boolean {
  return /(?:^|,)\s*(?:text\/html|application\/xhtml\+xml)(?:\s*[;,]|$)/i.test(c.req.header("Accept") ?? "");
}

/** Classify failures without reading storage or revealing whether an asset exists. */
export function assetError(c: Context, html: () => string, status: ClientErrorStatusCode | ServerErrorStatusCode = 404): Response {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const accept = c.req.header("Accept") ?? "";
  let path = c.req.path;
  try { path = decodeURIComponent(path); } catch { /* Invalid paths still fail closed. */ }
  const htmlRequest = acceptsHtml(c);
  const resource = (!htmlRequest && /(?:^|,)\s*(?:image\/|font\/|text\/css|(?:application|text)\/(?:javascript|ecmascript)|application\/(?:json|[\w.+-]+\+json|font-|x-font-|vnd.ms-fontobject))/i.test(accept))
    || /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf|eot|css|m?js|json)$/i.test(path);
  if (resource) {
    // An empty untyped response avoids Chromium ORB for opaque no-cors loads.
    // Keep the denial status and never grant error-response CORS access.
    c.set("emptyAssetError", true);
    c.header("Content-Type", undefined);
    c.header("X-Content-Type-Options", undefined);
    c.header("Content-Length", "0");
    return c.body(null, status);
  }
  return c.html(html(), status);
}
