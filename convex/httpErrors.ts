import { apiCacheControl } from "../shared/http-cache";
import { boundedRequest, BodyTooLargeError } from "../src/bounded-body";
import { isRateLimitError } from "@convex-dev/rate-limiter";
import { requireCookieWrite, RequestAdmissionError, httpActionPolicies, type HttpPolicy } from "../shared/request-admission";
import { isPublicErrorData, type PublicErrorData } from "../src/shared/public-errors";
import { ConvexError } from "convex/values";
import { httpAction as registerHttpAction } from "./_generated/server";

export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Rate limit exceeded");
  }
}

// Use only for messages authored by the handler, never caught exceptions.
export function clientFailure(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export function isApplicationError(error: unknown): error is ConvexError<string | PublicErrorData> {
  return error instanceof ConvexError && (typeof error.data === "string" || isPublicErrorData(error.data));
}

// ConvexError is the explicit application-error contract across function calls.
// The supplied status applies ONLY to those errors, never infrastructure faults.
export function failure(error: unknown, applicationStatus = 400, operation = "httpAction"): Response {
  if (error instanceof BodyTooLargeError) return error.response();
  if (error instanceof ConvexError && error.data !== null && typeof error.data === "object" && isRateLimitError(error)) {
    const seconds = Math.max(1, Math.ceil((error as { data: { retryAfter: number } }).data.retryAfter / 1000));
    return Response.json({ error: `Too many writes. Please try again in ${seconds} seconds.`, code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(seconds) } });
  }
  if (error instanceof RequestAdmissionError) return clientFailure(error.message, error.status);
  if (error instanceof RateLimitedError) {
    return Response.json({ error: "Rate limit exceeded", code: "rate_limited" }, {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) },
    });
  }
  if (isApplicationError(error)) {
    if (isPublicErrorData(error.data)) {
      const { code, message } = error.data;
      const status = code === "not_found" ? 404 : code === "unauthenticated" ? 401
        : code === "forbidden" ? 403 : code === "conflict" ? 409 : 400;
      return clientFailure(message, status);
    }
    const message = error.data;
    const code = message === "Invalid ID" ? 400
      : /authentication|membership|role/i.test(message) ? 403
      : applicationStatus >= 500 ? 400 : applicationStatus;
    return clientFailure(message, code);
  }
  // Arbitrary exception messages, stacks, and objects may contain credentials or
  // request data. Log only fixed categories and the caller's static operation.
  const category = error instanceof TypeError ? "TypeError"
    : error instanceof RangeError ? "RangeError"
    : error instanceof Error ? "Error" : "Unknown";
  console.error("HTTP request failed", { operation, category, status: 500 });
  return Response.json({ error: "Request failed" }, { status: 500 });
}

export const httpAction = (handler: Parameters<typeof registerHttpAction>[0], policy: HttpPolicy = "read") => {
  const action = registerHttpAction(async (ctx, request) => {
    let response: Response;
    try {
      if (policy === "cookie-json") requireCookieWrite(request, process.env.SITE_URL);
      response = await handler(ctx, await boundedRequest(request));
    } catch (error) {
      response = failure(error, 500);
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", apiCacheControl(request, response));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });

  httpActionPolicies.set(action, policy);
  return action;
};
