import type { MiddlewareHandler } from "hono";
import { boundedRequest, BodyTooLargeError, requireBodyLength } from "../bounded-body";
import { copyAuthClientIp } from "../auth-client-ip";
import { MAX_MANIFEST_BODY_BYTES, MAX_HTTP_BODY_BYTES, MAX_FILE_BYTES } from "../../shared/deployment-limits";

export const bodyAdmission: MiddlewareHandler = async (c, next) => {
  // Binary uploads are read once after staging authorization by readExactBody,
  // which independently enforces MAX_FILE_BYTES and the manifest's exact size.
  try {
    if (c.req.method === "PUT" && /^\/api\/rendro\/deployments\/[^/]+\/files\//.test(c.req.path)) {
      requireBodyLength(c.req.raw, MAX_FILE_BYTES);
    } else {
      const original = c.req.raw;
      c.req.raw = await boundedRequest(original, c.req.path === "/api/rendro/deployments/start"
        ? MAX_MANIFEST_BODY_BYTES : MAX_HTTP_BODY_BYTES);
      copyAuthClientIp(original, c.req.raw);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) return error.response();
    throw error;
  }
  await next();
};
