import type { Context, Next } from "hono";
import { CONVEX_URL } from "@/config";
import { logger } from "@/logger";

const CONVEX_SITE = CONVEX_URL.replace(".cloud", ".site");

export async function sessionMiddleware(c: Context, next: Next) {
  try {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
      const devEmail = c.req.header("X-Dev-User") || c.req.query("dev_user");
      if (devEmail) {
        c.set("user", { id: "dev", email: devEmail, name: "Dev User", emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() });
        await next(); return;
      }
    }

    const cookie = c.req.raw.headers.get("cookie") || "";
    if (!cookie.includes("better-auth")) { await next(); return; }

    // Use better-auth's built-in get-session endpoint through the proxy
    const res = await fetch(`${CONVEX_SITE}/api/auth/get-session`, {
      headers: {
        cookie,
        accept: "application/json",
      },
    });
    if (res.ok) {
      const data = await res.json() as any;
      if (data?.user) c.set("user", data.user);
    }
  } catch (err) {
    logger.debug({ err }, "Session lookup failed");
  }
  await next();
}
