import type { Context, Next } from "hono";
import { CONVEX_URL } from "@/config";
import { logger } from "@/logger";

const CONVEX_SITE = CONVEX_URL.replace(".cloud", ".site");

interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

function isSessionUser(value: unknown): value is SessionUser {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.email === "string" && typeof v.id === "string";
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
        await next(); return;
      }
    }

    const cookie = c.req.raw.headers.get("cookie") || "";
    if (!cookie.includes("better-auth")) { await next(); return; }

    // Use better-auth's built-in get-session endpoint via Convex
    const res = await fetch(`${CONVEX_SITE}/api/auth/get-session`, {
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
    });

    if (res.ok) {
      const text = await res.text();
      if (text && text !== "null") {
        const data = JSON.parse(text);
        if (data && typeof data === "object" && "user" in data && isSessionUser(data.user)) {
          c.set("user", data.user);
          logger.debug({ email: data.user.email }, "Session validated");
        }
      }
    } else {
      logger.warn({ status: res.status }, "get-session returned non-OK");
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Session lookup error");
  }
  await next();
}
