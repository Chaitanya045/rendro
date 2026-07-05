import type { Context, Next } from "hono";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { CONVEX_URL } from "@/config";
import { logger } from "@/logger";

let convex: ConvexClient | null = null;

function getConvex(): ConvexClient {
  if (!convex) convex = new ConvexClient(CONVEX_URL);
  return convex;
}

export async function sessionMiddleware(c: Context, next: Next) {
  try {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
      const devEmail = c.req.header("X-Dev-User") || c.req.query("dev_user");
      if (devEmail) {
        c.set("user", {
          id: "dev", email: devEmail, name: "Dev User",
          emailVerified: true, image: null,
          createdAt: new Date(), updatedAt: new Date(),
        });
        await next();
        return;
      }
    }
    const cookie = c.req.raw.headers.get("cookie") || "";
    const match = cookie.match(/better-auth\.session_token=([^;]+)/);
    if (!match) { await next(); return; }

    const user = await getConvex().query(api.auth.verifySession, { token: match[1] });
    if (user) c.set("user", user);
  } catch (err) {
    logger.debug({ err }, "Session lookup failed (anonymous request)");
  }
  await next();
}
