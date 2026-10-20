// Cloudflare Workers entry point
// Auth is proxied to Convex HTTP actions. Database tables are in Convex component.
import { securityHeaders } from "./middleware/security-headers";
import { fontResponseHeaders } from "./routes/fonts";
import { publicAssetHeaders, publicAssetPaths } from "./routes/public-assets";
import { styleResponseHeaders } from "./routes/styles";
import { Hono } from "hono";
import { requestLogPath } from "./request-log";
import type { Context } from "hono";
import { sessionMiddleware } from "./middleware/session";
import { logger } from "./logger";
import { registerAuthClientIp } from "./auth-client-ip";
import { notFoundResponse } from "./routes/not-found";
import { mountPublicRoutes, mountSessionRoutes } from "./app-routes";
import type { User } from "better-auth/types";

type AssetsBinding = { fetch(request: Request): Response | Promise<Response> };
type WorkerBindings = Record<string, unknown> & { ASSETS?: AssetsBinding };
type WorkerEnv = { Bindings: WorkerBindings; Variables: { user?: User } };

const app = new Hono<WorkerEnv>();
app.use("*", securityHeaders);

async function serveAsset(c: Context<WorkerEnv>): Promise<Response> {
  const assets = c.env?.ASSETS;
  if (assets?.fetch) return assets.fetch(c.req.raw);
  return notFoundResponse(c);
}

app.use("*", async (c, next) => {
  // Cloudflare overwrites this header at ingress. Node never trusts it.
  registerAuthClientIp(c.req.raw, c.req.header("CF-Connecting-IP"));
  const env = c.env;
  if (env && typeof process !== "undefined") {
    for (const key of Object.keys(env)) {
      const value = env[key];
      if (typeof value === "string" && process.env[key] === undefined) process.env[key] = value;
    }
  }
  await next();
});

app.use("*", async (c, next) => { const start = Date.now(); await next(); logger.debug({ method: c.req.method, route: requestLogPath(c), status: c.res.status, ms: Date.now() - start }, "request"); });
// Signed image URLs and repository capabilities bypass session middleware.
mountPublicRoutes(app);

// Public static assets never trigger a session lookup. Everything is an explicit allowlist (see
// routes/public-assets.ts): a path outside it is a 404, never an ASSETS fallthrough. A 304 keeps the
// same headers so a revalidation cannot downgrade an immutable entry.
async function servePublicAsset(c: Context<WorkerEnv>, assetHeaders: Record<string, string> | undefined): Promise<Response> {
  if (!assetHeaders) return c.body(null, 404);
  const response = await serveAsset(c);
  if (!response.ok && response.status !== 304) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(assetHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

for (const path of publicAssetPaths) {
  app.get(path, (c) => servePublicAsset(c, publicAssetHeaders(path, new URL(c.req.url).search)));
}
// Self-hosted fonts and stylesheets are content-hashed and immutable. Anything under /fonts or
// /styles that is not a hashed font, license text or hashed stylesheet is a 404.
app.get("/fonts/*", (c) => servePublicAsset(c, fontResponseHeaders(c.req.path)));
app.get("/styles/*", (c) => servePublicAsset(c, styleResponseHeaders(c.req.path)));

app.use("*", sessionMiddleware);

mountSessionRoutes(app);

// Unknown GETs render the shared 404. There is no ASSETS fallthrough: only the allowlisted public
// assets above are ever served from the binding.
app.get("*", notFoundResponse);
app.notFound(notFoundResponse);

app.onError((_err, c) => {
  logger.error({ category: "UnhandledError", route: requestLogPath(c) }, "Unhandled error");
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
