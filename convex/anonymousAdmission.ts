import { RateLimiter, MINUTE, type RateLimitReturns } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { touchAdmissionBucket } from "./admissionBuckets";
import { components, internal } from "./_generated/api";
import { AUTH_CLIENT_IP_HEADER, verifiedAuthRequest } from "../shared/auth-client-ip";
import { httpAction, RateLimitedError } from "./httpErrors";

export const anonymousLimits = {
  resolution: { kind: "token bucket", rate: 600, period: MINUTE, capacity: 1_200, shards: 10 },
  unverifiedResolution: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 120, shards: 10 },
} as const;
export const anonymousLimiter = new RateLimiter(components.rateLimiter, anonymousLimits);

export const consume = internalMutation({
  args: { ip: v.union(v.string(), v.null()) },
  handler: async (ctx, { ip }): Promise<RateLimitReturns> => {
    const name = ip ? "resolution" : "unverifiedResolution";
    const key = ip ?? "unverified";
    // Registry and limiter updates (including denials) are atomic with cleanup.
    await touchAdmissionBucket(ctx, name, key);
    return anonymousLimiter.limit(ctx, name, { key });
  },
});

export const anonymousHttpAction = (handler: Parameters<typeof httpAction>[0]) => httpAction(async (ctx, request) => {
  const verified = await verifiedAuthRequest(request, process.env.CONVEX_INTERNAL_SECRET);
  const ip = verified.headers.get(AUTH_CLIENT_IP_HEADER);
  // One shared allowance across publications, shares and arbitrary search values.
  // Direct callers cannot split it by forging forwarding headers or IDs.
  const result = await ctx.runMutation(internal.anonymousAdmission.consume, { ip });
  if (!result.ok) throw new RateLimitedError(result.retryAfter);
  return handler(ctx, request);
});

// Legacy capabilities resolve in the Worker; this admission grants no access.
export const admitLegacyResolution = anonymousHttpAction(() => Promise.resolve(Response.json({ admitted: true })));
