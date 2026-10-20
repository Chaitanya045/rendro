import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { touchAdmissionBucket } from "./admissionBuckets";
import type { MutationCtx } from "./_generated/server";

export const writeQuotaLimits = {
  comments: { kind: "token bucket", rate: 30, period: MINUTE, capacity: 30 },
  projects: { kind: "token bucket", rate: 20, period: HOUR, capacity: 20 },
  credentials: { kind: "token bucket", rate: 20, period: HOUR, capacity: 20 },
} as const;
export const writeQuotaLimiter = new RateLimiter(components.rateLimiter, writeQuotaLimits);

/** Both debits and the write share one transaction; a denial rolls all back.
 * Actor buckets span organizations. Tenant buckets provide 10 actors' capacity.
 * No global bucket lets one tenant consume another tenant's allowance. */
export async function consumeWriteQuota(ctx: MutationCtx, resource: keyof typeof writeQuotaLimits, userId: string, organizationId: string): Promise<void> {
  await touchAdmissionBucket(ctx, resource, `user:${userId}`);
  await touchAdmissionBucket(ctx, `${resource}:organization`, organizationId);
  await writeQuotaLimiter.limit(ctx, resource, { key: `user:${userId}`, throws: true });
  const limit = writeQuotaLimits[resource];
  await writeQuotaLimiter.limit(ctx, `${resource}:organization`, {
    key: organizationId,
    config: { ...limit, rate: limit.rate * 10, capacity: limit.capacity * 10 },
    throws: true,
  });
}
