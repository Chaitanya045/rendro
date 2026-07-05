// Cloudflare Workers entry point
// Static assets served via [assets] binding in wrangler.toml

import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { sessionMiddleware } from "./middleware/session";
import appRoutes from "./routes/app";
import docsRoutes from "./routes/docs";
import { logger } from "./logger";
import type { User } from "better-auth/types";

const app = new Hono<{ Variables: { user?: User } }>();

app.use("/api/sync/*", cors());
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.debug({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start }, "request");
});
app.use("*", sessionMiddleware);
app.get("/api/auth/me", (c) => c.json(c.get("user") || { user: null }));
app.get("/api/auth/sign-out", async (c) => {
  await auth.api.signOut({ headers: c.req.raw.headers });
  return c.redirect("/");
});
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/", appRoutes);
app.route("/", docsRoutes);
app.get("/health", (c) => c.text("ok"));
app.onError((err, c) => {
  logger.error({ err }, "Unhandled error");
  return c.text("Internal server error", 500);
});

export default app;
