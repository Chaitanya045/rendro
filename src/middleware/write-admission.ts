import type { MiddlewareHandler } from "hono";
import { requireCookieWrite, RequestAdmissionError } from "../../shared/request-admission";

export const workerMutationPolicies = {
  "POST /api/auth/sign-out": "better-auth",
  "POST /api/auth/*": "better-auth",
  "POST /api/auth/set-initial-password": "cookie-json",
  "POST /api/rendro/projects": "cookie-json",
  "POST /api/rendro/credentials": "cookie-json",
  "POST /api/rendro/credentials/revoke": "cookie-json",
  "POST /api/rendro/shares": "cookie-json",
  "POST /api/rendro/shares/revoke": "cookie-json",
  "POST /api/rendro/publications": "mixed-json",
  "POST /api/rendro/publications/remove": "mixed-json",
  "POST /api/rendro/deployments/start": "bearer",
  "POST /api/rendro/deployments/fail": "bearer",
  "PUT /api/rendro/deployments/:deploymentId/files/*": "bearer",
  "POST /api/rendro/deployments/:deploymentId/copy": "bearer",
  "POST /api/rendro/deployments/:deploymentId/commit": "bearer",
  "POST /api/rendro/migration/project": "bearer",
  "POST /api/rendro/*": "convex",
  "PATCH /api/rendro/*": "convex",
  "DELETE /api/rendro/*": "convex",
  "DELETE /api/legacy/content": "cookie-bodyless",
  // Comment access for repository docs (#254); mounted before this middleware, so the route applies the same rule itself.
  "POST /r/*": "cookie-bodyless",
  "POST /api/orgs": "retired",
  "POST /api/publications": "mixed-json",
  "DELETE /api/publications/:slug": "mixed-bodyless",
  "POST /api/sync/upload": "retired",
  "DELETE /api/sync/delete": "retired",
} as const;

export const writeAdmission: MiddlewareHandler = async (c, next) => {
  const path = c.req.path.replace(/^\/api\/publications\/[^/]+$/, "/api/publications/:slug");
  const key = `${c.req.method} ${path}` as keyof typeof workerMutationPolicies;
  const policy = workerMutationPolicies[key];
  // Proxies with Authorization defer credential selection to Convex. Legacy
  // publication handlers reject retired credentials when that header is present.
  if (policy === "cookie-json" || policy === "cookie-bodyless" || ((policy === "mixed-json" || policy === "mixed-bodyless")
    && !c.req.raw.headers.has("authorization"))) {
    try {
      // Worker ingress supplies the URL host. SITE_URL, when configured, pins
      // it further; Convex always requires its configured canonical SITE_URL.
      requireCookieWrite(c.req.raw, process.env.SITE_URL ?? new URL(c.req.url).origin, policy !== "mixed-bodyless" && policy !== "cookie-bodyless");
    } catch (error) {
      if (!(error instanceof RequestAdmissionError)) throw error;
      return c.json({ error: error.message }, error.status);
    }
  }
  await next();
};
