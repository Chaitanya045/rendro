import type { Hono } from "hono";
import type { User } from "better-auth/types";
import { proxyAuthRequest, proxyAuthSignOut, proxyConvexRequest } from "@/auth-proxy";
import { logger } from "@/logger";
import appRoutes from "@/routes/app";
import authPageRoutes from "@/routes/auth-pages";
import organizationPageRoutes from "@/routes/organization-pages";
import projectPageRoutes from "@/routes/project-pages";
import deploymentRoutes from "@/routes/deployments";
import migrationRoutes from "@/routes/migration";
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

// Route mounting shared by the Node server (src/index.ts) and the Cloudflare
// Worker (src/worker.ts). Each entry point owns its middleware, static assets,
// and error handling.
type AppEnv = { Variables: { user?: User } };

/** Public signed share and publication routes. Mount before session middleware. */
export function mountPublicRoutes<E extends AppEnv>(app: Hono<E>): void {
  app.route("/", publicV2Routes);
  app.route("/", shareV2Routes);
  app.route("/", shareRoutes);
  app.route("/", publicRoutes);
}

/** Auth proxy, Convex API proxy, and application routes. Mount after session middleware. */
export function mountSessionRoutes<E extends AppEnv>(app: Hono<E>): void {
  // GET confirms; only a same-origin POST revokes the session.
  app.on(["GET", "POST"], "/api/auth/sign-out", (c) => proxyAuthSignOut(c.req.raw));

  // Proxy auth to Convex
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
  app.route("/", migrationRoutes);
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
  app.route("/", publicationPageRoutes);
  app.route("/", projectDocsRoutes);
  app.route("/", sharePageRoutes);
  app.route("/", apiKeyPageRoutes);

  app.route("/", appRoutes);
  app.route("/", publicationRoutes);
  app.route("/", docsRoutes);
  app.get("/health", (c) => c.text("ok"));
}
