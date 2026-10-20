// Better Auth cookie names, shared by the Convex auth server and the Worker.
//
// HTTPS sites use host-only `__Host-better-auth.*` cookies: Secure, Path=/ and
// no Domain, so no sibling subdomain can set or shadow them. Local HTTP keeps
// the unprefixed `better-auth.*` names, which browsers accept without TLS.
// `__Secure-better-auth.*` are the retired pre-#89 HTTPS names (#208): nothing
// reads them as a session any more, and sign-out only expires them.

const base = "better-auth";

/** Better Auth `advanced.cookiePrefix` for a site origin (without the trailing dot). */
export function authCookiePrefix(siteUrl: string | undefined): string {
  return siteUrl !== undefined && new URL(siteUrl).protocol === "https:" ? `__Host-${base}` : base;
}

/** Every cookie Better Auth or its Convex plugin can set, without prefix. */
export const AUTH_COOKIE_SUFFIXES = [
  "session_token", "session_data", "session_data.0", "session_data.1", "dont_remember",
  "account_data", "state", "oauth_state", "convex_jwt",
] as const;

/** Each auth cookie under every prefix a browser may still hold: current, retired and local. */
export const AUTH_COOKIE_NAMES: readonly string[] = ["__Host-", "__Secure-", ""]
  .flatMap(prefix => AUTH_COOKIE_SUFFIXES.map(suffix => `${prefix}${base}.${suffix}`));

/**
 * `name=value` cookie pair for `suffix` under the one prefix the site reads:
 * `__Host-` on HTTPS, none on local HTTP. Every other variant, including one a
 * sibling subdomain can set, is never a session (#208).
 */
export function authCookiePair(siteUrl: string | undefined, suffix: "session_token" | "dont_remember"): RegExp {
  return new RegExp(`^${authCookiePrefix(siteUrl)}\\.${suffix}=.+$`);
}
