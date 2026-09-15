import type { Context, Next } from "hono";
import type { User } from "better-auth/types";
import { CONVEX_SITE_URL } from "@/config";
import { logger } from "@/logger";

type SerializedDate = string | number;

function duration(startedAt: number): string {
  return Math.max(0, performance.now() - startedAt).toFixed(1);
}

function appendTiming(c: Context, metric: string, elapsed: string): void {
  c.header("Server-Timing", `${metric};dur=${elapsed}`, { append: true });
}

interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: SerializedDate;
  updatedAt: SerializedDate;
}
function isSerializedDate(value: unknown): value is SerializedDate {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSessionUser(value: unknown): value is SessionUser {
  if (!value || typeof value !== "object") return false;
  const sessionUser = value as Record<string, unknown>;
  return typeof sessionUser.id === "string"
    && typeof sessionUser.email === "string"
    && typeof sessionUser.name === "string"
    && typeof sessionUser.emailVerified === "boolean"
    && isSerializedDate(sessionUser.createdAt)
    && isSerializedDate(sessionUser.updatedAt);
}


export async function sessionMiddleware(
  c: Context<{ Variables: { user?: User } }>,
  next: Next,
): Promise<void> {
  const path = c.req.path;
  if (
    path.startsWith("/api/auth/")
    || path.startsWith("/api/rendro/")
    || path.startsWith("/api/sync/")
  ) {
    await next();
    return;
  }

  const cookie = c.req.raw.headers.get("cookie") || "";
  let sessionDuration: string | undefined;
  if (cookie.includes("better-auth")) {
    const sessionStartedAt = performance.now();
    try {
      // Use better-auth's built-in get-session endpoint via Convex. A fresh
      // lookup on every cookie-authenticated request keeps revoked sessions
      // fail-closed; do not add an application-side session cache here.
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
            logger.debug("Session validated");
          }
        }
      } else {
        logger.warn({ status: res.status }, "get-session returned non-OK");
      }
    } catch (err) {
      logger.error(
        { errorType: err instanceof Error ? err.name : "UnknownError" },
        "Session lookup error",
      );
    } finally {
      sessionDuration = duration(sessionStartedAt);
    }
  }

  const renderStartedAt = performance.now();
  await next();
  if (sessionDuration !== undefined) {
    c.header("Cache-Control", "private, no-store");
    appendTiming(c, "session", sessionDuration);
  }
  appendTiming(c, "render", duration(renderStartedAt));
}
