import { ViewerBackendError } from "@/viewer-backend";
import type { Context, MiddlewareHandler } from "hono";
import { logger } from "@/logger";
import { requestLogPath } from "@/request-log";
import { transientStorageFault } from "@/storage-fault";
import { assetError } from "@/routes/asset-headers";
import { renderSessionUnavailablePage } from "@/routes/session-unavailable";

export type ViewerUnavailable = {
  unavailable: true;
  retryAfter: string;
  status?: 429 | 503;
};

/** Canonical cookie-authenticated document URLs. A link followed inside the sandboxed viewer frame is cross-site and carries no
 * session cookie, so on these the shell (which does) reloads the frame instead (`doc-retry`). Ticket URLs need no cookie and
 * retry by plain link. */
const cookieDocument = /^\/r\/[^/]+\/[^/]+(?:\/[~@][^/]+)?\/files\//;

/**
 * The one response for "could not check", as opposed to "not found": a retryable 503 that carries
 * `Retry-After`, is never cached, and offers a retry on HTML. Storage and database failures end here
 * on every delivery surface, and only after authorization or before any existence is known, so it
 * reveals nothing a plain 404 would hide.
 */
export function unavailableResponse(c: Context, failure: ViewerUnavailable, representation: "html" | "json" | "asset") {
  c.header("Cache-Control", "private, no-store");
  c.header("Retry-After", failure.retryAfter);
  if (failure.status === 429) return c.json({ error: "Too many requests. Please retry later.", code: "rate_limited" }, 429);
  const page = () => renderSessionUnavailablePage(503, "document", cookieDocument.test(c.req.path));
  if (representation === "asset") return assetError(c, page, 503);
  return representation === "json"
    ? c.json({ error: "Document temporarily unavailable", retryable: true }, 503)
    : c.html(page(), 503);
}

/** Preserve successful caching while preventing negative caching, including JSON. */
export const viewerErrorCache: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status >= 400) c.header("Cache-Control", "private, no-store");
};

/**
 * `onError` of every delivery route. A failure that means "could not check" (a ViewerBackendError, or a storage error
 * `transientStorageFault` calls transient) is the retryable 503; anything else is a defect and stays an internal error,
 * Only the route template and enumerations are logged: no path, token, key or exception text.
 */
export function viewerErrorResponse(error: Error, c: Context, json: boolean): Response {
  const route = requestLogPath(c);
  const fault = error instanceof ViewerBackendError ? null : transientStorageFault(error);
  if (error instanceof ViewerBackendError || fault) {
    logger.warn({ category: "DeliveryUnavailable", route, ...fault }, "Document delivery unavailable");
    return unavailableResponse(c, error instanceof ViewerBackendError ? error : new ViewerBackendError(), json ? "json" : "asset");
  }
  logger.error({ category: "UnhandledError", route, errorType: error.name }, "Document delivery failed");
  c.header("Cache-Control", "private, no-store");
  return json ? c.json({ error: "Internal server error" }, 500)
    : assetError(c, () => renderSessionUnavailablePage(500, "document"), 500);
}
