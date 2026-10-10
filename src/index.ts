import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { sessionMiddleware } from "@/middleware/session";
import { mountPublicRoutes, mountSessionRoutes } from "@/app-routes";
import { z } from "zod/v4";
import { logger } from "@/logger";
import { renderNotFoundPage } from "@/routes/not-found";
import type { User } from "better-auth/types";

// Only the local Node server listens on a port; Workers do not read PORT.
const PORT = z.coerce.number().int().min(1).max(65535).default(3000).parse(process.env.PORT);

const app = new Hono<{ Variables: { user?: User } }>();

// Serve static assets (commentor.js, etc.)
app.use("/commentor.js", serveStatic({ path: "./public/commentor.js" }));
app.use("/commentor-parent.js", serveStatic({ path: "./public/commentor-parent.js" }));
app.use("/lazy-tree.js", serveStatic({ path: "./public/lazy-tree.js" }));
app.use("/management-query.js", serveStatic({ path: "./public/management-query.js" }));
app.use("/select.js", serveStatic({ path: "./public/select.js" }));
app.use("/management-pages.js", serveStatic({ path: "./public/management-pages.js" }));
app.use("/landing-product.webp", serveStatic({ path: "./public/landing-product.webp" }));

// Request timing
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.debug(
    { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start },
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

app.notFound((c) => c.html(renderNotFoundPage({ path: c.req.path }), 404));

// Error handler
app.onError((err, c) => {
  logger.error({ err }, "Unhandled error");
  return c.text("Internal server error", 500);
});

logger.info({ port: PORT }, "Server starting");

serve({
  fetch: app.fetch,
  port: PORT,
});
