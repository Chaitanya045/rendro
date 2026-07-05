import type { Context, Next } from "hono";
import { CONVEX_URL } from "@/config";
import { logger } from "@/logger";

const CONVEX_CLOUD = CONVEX_URL;

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
    const match = cookie.match(/better-auth\.session_token=([^;]+)/);
    if (!match) { await next(); return; }

    // Call Convex verifySession query
    const res = await fetch(`${CONVEX_CLOUD}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "auth.js:verifySession", args: [{ token: match[1] }] }),
    });
    const data = await res.json() as any;
    if (data?.status === "success" && data.value) {
      c.set("user", data.value);
    }
  } catch (err) {
    logger.debug({ err }, "Session lookup failed");
  }
  await next();
}
