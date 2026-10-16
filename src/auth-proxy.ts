import { apiCacheControl } from "../shared/http-cache";
import { readBoundedBody, BodyTooLargeError } from "./bounded-body";
import { renderSignOutPage } from "@/routes/sign-out";
import { sessionCache } from "@/session-cache";
import { CONVEX_SITE_URL } from "@/config";
import { logger } from "@/logger";
import { backendFetch } from "@/backend-fetch";
import { authClientIpHeaders } from "@/auth-client-ip";

// Only these pass-through API-key reads accept bearer credentials. Keep auth
// and management routes cookie-only; deployment writes use dedicated Worker
// handlers (including storage validation before commit).
const API_KEY_GET_PATHS = new Set([
  "/api/rendro/credentials/validate",
  "/api/rendro/deployments/active",
  "/api/rendro/deployments/staging",
  "/api/rendro/deployments",
]);

const SESSION_REVOCATION_PATHS = new Set([
  "/api/auth/revoke-session", "/api/auth/revoke-sessions", "/api/auth/revoke-other-sessions",
  "/api/auth/change-password", "/api/auth/reset-password", "/api/auth/delete-user",
]);

const AUTH_COOKIE_NAMES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
  "__Secure-better-auth.session_data",
  "better-auth.session_data",
  "__Secure-better-auth.session_data.0",
  "better-auth.session_data.0",
  "__Secure-better-auth.session_data.1",
  "better-auth.session_data.1",
  "__Secure-better-auth.state",
  "better-auth.state",
  "__Secure-better-auth.oauth_state",
  "better-auth.oauth_state",
  "convex_jwt",
  "rendro-dev-user",
] as const;

function strippedSetCookies(headers: Headers): string[] {
  const setCookies = headers.getSetCookie?.();
  const values = setCookies && setCookies.length > 0
    ? setCookies
    : headers.get("set-cookie")
      ? [headers.get("set-cookie") as string]
      : [];
  return values.map((cookie) => cookie.replace(/;\s*Domain=[^;]+;?/gi, ";"));
}

function parentCookieDomain(hostname: string): string | undefined {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length < 2) return undefined;
  return `.${parts.slice(-2).join(".")}`;
}

function appendExpiredCookie(headers: Headers, name: string, domain?: string) {
  const attributes = name.startsWith("better-auth") || name.startsWith("__Secure-better-auth")
    ? "Max-Age=0; Path=/; HttpOnly; SameSite=Lax"
    : "Max-Age=0; Path=/; SameSite=Lax";
  const secure = name.startsWith("__Secure-") ? "; Secure" : "";
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  headers.append("Set-Cookie", `${name}=; ${attributes}${secure}${domainAttribute}`);
}

function appendAuthCookieCleanup(headers: Headers, hostname: string) {
  headers.set("Clear-Site-Data", '"cookies"');
  const parentDomain = parentCookieDomain(hostname);
  for (const name of AUTH_COOKIE_NAMES) {
    appendExpiredCookie(headers, name);
    if (parentDomain) appendExpiredCookie(headers, name, parentDomain);
  }
}

async function proxiedHeaders(request: Request, target: string, method = request.method): Promise<Headers> {
  const source = request.headers;
  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "origin", "sec-fetch-site", "user-agent"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  (await authClientIpHeaders(request, target, method)).forEach((value, name) => headers.set(name, value));
  return headers;
}

export async function proxyConvexRequest(request: Request): Promise<Response> {
  const sourceUrl = new URL(request.url);
  const target = `${CONVEX_SITE_URL}${sourceUrl.pathname}${sourceUrl.search}`;
  const requestHeaders = await proxiedHeaders(request, target);
  if (request.method === "GET" && API_KEY_GET_PATHS.has(sourceUrl.pathname)) {
    const authorization = request.headers.get("authorization");
    if (authorization) requestHeaders.set("authorization", authorization);
  }
  const init: RequestInit = {
    method: request.method,
    headers: requestHeaders,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    try { init.body = new TextDecoder().decode(await readBoundedBody(request)); }
    catch (error) {
      if (!(error instanceof BodyTooLargeError)) throw error;
      const response = error.response();
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
  }
  const upstream = await backendFetch(target, init, "proxyConvexRequest");
  const setCookies = strippedSetCookies(upstream.headers);

  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", apiCacheControl(request, upstream));
  headers.delete("set-cookie");
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function authErrorLocation(url: URL): string {
  const code = url.searchParams.get("error") || "unknown_error";
  return `/sign-in?error=${encodeURIComponent(code)}`;
}

export async function proxyAuthRequest(request: Request): Promise<Response> {
  const source = new URL(request.url);
  if (source.pathname.replace(/\/$/, "") === "/api/auth/error") {
    return new Response(null, { status: 302, headers: { Location: authErrorLocation(source) } });
  }

  const path = source.pathname.replace(/\/$/, "");
  if (path === "/api/auth/sign-out") return proxyAuthSignOut(request);
  const revokesSessions = (request.method === "POST" && SESSION_REVOCATION_PATHS.has(path))
    || path === "/api/auth/delete-user/callback";
  const invalidateCaller = async () => {
    if (revokesSessions) await sessionCache.evict(request.headers.get("cookie") ?? "");
  };
  await invalidateCaller();
  let upstream: Response;
  try {
    upstream = await proxyConvexRequest(request);
    // A successful mutation can target another token or all of a user's
    // sessions. Invalidate the isolate without retaining a raw-token index.
    // Rejected anonymous requests must not flush other users' cache entries.
    if (revokesSessions && upstream.status >= 200 && upstream.status < 400) sessionCache.clear();
  } finally {
    // Also remove caller lookups started during the mutation, on errors too.
    await invalidateCaller();
  }
  if (path === "/api/auth/get-session" && upstream.ok) {
    // Better Auth represents authoritative missing/revoked sessions as JSON null.
    const identity: unknown = await upstream.clone().json().catch(() => undefined);
    if (identity === null) await sessionCache.evict(request.headers.get("cookie") ?? "");
  }
  const location = upstream.headers.get("location");
  if (upstream.status >= 300 && upstream.status < 400 && location) {
    const target = new URL(location, `${CONVEX_SITE_URL}${source.pathname}`);
    const authOrigin = new URL(CONVEX_SITE_URL).origin;
    if ((target.origin === source.origin || target.origin === authOrigin)
      && target.pathname.replace(/\/$/, "") === "/api/auth/error") {
      const headers = new Headers(upstream.headers);
      headers.set("location", authErrorLocation(target));
      return new Response(upstream.body, { status: upstream.status, headers });
    }
  }
  return upstream;
}

export async function proxyAuthSignOut(request: Request): Promise<Response> {
  const cookie = request.headers.get("cookie") ?? "";
  const source = new URL(request.url);
  const json = request.headers.get("accept")?.includes("application/json");
  const reply = (state: "confirm" | "failed" | "complete", status: number, headers = new Headers()) => {
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Type", json ? "application/json" : "text/html; charset=utf-8");
    return new Response(json ? JSON.stringify(state === "complete" ? { success: true } : { error: "Sign-out was not completed. Please try again." })
      : renderSignOutPage(state), { status, headers });
  };
  await sessionCache.evict(cookie);
  try {
    // GET is safe to follow/prefetch; only the confirmation form can sign out.
    if (request.method !== "POST") {
      const headers = new Headers({ Allow: "POST" });
      return reply("confirm", request.method === "GET" ? 200 : 405, headers);
    }
    // Validate the browser's origin before setting the trusted upstream origin.
    // Never manufacture trust for a missing, opaque or cross-origin request.
    if (request.headers.get("origin") !== source.origin) return reply("failed", 403);
    const target = `${CONVEX_SITE_URL}/api/auth/sign-out`;
    const upstreamHeaders = await proxiedHeaders(request, target, "POST");
    upstreamHeaders.set("origin", source.origin);
    upstreamHeaders.set("content-type", "application/json");
    const upstream = await fetch(target, {
      method: "POST", headers: upstreamHeaders, body: "{}", redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (!upstream.ok) {
      logger.error({ category: "UpstreamError", operation: "proxyAuthSignOut", status: upstream.status }, "Auth sign-out proxy error");
      return reply("failed", 502);
    }
    const headers = new Headers();
    for (const cookie of strippedSetCookies(upstream.headers)) headers.append("Set-Cookie", cookie);
    // Cleanup is safe only after the server acknowledged revocation. On any
    // failure retain cookies so a retry can still identify and revoke the session.
    appendAuthCookieCleanup(headers, source.hostname);
    return reply("complete", 200, headers);
  } catch {
    logger.error({ category: "TransportError", operation: "proxyAuthSignOut", status: null }, "Auth sign-out proxy error");
    return reply("failed", 502);
  } finally {
    // Also evict lookups that began while sign-out was in flight, on every path.
    await sessionCache.evict(cookie);
  }
}
