import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

export const apiKeyRateLimits = {
  // Guidance: expected peak QPS / 2. The component divides BOTH rate and
  // capacity across shards: 2 requests/sec and 240 burst tokens per shard.
  credential: { kind: "token bucket", rate: 6_000, period: MINUTE, capacity: 12_000, shards: 50 },
  // Failure cleanup must remain available when uploads exhaust the main budget.
  cleanup: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 20 },
  failedIp: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 240 },
} as const;
export const apiKeyRateLimiter = new RateLimiter(components.rateLimiter, apiKeyRateLimits);
