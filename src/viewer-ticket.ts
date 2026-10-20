import { authCookiePair } from "../shared/auth-cookies";

/**
 * The site whose auth cookie names a Worker request reads: the configured
 * SITE_URL, else the request's own origin (as write admission does).
 */
export function cookieSite(requestUrl: string): string {
  return process.env.SITE_URL ?? new URL(requestUrl).origin;
}

function pairs(cookie: string, pattern: RegExp): string[] {
  return cookie.split(";").map(part => part.trim()).filter(part => pattern.test(part));
}

/** Session-token pairs under the one name Convex reads for `site`. */
export function sessionTokenCookie(site: string, cookie: string): string {
  return pairs(cookie, authCookiePair(site, "session_token")).join("; ");
}

export function viewerSessionCookie(site: string, cookie: string): string {
  const token = sessionTokenCookie(site, cookie);
  if (!token) return "";
  // Retain compatibility with existing tickets. Convex derives the lifetime
  // preference from the persisted session, regardless of this client marker.
  // Never forward session_data, unrelated cookies, or bearer API credentials.
  return [token, ...pairs(cookie, authCookiePair(site, "dont_remember"))].join("; ");
}
