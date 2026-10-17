import { unavailableResponse } from "@/routes/viewer-unavailable";
import type { Context, Next } from "hono";
import type { User } from "better-auth/types";
import { CONVEX_SITE_URL } from "@/config";
import { sessionTokenCookie, viewerSessionCookie } from "@/viewer-ticket";
import { logger } from "@/logger";
import { authClientIpHeaders } from "@/auth-client-ip";
import { renderSessionUnavailablePage } from "@/routes/session-unavailable";
import { sessionCache, evictRejectedSession } from "@/session-cache";
export { sessionCache } from "@/session-cache";

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
  if (typeof value === "number") return Number.isFinite(new Date(value).getTime());
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


type LookupFailure = {
  kind: "failure";
  category: "network" | "timeout" | "rate_limit" | "upstream" | "malformed_response" | "unexpected_status";
  status?: number;
  retryAfterMs?: number;
};
export type LookupResult = { kind: "anonymous" } | { kind: "authenticated"; user: SessionUser; expiresAt: number } | LookupFailure;

const LOOKUP_TIMEOUT_MS = 5_000;
const RETRY_BACKOFF_MS = 150;
const MAX_RETRY_BACKOFF_MS = 1_000;

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

async function lookupSession(request: Request, cookie: string): Promise<LookupResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    // Go directly to Convex's Better Auth HTTP handler, with the same signed
    // ingress IP as the auth proxy. Only validated, unexpired successes cache.
    const target = `${CONVEX_SITE_URL}/api/auth/get-session`;
    const res = await fetch(target, {
      headers: {
        ...Object.fromEntries(await authClientIpHeaders(request, target, "GET")),
        cookie,
        accept: "application/json",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    await evictRejectedSession(cookie, res.status);
    if (!res.ok && res.status !== 401) {
      const failure: LookupFailure = {
        kind: "failure",
        category: res.status === 429 ? "rate_limit" : res.status >= 500 ? "upstream" : "unexpected_status",
        status: res.status,
        retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
      };
      void res.body?.cancel().catch(() => {});
      return failure;
    }
    // Keep the deadline active while consuming the body, too.
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { kind: "failure", category: "malformed_response", status: res.status };
    }
    // Better Auth returns JSON null for missing, invalid, expired or revoked
    // sessions; this specific 401 also covers deletion during session refresh.
    if (res.status === 401) {
      if (data && typeof data === "object" && "code" in data && data.code === "FAILED_TO_GET_SESSION") {
        return { kind: "anonymous" };
      }
      return { kind: "failure", category: "unexpected_status", status: res.status };
    }
    if (data === null) return { kind: "anonymous" };
    if (data && typeof data === "object" && "user" in data && isSessionUser(data.user)) {
      const session = "session" in data ? data.session : undefined;
      if (!session || typeof session !== "object" || !("expiresAt" in session)
        || !isSerializedDate(session.expiresAt)) {
        return { kind: "failure", category: "malformed_response", status: res.status };
      }
      const expiresAt = new Date(session.expiresAt).getTime();
      if (expiresAt <= Date.now()) return { kind: "anonymous" };
      // Copy only public user fields; never retain session.token or extra data.
      const { id, email, name, emailVerified, image, createdAt, updatedAt } = data.user;
      return { kind: "authenticated", expiresAt, user: {
        id, email, name, emailVerified, image: typeof image === "string" ? image : null, createdAt, updatedAt,
      } };
    }
    return { kind: "failure", category: "malformed_response", status: res.status };
  } catch {
    // Do not log exception messages, upstream bodies, cookies or identity data.
    return { kind: "failure", category: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupWithRetry(request: Request, cookie: string, cached: boolean): Promise<LookupResult> {
  for (let attempt = 1; ; attempt++) {
    // Coalesce only the first read. A failed entry is removed before backoff;
    // retries have independent deadlines and cannot retain a failed promise.
    const result = cached && attempt === 1
      ? await sessionCache.lookup(cookie, () => lookupSession(request, cookie))
      : await lookupSession(request, cookie);
    if (result.kind === "failure") {
      logger.warn({ category: result.category, status: result.status ?? null, attempt }, "Session lookup failed");
      const delay = Math.max(RETRY_BACKOFF_MS, result.retryAfterMs ?? 0);
      // Only repeat the session GET, never the incoming request or its writes.
      // A long Retry-After belongs in the 503, not a premature second request.
      if (attempt < 2 && result.category !== "unexpected_status" && delay <= MAX_RETRY_BACKOFF_MS) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
    return result;
  }
}


export async function sessionMiddleware(
  c: Context<{ Variables: { user?: User } }>,
  next: Next,
): Promise<void> {
  const path = c.req.path;
  const cookie = viewerSessionCookie(c.req.raw.headers.get("cookie") || "");
  const finish = async () => {
    await next();
    await evictRejectedSession(cookie, c.res.status);
  };
  if (
    path.startsWith("/api/auth/")
    || path.startsWith("/api/rendro/")
    || path.startsWith("/api/sync/")
    // These routes authorize exclusively through the encrypted ticket, then
    // freshly revalidate its session and membership in Convex on every request.
    || /^\/legacy-view\/[^/]+\/view\/[^/]+\/files\//.test(path)
    || /^\/organizations\/[^/]+\/projects\/[^/]+\/docs\/view\/[^/]+\/files\//.test(path)
  ) {
    await finish();
    return;
  }

  let sessionDuration: string | undefined;
  // `cookie` holds only session-token and preference pairs (see viewerSessionCookie).
  if (sessionTokenCookie(cookie)) {
    const sessionStartedAt = performance.now();
    // Only modern scoped pages/documents redundantly validate the live session
    // and membership downstream. All other routes (including landing, sign-in,
    // sign-up/Get started, account pages and legacy storage) need fresh identity.
    const cached = c.req.method === "GET" && /^(?:\/organizations\/[^/]+(?:\/|$)|\/accept-invitation\/[^/]+$)/.test(path);
    if (!cached) await sessionCache.evict(cookie);
    const result = await lookupWithRetry(c.req.raw, cookie, cached);
    if (result.kind === "anonymous") await sessionCache.evict(cookie);
    sessionDuration = duration(sessionStartedAt);
    if (result.kind === "failure") {
      const retryAfter = String(Math.max(1, Math.ceil((result.retryAfterMs ?? 1_000) / 1_000)));
      c.header("Cache-Control", "private, no-store");
      c.header("Retry-After", retryAfter);
      appendTiming(c, "session", sessionDuration);
      const wantsHtml = !path.startsWith("/api/") && c.req.header("accept")?.includes("text/html");
      c.res = /^\/legacy-view\/[^/]+\/files\//.test(path)
        ? unavailableResponse(c, { unavailable: true, retryAfter }, "asset")
        : wantsHtml
        ? c.html(renderSessionUnavailablePage(), 503)
        : c.json({ error: "Session temporarily unavailable", retryable: true }, 503);
      return;
    }
    if (result.kind !== "anonymous") {
      c.set("user", {
        ...result.user,
        createdAt: new Date(result.user.createdAt),
        updatedAt: new Date(result.user.updatedAt),
      });
      logger.debug("Session validated");
    }
  }

  const renderStartedAt = performance.now();
  await finish();
  if (sessionDuration !== undefined) {
    c.header("Cache-Control", "private, no-store");
    appendTiming(c, "session", sessionDuration);
  }
  appendTiming(c, "render", duration(renderStartedAt));
}
