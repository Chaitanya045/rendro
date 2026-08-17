import type { Context, Next } from "hono";
import type { User } from "better-auth/types";
import { CONVEX_SITE_URL } from "@/config";
import { logger } from "@/logger";


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
  const sessionUser = value as Record<string, unknown>;
  return typeof sessionUser.id === "string"
    && typeof sessionUser.email === "string"
    && typeof sessionUser.name === "string"
    && typeof sessionUser.emailVerified === "boolean"
    && typeof sessionUser.createdAt === "string"
    && typeof sessionUser.updatedAt === "string";
}


export async function sessionMiddleware(
  c: Context<{ Variables: { user?: User } }>,
  next: Next,
): Promise<void> {
  try {

    const cookie = c.req.raw.headers.get("cookie") || "";
    if (!cookie.includes("better-auth")) { await next(); return; }

    // Use better-auth's built-in get-session endpoint via Convex
    const res = await fetch(`${CONVEX_SITE_URL}/api/auth/get-session`, {
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
    });

    if (res.ok) {
      const text = await res.text();
      if (text && text !== "null") {
        const data: unknown = JSON.parse(text);
        if (data && typeof data === "object" && "user" in data && isSessionUser(data.user)) {
          c.set("user", {
            ...data.user,
            createdAt: new Date(data.user.createdAt),
            updatedAt: new Date(data.user.updatedAt),
          });
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
