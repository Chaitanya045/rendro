import type { MiddlewareHandler } from "hono";
import { authClientIpHeaders } from "../auth-client-ip";
import { CONVEX_SITE_URL } from "../config";
import { viewerBackendJson, ViewerBackendError } from "../viewer-backend";
import { unavailableResponse } from "../routes/viewer-unavailable";

/** Legacy capabilities still authorize themselves after this shared IP budget. */
export const anonymousAdmission: MiddlewareHandler = async (c, next) => {
  const url = `${CONVEX_SITE_URL}/api/rendro/admission/public`;
  try {
    const result = await viewerBackendJson<{ admitted?: boolean }>(url, {
      headers: await authClientIpHeaders(c.req.raw, url, "GET"),
    }, true, async response => {
      // TODO(#86): remove after Worker and Convex rollout is complete. Match
      // Convex's router response exactly; an application 404 is still a failure.
      if (response.headers.get("content-type") !== "text/plain; charset=utf-8"
        || await response.text() !== "No matching routes found") return null;
      if (Math.random() < 0.01) console.warn("Legacy admission route not deployed; proceeding with capability authorization");
      return { admitted: true };
    });
    if (result?.admitted !== true) throw new ViewerBackendError();
  } catch (error) {
    return unavailableResponse(c, error instanceof ViewerBackendError ? error : new ViewerBackendError(), "json");
  }
  await next();
};
