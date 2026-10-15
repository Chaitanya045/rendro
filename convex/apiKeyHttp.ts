import { internal } from "./_generated/api";
import { httpAction, RateLimitedError } from "./httpErrors";
import { sha256 } from "./credentialHash";
import { AUTH_CLIENT_IP_HEADER, verifiedAuthRequest } from "../shared/auth-client-ip";

import { apiKeyRateLimiter } from "./apiKeyRateLimits";
export { apiKeyRateLimiter, apiKeyRateLimits } from "./apiKeyRateLimits";

type Handler = Parameters<typeof httpAction>[0];

function limitedAction(handler: Handler, allowSession: boolean, budget: "credential" | "cleanup" = "credential") {
  return httpAction(async (ctx, request) => {
    const authorization = request.headers.get("authorization");
    // Cookie-only management traffic has its own authentication path. Supplying
    // any Authorization header opts into API-key limiting, even with a cookie.
    if (allowSession && authorization === null) return handler(ctx, request);
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    const credentialId = match ? await ctx.runQuery(internal.apiKeyCredentials.verifiedIdInternal, {
      secretHash: await sha256(match[1]),
    }) : null;
    let status;
    if (credentialId) {
      status = await apiKeyRateLimiter.limit(ctx, budget, { key: credentialId });
    } else {
      // A metadata-only request avoids consuming the original POST body.
      const verified = await verifiedAuthRequest(new Request(request.url, {
        method: request.method, headers: request.headers,
      }), process.env.CONVEX_INTERNAL_SECRET);
      const ip = verified.headers.get(AUTH_CLIENT_IP_HEADER);
      status = await ctx.runMutation(internal.apiKeyRateLimitBuckets.consumeFailedIp, {
        key: ip ? `ip:${ip}` : "unverified",
      });
    }
    if (!status.ok) throw new RateLimitedError(status.retryAfter);
    // Charge before parsing input and independently of operation success. Scope
    // authorization still happens inside each handler, including revocation.
    return handler(ctx, request);
  }, allowSession ? "mixed" : "bearer");
}

export const apiKeyHttpAction = (handler: Handler) => limitedAction(handler, false);
export const sessionOrApiKeyHttpAction = (handler: Handler) => limitedAction(handler, true);

export const apiKeyCleanupHttpAction = (handler: Handler) => limitedAction(handler, false, "cleanup");
