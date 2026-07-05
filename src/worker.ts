// Cloudflare Workers entry point
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthInstance } from "./auth";
import { getAuth } from "./auth";
import { sessionMiddleware } from "./middleware/session";
import appRoutes from "./routes/app";
import docsRoutes from "./routes/docs";
import { logger } from "./logger";
import type { User } from "better-auth/types";

let auth: AuthInstance | null = null;

const app = new Hono<{ Variables: { user?: User } }>();

app.use("/api/sync/*", cors());

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.debug({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start }, "request");
});

app.use("*", async (c, next) => {
  if (!auth) {
    const env = c.env as Record<string, unknown>;
    auth = await getAuth(env);
  }
  await sessionMiddleware(c, next);
});

app.get("/api/auth/me", (c) => c.json(c.get("user") || { user: null }));

app.get("/api/auth/sign-out", async (c) => {
  if (!auth) return c.text("Auth not ready", 503);
  await auth.api.signOut({ headers: c.req.raw.headers });
  return c.redirect("/");
});

app.on(["POST", "GET"], "/api/auth/*", (c) => {
  if (!auth) return c.text("Auth not ready", 503);
  return auth.handler(c.req.raw);
});

app.route("/", appRoutes);
app.route("/", docsRoutes);

app.get("/health", (c) => c.text("ok"));

app.onError((err) => {
  logger.error({ err: { message: err.message, stack: err.stack, name: err.name } }, "Unhandled error");
  return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
});

export default app;
