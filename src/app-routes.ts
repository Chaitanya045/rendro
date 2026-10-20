import { bodyAdmission } from "./middleware/body-admission";
import { writeAdmission } from "./middleware/write-admission";
import type { Hono } from "hono";
import type { User } from "better-auth/types";
import { proxyAuthRequest, proxyAuthSignOut, proxyConvexRequest } from "@/auth-proxy";
import { logger } from "@/logger";
import appRoutes from "@/routes/app";
import authPageRoutes from "@/routes/auth-pages";
import organizationPageRoutes from "@/routes/organization-pages";
import projectPageRoutes from "@/routes/project-pages";
import apiKeyPageRoutes from "@/routes/api-key-pages";
import imageProxyRoutes from "@/routes/image-proxy";
import repoReadRoutes from "@/repo-read/routes";
import rumRoutes from "@/rum/route";

// Route mounting shared by the Node server (src/index.ts) and the Cloudflare
// Worker (src/worker.ts). Each entry point owns its middleware, static assets,
// and error handling.
type AppEnv = { Variables: { user?: User } };

/** Routes that authorize without the session middleware (signed image URLs, repository capabilities). Mount before it. */
export function mountPublicRoutes<E extends AppEnv>(app: Hono<E>): void {
  // Signed URLs only; every response is cacheable, so no per-request admission call.
  app.route("/", imageProxyRoutes);
  // Repository docs authorize with their own capability cookie and look the session up only on a miss.
  app.route("/", repoReadRoutes);
  // Real-user monitoring beacons (#282): same-origin posts only, no cookie read or set.
  app.route("/", rumRoutes);
}

/** Auth proxy, Convex API proxy, and application routes. Mount after session middleware. */
export function mountSessionRoutes<E extends AppEnv>(app: Hono<E>): void {
  app.use("*", writeAdmission);
  app.use("*", bodyAdmission);
  // GET confirms; only a same-origin POST revokes the session.
  app.on(["GET", "POST"], "/api/auth/sign-out", (c) => proxyAuthSignOut(c.req.raw));

  // Proxy auth to Convex
  app.on(["POST", "GET", "OPTIONS"], "/api/auth/*", async (c) => {
    try {
      return await proxyAuthRequest(c.req.raw);
    } catch {
      logger.error(
        { category: "TransportError" },
        "Auth proxy error",
      );
      return c.json({ error: "Auth unavailable" }, 502);
    }
  });

  app.on(["POST", "GET", "PATCH", "DELETE"], "/api/rendro/*", async (c) => {
    try {
      return await proxyConvexRequest(c.req.raw);
    } catch {
      logger.error(
        { category: "TransportError" },
        "Convex API proxy error",
      );
      return c.json({ error: "Backend unavailable" }, 502);
    }
  });
  app.route("/", authPageRoutes);
  app.route("/", organizationPageRoutes);
  app.route("/", projectPageRoutes);
  app.route("/", apiKeyPageRoutes);

  app.route("/", appRoutes);
  app.get("/health", (c) => c.text("ok"));
}
