import { ViewerBackendError } from "@/viewer-backend";
import type { Context, MiddlewareHandler } from "hono";
import { logger } from "@/logger";
import { requestLogPath } from "@/request-log";
import { assetError } from "@/routes/asset-headers";
import { renderSessionUnavailablePage } from "@/routes/session-unavailable";

export type ViewerUnavailable = {
  unavailable: true;
  retryAfter: string;
  status?: 429 | 503;
  /** What the recovery page blames; the default is the stored document. */
  subject?: "session" | "document";
};

/** Canonical cookie-authenticated document URLs. A link followed inside the sandboxed viewer frame is cross-site and carries no
 * session cookie, so on these the shell (which does) reloads the frame instead (`doc-retry`). Ticket, share and public URLs
 * need no cookie and retry by plain link. */
const cookieDocument = /^\/(?:legacy-view\/[^/]+|organizations\/[^/]+\/projects\/[^/]+\/docs)\/files\//;

/**
 * The one response for "could not check", as opposed to "not found": a retryable 503 that carries
 * `Retry-After`, is never cached, and offers a retry on HTML. Storage and database failures end here
 * on every delivery surface, and only after authorization or before any existence is known, so it
 * reveals nothing a plain 404 would hide.
 */
export function unavailableResponse(c: Context, failure: ViewerUnavailable, representation: "html" | "json" | "asset" = "html") {
  c.header("Cache-Control", "private, no-store");
  c.header("Retry-After", failure.retryAfter);
  if (failure.status === 429) return c.json({ error: "Too many requests. Please retry later.", code: "rate_limited" }, 429);
  const page = () => renderSessionUnavailablePage(503, failure.subject ?? "document", cookieDocument.test(c.req.path));
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

/** Tree pages and ticket renewals are fetched by scripts; everything else is a document or asset. */
const jsonRoute = /\/(?:tree|viewer-ticket)$/;

export function viewerErrorResponse(error: Error, c: Context): Response {
  // Only the static route template is logged: no path, token, key or exception text.
  const route = requestLogPath(c);
  logger.warn({ category: "DeliveryUnavailable", route }, "Document delivery unavailable");
  return unavailableResponse(c, error instanceof ViewerBackendError ? error : new ViewerBackendError(),
    jsonRoute.test(route) ? "json" : "asset");
}
