import type { MiddlewareHandler } from "hono";
import { requireCookieWrite, RequestAdmissionError } from "../../shared/request-admission";

export const workerMutationPolicies = {
  "POST /api/auth/sign-out": "better-auth",
  "POST /api/auth/*": "better-auth",
  "POST /api/auth/set-initial-password": "cookie-json",
  "POST /api/rendro/projects": "cookie-json",
  "POST /api/rendro/credentials": "cookie-json",
  "POST /api/rendro/credentials/revoke": "cookie-json",
  "POST /api/rendro/*": "convex",
  "PATCH /api/rendro/*": "convex",
  "DELETE /api/rendro/*": "convex",
  // Comment access for repository docs (#254); mounted before this middleware, so the route applies the same rule itself.
  "POST /r/*": "cookie-bodyless",
  // Real-user monitoring beacons (#282); mounted before this middleware and cookie-free, it refuses cross-site posts itself
  // (Sec-Fetch-Site, or an exact Origin), since a beacon from the no-referrer shell may carry "Origin: null".
  "POST /rum": "beacon",
} as const;

export const writeAdmission: MiddlewareHandler = async (c, next) => {
  const key = `${c.req.method} ${c.req.path}` as keyof typeof workerMutationPolicies;
  const policy = workerMutationPolicies[key];
  // The wildcard entries (POST /r/*, POST /rum) belong to routes mounted before this middleware, which apply them themselves.
  if (policy === "cookie-json") {
    try {
      // Worker ingress supplies the URL host. SITE_URL, when configured, pins
      // it further; Convex always requires its configured canonical SITE_URL.
      requireCookieWrite(c.req.raw, process.env.SITE_URL ?? new URL(c.req.url).origin);
    } catch (error) {
      if (!(error instanceof RequestAdmissionError)) throw error;
      return c.json({ error: error.message }, error.status);
    }
  }
  await next();
};
