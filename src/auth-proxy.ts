import { CONVEX_SITE_URL } from "@/config";
import { logger } from "@/logger";

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

function proxiedHeaders(request: Request): Headers {
  const source = request.headers;
  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "origin", "user-agent"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function proxyConvexRequest(request: Request): Promise<Response> {
  const sourceUrl = new URL(request.url);
  const target = `${CONVEX_SITE_URL}${sourceUrl.pathname}${sourceUrl.search}`;
  const init: RequestInit = {
    method: request.method,
    headers: proxiedHeaders(request),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }
  const upstream = await fetch(target, init);
  const setCookies = strippedSetCookies(upstream.headers);
  if (setCookies.length === 0) return upstream;

  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie");
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export function proxyAuthRequest(request: Request): Promise<Response> {
  return proxyConvexRequest(request);
}

export async function proxyAuthSignOut(request: Request): Promise<Response> {
  const headers = new Headers({ Location: "/" });
  try {
    const upstream = await fetch(`${CONVEX_SITE_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: proxiedHeaders(request),
      redirect: "manual",
    });
    for (const cookie of strippedSetCookies(upstream.headers)) {
      headers.append("Set-Cookie", cookie);
    }
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Auth sign-out proxy error",
    );
  }
  appendAuthCookieCleanup(headers, new URL(request.url).hostname);
  return new Response(null, { status: 302, headers });
}
