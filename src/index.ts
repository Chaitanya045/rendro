import { securityHeaders } from "./middleware/security-headers";
import { fontResponseHeaders } from "./routes/fonts";
import { publicAssetHeaders, publicAssetPaths } from "./routes/public-assets";
import { styleResponseHeaders } from "./routes/styles";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { requestLogPath } from "./request-log";
import { serve, type HttpBindings } from "@hono/node-server";
import { registerAuthClientIp } from "@/auth-client-ip";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { sessionMiddleware } from "@/middleware/session";
import { mountPublicRoutes, mountSessionRoutes } from "@/app-routes";
import { z } from "zod/v4";
import { logger } from "@/logger";
import { notFoundResponse } from "@/routes/not-found";
import type { User } from "better-auth/types";

// Only the local Node server listens on a port; Workers do not read PORT.
const PORT = z.coerce.number().int().min(1).max(65535).default(3000).parse(process.env.PORT);

export const app = new Hono<{ Bindings: HttpBindings; Variables: { user?: User } }>();
app.use("*", securityHeaders);

// Same contract as the Worker: an explicit allowlist of public assets, served before session
// middleware with identical headers. serveStatic only falls through for a missing file, so each
// route ends the request itself instead of entering the app.
const setAssetHeaders = (headersFor: (c: Context) => Record<string, string> | undefined): MiddlewareHandler => async (c, next) => {
  const assetHeaders = headersFor(c);
  if (!assetHeaders) return c.body(null, 404);
  await next();
  if (c.res.ok || c.res.status === 304) for (const [name, value] of Object.entries(assetHeaders)) c.header(name, value);
};
for (const path of publicAssetPaths) {
  app.get(path, setAssetHeaders(c => publicAssetHeaders(path, new URL(c.req.url).search)), serveStatic({ path: `./public${path}` }), c => c.body(null, 404));
}
app.get("/fonts/*", setAssetHeaders(c => fontResponseHeaders(c.req.path)), serveStatic({ root: "./public" }), c => c.body(null, 404));
app.get("/styles/*", setAssetHeaders(c => styleResponseHeaders(c.req.path)), serveStatic({ root: "./public" }), c => c.body(null, 404));

// Request timing
app.use("*", async (c, next) => {
  registerAuthClientIp(c.req.raw, c.env.incoming.socket.remoteAddress);
  const start = Date.now();
  await next();
  logger.debug(
    { method: c.req.method, route: requestLogPath(c), status: c.res.status, ms: Date.now() - start },
    "request"
  );
});

// CORS for sync API (CLI browser access not required, but harmless)
app.use("/api/sync/*", cors());

// Public signed share routes intentionally bypass session middleware.
mountPublicRoutes(app);

// Better-auth session — reads cookies, populates c.get("user")
app.use("*", sessionMiddleware);

// Specific auth routes (must be before /api/auth/* wildcard)
app.get("/api/auth/me", (c) => {
  const user = c.get("user");
  return c.json(user || { user: null });
});

// Auth/API proxies, management pages, legacy app routes, file streaming, and health check.
mountSessionRoutes(app);

app.notFound(notFoundResponse);

// Error handler
app.onError((_err, c) => {
  logger.error({ category: "UnhandledError", route: requestLogPath(c) }, "Unhandled error");
  return c.text("Internal server error", 500);
});

logger.info({ port: PORT }, "Server starting");

serve({
  fetch: app.fetch,
  port: PORT,
});
