/**
 * Per-client admission on the repository read path (#294): first views of a
 * branch nothing serves yet, and full-text search, each take one token from a
 * Workers Rate Limiting binding (`[[ratelimits]]`), keyed on the
 * ingress-verified client address as `/rum` is (#282). The counter lives in
 * the colo: no round trip, nothing outside the Worker, and the address is the
 * key only, never stored or logged.
 */
import { authClientIp } from "@/auth-client-ip";
import type { RateLimiter } from "@/rum/route";

export type { RateLimiter };

/** Requests whose address the ingress did not register share one bucket. */
const UNVERIFIED_KEY = "unverified";

/** The binding `name`, when the environment configures one. */
export function rateLimiter(env: Record<string, unknown>, name: string): RateLimiter | null {
  const value = env[name] as Record<string, unknown> | undefined;
  return typeof value?.limit === "function" ? value as unknown as RateLimiter : null;
}

/** One token for this request's client: whether it was granted, or null when the limiter could not answer. */
export async function takeToken(limiter: RateLimiter, request: Request): Promise<boolean | null> {
  try {
    return (await limiter.limit({ key: authClientIp(request) ?? UNVERIFIED_KEY })).success;
  } catch {
    return null;
  }
}
