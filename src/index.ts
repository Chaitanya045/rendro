import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { proxyAuthRequest, proxyAuthSignOut, proxyConvexRequest } from "@/auth-proxy";
import { sessionMiddleware } from "@/middleware/session";
import appRoutes from "@/routes/app";
import authPageRoutes from "@/routes/auth-pages";
import organizationPageRoutes from "@/routes/organization-pages";
import projectPageRoutes from "@/routes/project-pages";
import deploymentRoutes from "@/routes/deployments";
import publicationPageRoutes from "@/routes/publication-pages";
import publicationApiRoutes from "@/routes/publication-api";
import projectDocsRoutes from "@/routes/project-docs";
import sharePageRoutes from "@/routes/share-pages";
import apiKeyPageRoutes from "@/routes/api-key-pages";
import docsRoutes from "@/routes/docs";
import shareRoutes from "@/routes/share";
import shareV2Routes from "@/routes/share-v2";
import publicV2Routes from "@/routes/public-v2";
import publicRoutes from "@/routes/public";
import publicationRoutes from "@/routes/publications";
import { PORT } from "@/config";
import { logger } from "@/logger";
import { renderNotFoundPage } from "@/routes/not-found";
import type { User } from "better-auth/types";

const app = new Hono<{ Variables: { user?: User } }>();

// Serve static assets (commentor.js, etc.)
app.use("/commentor.js", serveStatic({ path: "./public/commentor.js" }));
app.use("/lazy-tree.js", serveStatic({ path: "./public/lazy-tree.js" }));
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
app.route("/", publicV2Routes);
app.route("/", shareV2Routes);
app.use("/api/sync/*", cors());

// Public signed share routes intentionally bypass session middleware.
app.route("/", shareRoutes);
app.route("/", publicRoutes);

// Better-auth session — reads cookies, populates c.get("user")
app.use("*", sessionMiddleware);

// Specific auth routes (must be before /api/auth/* wildcard)
app.get("/api/auth/me", (c) => {
  const user = c.get("user");
  return c.json(user || { user: null });
});

// Local and deployed runtimes use the same Convex-backed Better Auth service.
app.get("/api/auth/sign-out", (c) => proxyAuthSignOut(c.req.raw));

app.on(["POST", "GET", "OPTIONS"], "/api/auth/*", async (c) => {
  try {
    return await proxyAuthRequest(c.req.raw);
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Auth proxy error",
    );
    return c.json({ error: "Auth unavailable" }, 502);
  }
});
app.route("/", deploymentRoutes);
app.route("/", publicationApiRoutes);


app.on(["POST", "GET", "PATCH", "DELETE"], "/api/rendro/*", async (c) => {
  try {
    return await proxyConvexRequest(c.req.raw);
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Convex API proxy error",
    );
    return c.json({ error: "Backend unavailable" }, 502);
  }
});
app.route("/", authPageRoutes);
app.route("/", organizationPageRoutes);
app.route("/", projectPageRoutes);
app.route("/", projectDocsRoutes);
app.route("/", publicationPageRoutes);
app.route("/", sharePageRoutes);
app.route("/", apiKeyPageRoutes);





// Main app routes — sign-in / derive org / show docs / create org form
app.route("/", appRoutes);
app.route("/", publicationRoutes);

// File streaming + sync API
app.route("/", docsRoutes);

// Health check
app.get("/health", (c) => c.text("ok"));

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
