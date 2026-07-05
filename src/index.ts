import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { auth } from "@/auth";
import { sessionMiddleware } from "@/middleware/session";
import appRoutes from "@/routes/app";
import docsRoutes from "@/routes/docs";
import { PORT } from "@/config";
import { logger } from "@/logger";
import type { User } from "better-auth/types";

const app = new Hono<{ Variables: { user?: User } }>();

// Serve static assets (commentor.js, etc.)
app.use("/commentor.js", serveStatic({ path: "./public/commentor.js" }));
app.use("/lazy-tree.js", serveStatic({ path: "./public/lazy-tree.js" }));

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

// Better-auth session — reads cookies, populates c.get("user")
app.use("*", sessionMiddleware);

// Specific auth routes (must be before /api/auth/* wildcard)
app.get("/api/auth/me", (c) => {
  const user = c.get("user");
  return c.json(user || { user: null });
});

// Sign-out route — clears the session cookie and redirects home
app.get("/api/auth/sign-out", async (c) => {
  await auth!.api.signOut({ headers: c.req.raw.headers });
  return c.redirect("/");
});

// Better-auth handler — handles /api/auth/sign-in/google, /api/auth/sign-out, etc.
app.on(["POST", "GET"], "/api/auth/*", (c) => auth!.handler(c.req.raw));

// Main app routes — sign-in / derive org / show docs / create org form
app.route("/", appRoutes);

// File streaming + sync API
app.route("/", docsRoutes);

// Health check
app.get("/health", (c) => c.text("ok"));

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
