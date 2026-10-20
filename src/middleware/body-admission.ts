import type { MiddlewareHandler } from "hono";
import { boundedRequest, BodyTooLargeError } from "../bounded-body";
import { copyAuthClientIp } from "../auth-client-ip";
import { IllFormedTextError, requireWellFormedBody } from "../../shared/text-input";

export const bodyAdmission: MiddlewareHandler = async (c, next) => {
  try {
    const original = c.req.raw;
    c.req.raw = await boundedRequest(original);
    copyAuthClientIp(original, c.req.raw);
    await requireWellFormedBody(c.req.raw);
  } catch (error) {
    if (error instanceof BodyTooLargeError || error instanceof IllFormedTextError) return error.response();
    throw error;
  }
  await next();
};
