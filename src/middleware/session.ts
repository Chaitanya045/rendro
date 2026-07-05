import type { Context, Next } from "hono";
import { auth, getAuth } from "@/auth";
import { logger } from "@/logger";

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
    const authInstance = auth ?? await getAuth(c.env as Record<string, unknown>);
    const session = await authInstance.api.getSession({ headers: c.req.raw.headers });
    if (session) c.set("user", session.user);
  } catch (err) {
    logger.debug({ err }, "Session lookup failed (anonymous request)");
  }
  await next();
}
