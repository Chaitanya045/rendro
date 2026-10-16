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
    }, true);
    if (result?.admitted !== true) throw new ViewerBackendError();
  } catch (error) {
    return unavailableResponse(c, error instanceof ViewerBackendError ? error : new ViewerBackendError(), "json");
  }
  await next();
};
