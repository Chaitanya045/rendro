import { ViewerBackendError } from "@/viewer-backend";
import type { Context, MiddlewareHandler } from "hono";
import { assetError } from "@/routes/asset-headers";
import { renderSessionUnavailablePage } from "@/routes/session-unavailable";

export type ViewerUnavailable = { unavailable: true; retryAfter: string };

export function unavailableResponse(c: Context, failure: ViewerUnavailable, representation: "html" | "json" | "asset" = "html") {
  c.header("Cache-Control", "private, no-store");
  c.header("Retry-After", failure.retryAfter);
  if (representation === "asset") return assetError(c, renderSessionUnavailablePage, 503);
  return representation === "json"
    ? c.json({ error: "Document temporarily unavailable", retryable: true }, 503)
    : c.html(renderSessionUnavailablePage(), 503);
}

/** Preserve successful caching while preventing negative caching, including JSON. */
export const viewerErrorCache: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status >= 400) c.header("Cache-Control", "private, no-store");
};

export function viewerErrorResponse(error: Error, c: Context): Response {
  return unavailableResponse(c, error instanceof ViewerBackendError ? error : new ViewerBackendError(),
    c.req.routePath === "/p/:slug/tree" ? "json" : "asset");
}

