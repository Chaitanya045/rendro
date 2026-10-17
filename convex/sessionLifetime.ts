import type { BetterAuthPlugin, DBAdapter, DBTransactionAdapter } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { splitSetCookieHeader } from "better-auth/cookies";
import { makeSignature } from "better-auth/crypto";
import { parseCookies } from "better-call";
import { authCookiePrefix, LEGACY_AUTH_COOKIE_PREFIX } from "../shared/auth-cookies";
import { sessionExpiryMs } from "./sessionReadLimit";

const day = 86_400_000;
type LifetimeSession = { rememberMe?: boolean | null; createdAt: unknown; expiresAt: unknown };

// Legacy sessions have no choice recorded. Preserve their existing lifetime,
// including records already extended before this fix; never trust a cookie.
function remembered(session: LifetimeSession): boolean {
  return session.rememberMe ?? sessionExpiryMs(session.expiresAt) - sessionExpiryMs(session.createdAt) > day;
}

// Latest expiry a stored session may have. Missing or invalid creation times
// bound non-remembered sessions to the epoch, so they fail closed as expired.
function expiryBound(session: LifetimeSession): number {
  return remembered(session) ? Infinity : sessionExpiryMs(session.createdAt) + day;
}

const clamp = (expiresAt: unknown, bound: number) => sessionExpiryMs(expiresAt) > bound ? new Date(bound) : expiresAt;
const lifetimeInputs = ["createdAt", "rememberMe"];
const writesLifetime = (model: string, fields: object) => model === "session" && Object.keys(fields).some(field => field === "expiresAt" || lifetimeInputs.includes(field));

/**
 * Authoritative storage bound: every session write through Better Auth's adapter,
 * including transactions, keeps a non-remembered session within one day of its
 * creation, whatever headers, cookies or server call produced the write. The
 * inputs to that bound are immutable after creation.
 */
export function boundSessionLifetime<A extends DBAdapter | DBTransactionAdapter>(adapter: A): A {
  const bounded: DBTransactionAdapter = {
    ...adapter,
    create: data => adapter.create(data.model === "session" && data.data.rememberMe === false
      ? { ...data, data: { ...data.data, expiresAt: clamp(data.data.expiresAt, sessionExpiryMs(data.data.createdAt) + day) } }
      : data),
    update: async data => {
      if (!writesLifetime(data.model, data.update)) return adapter.update(data);
      if (lifetimeInputs.some(field => field in data.update)) throw new Error("Session lifetime choice is immutable");
      const current = await adapter.findOne<LifetimeSession>({ model: "session", where: data.where });
      return adapter.update(current ? { ...data, update: { ...data.update, expiresAt: clamp(data.update.expiresAt, expiryBound(current)) } } : data);
    },
    // Better Auth extends sessions one record at a time; bulk or counter writes
    // to lifetime fields cannot be bounded per record, so they are refused.
    updateMany: data => writesLifetime(data.model, data.update) ? Promise.reject(new Error("Session lifetimes are updated per session")) : adapter.updateMany(data),
    incrementOne: data => writesLifetime(data.model, { ...data.increment, ...data.set }) ? Promise.reject(new Error("Session lifetimes are updated per session")) : adapter.incrementOne(data),
  };
  if (!("transaction" in adapter)) return bounded as A;
  // Adapters without transactions run the callback on themselves; keep handing
  // out this same bounded adapter so callers observe one adapter identity.
  const result: DBAdapter = { ...bounded, transaction: callback => adapter.transaction(trx => callback(trx === adapter ? result : boundSessionLifetime(trx))) };
  return result as A;
}

/**
 * Headers for server-side session reads. Sessions are cookie-only: a bearer
 * token is never a session. A request with Authorization opted into API-key
 * authority, so it never falls back to the browser's cookie session either.
 * Legacy cookie names (including those inside viewer tickets) are read under
 * the current names, exactly as the HTTP handler reads them.
 */
export function sessionCookieHeaders(headers: Headers): Headers {
  const cookie = headers.get("cookie");
  if (cookie === null || headers.has("authorization")) return new Headers();
  return new Headers({ cookie: promoteLegacyCookies(cookie, authCookiePrefix(process.env.SITE_URL)).header });
}

// Endpoints that never resolve the caller's session, refresh it, or write its
// cookie. Every other endpoint, including future ones, gets the lifetime hook.
export const sessionlessAuthPaths: ReadonlySet<string | undefined> = new Set([
  "/ok", "/error", "/sign-out", "/convex/jwks", "/convex/.well-known/openid-configuration",
]);

const baseName = (name: string) => name.replace(/^__(?:secure|host)-/i, "").toLowerCase();
// Escape everything better-call could trim, unquote, split on, or decode, so a
// rebuilt pair parses back to exactly the value Better Auth would have read.
const cookieValue = (value: string) => value.replace(/[\p{Cc}\s%;"]/gu, encodeURIComponent);

/**
 * Rebuild a Cookie header from Better Auth's own parse (better-call: trimmed
 * names, first duplicate wins, quoted and pair-less segments). Every variant of
 * `name` is dropped and the server-derived marker, if any, is placed first.
 */
export function withLifetimeMarker(header: string, name: string, marker?: string): string {
  const pairs = marker === undefined ? [] : [`${name}=${cookieValue(marker)}`];
  for (const [key, value] of parseCookies(header)) {
    if (baseName(key) !== baseName(name)) pairs.push(`${key}=${cookieValue(value)}`);
  }
  return pairs.join("; ");
}

export interface LegacyCookies {
  /** Legacy pairs renamed to the current name because no current cookie was sent. */
  promoted: string[];
  /** Legacy pairs dropped because the current cookie was also sent and wins. */
  shadowed: string[];
}

/**
 * Read `__Secure-better-auth.*` cookies under the current `prefix`. A current
 * cookie always wins over its legacy twin. Headers without legacy names are
 * returned unchanged; otherwise the header is rebuilt from better-call's parse.
 */
export function promoteLegacyCookies(header: string, prefix: string): LegacyCookies & { header: string } {
  const cookies = parseCookies(header);
  const legacy: LegacyCookies = { promoted: [], shadowed: [] };
  if (![...cookies.keys()].some(name => name.startsWith(LEGACY_AUTH_COOKIE_PREFIX))) return { header, ...legacy };
  const pairs: string[] = [];
  for (const [name, value] of cookies) {
    const current = name.startsWith(LEGACY_AUTH_COOKIE_PREFIX) ? `${prefix}.${name.slice(LEGACY_AUTH_COOKIE_PREFIX.length)}` : name;
    if (current !== name && cookies.has(current)) legacy.shadowed.push(name);
    else {
      if (current !== name) legacy.promoted.push(name);
      pairs.push(`${current}=${cookieValue(value)}`);
    }
  }
  return { header: pairs.join("; "), ...legacy };
}

// Internal request header from onRequest to the after hook. Callers cannot set
// it: onRequest replaces any value, and server API calls never carry it.
const legacyCookieHeader = "x-rendro-legacy-auth-cookies";
const legacySessionToken = `${LEGACY_AUTH_COOKIE_PREFIX}session_token`;

/**
 * Migrates pre-#89 `__Secure-better-auth.*` cookies to the current names.
 * Reads: every HTTP request is rewritten before routing, so all hooks and
 * endpoints see only current names. Writes: a successful GET that resolves a
 * live session from a promoted legacy token re-issues it under the current
 * name, with the lifetime the persisted session allows (#145: non-remembered
 * sessions stay browser-session cookies). Promoted legacy cookies are expired
 * only by such a read, or once the response sets or clears the current session
 * cookie, so a failed or writing request never signs anyone out. Shadowed
 * legacy cookies are always expired.
 */
export function legacyCookieMigration(): BetterAuthPlugin {
  return {
    id: "rendro-legacy-cookie-migration",
    onRequest: (request, context) => {
      const cookie = request.headers.get("cookie");
      const prefix = context.authCookies.sessionToken.name.slice(0, -".session_token".length);
      const migration = cookie === null ? undefined : promoteLegacyCookies(cookie, prefix);
      const migrates = migration !== undefined && migration.header !== cookie;
      if (!migrates && !request.headers.has(legacyCookieHeader)) return Promise.resolve(undefined);
      const headers = new Headers(request.headers);
      headers.delete(legacyCookieHeader);
      if (migrates) {
        headers.set("cookie", migration.header);
        headers.set(legacyCookieHeader, JSON.stringify({ promoted: migration.promoted, shadowed: migration.shadowed }));
      }
      return Promise.resolve({ request: new Request(request, { headers }) });
    },
    hooks: { after: [{
      matcher: ctx => ctx.headers?.has(legacyCookieHeader) === true,
      handler: createAuthMiddleware(async ctx => {
        // The matcher guarantees the record; only onRequest can have written it.
        const legacy = JSON.parse(ctx.headers?.get(legacyCookieHeader) as string) as LegacyCookies;
        const cookies = ctx.context.authCookies;
        // Convex's runtime may lack Headers#getSetCookie; split like Better Auth does.
        const sessionCookieWritten = splitSetCookieHeader(ctx.context.responseHeaders?.get("set-cookie") ?? "")
          .some(value => value.startsWith(`${cookies.sessionToken.name}=`));
        let expire = legacy.shadowed;
        if (sessionCookieWritten) expire = [...expire, ...legacy.promoted];
        else if (legacy.promoted.includes(legacySessionToken) && ctx.request?.method === "GET"
          && !isAPIError(ctx.context.returned) && !sessionlessAuthPaths.has(ctx.path)) {
          const token = await ctx.getSignedCookie(cookies.sessionToken.name, ctx.context.secret);
          const resolved = token ? await ctx.context.internalAdapter.findSession(token) : null;
          if (token && resolved && sessionExpiryMs(resolved.session.expiresAt) > Date.now()) {
            const rememberMe = remembered(resolved.session);
            await ctx.setSignedCookie(cookies.sessionToken.name, token, ctx.context.secret, {
              ...cookies.sessionToken.attributes, maxAge: rememberMe ? ctx.context.sessionConfig.expiresIn : undefined,
            });
            if (!rememberMe) await ctx.setSignedCookie(cookies.dontRememberToken.name, "true", ctx.context.secret, cookies.dontRememberToken.attributes);
          }
          // A legacy token without a live session can never authenticate again.
          expire = [...expire, ...legacy.promoted];
        }
        // Legacy cookies were set host-only by the Worker, which strips Domain.
        for (const name of expire) ctx.setCookie(name, "", { maxAge: 0, path: "/", secure: true, httpOnly: true, sameSite: "lax" });
      }),
    }] },
  };
}

export function sessionLifetime(): BetterAuthPlugin {
  return {
    id: "rendro-session-lifetime",
    init: () => ({ options: { databaseHooks: { session: { create: {
      before: (session, ctx) => {
        // Password rotation deletes the old record before creating its successor.
        // The authenticated context still holds the original server-side choice.
        const original = ctx?.path === "/change-password" ? ctx.context.session?.session : undefined;
        const rememberMe = remembered(original ?? session);
        return Promise.resolve({ data: { ...session, rememberMe,
          expiresAt: rememberMe ? session.expiresAt : new Date(sessionExpiryMs(session.createdAt) + day),
        } });
      },
    } } } } }),
    hooks: { before: [{
      matcher: ctx => !sessionlessAuthPaths.has(ctx.path),
      handler: createAuthMiddleware(async ctx => {
        const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
        if (!token) return;
        const adapter = ctx.context.internalAdapter;
        const resolved = await adapter.findSession(token);
        if (!resolved) return;
        // Request-local reuse composes with the read limiter and applies to both
        // HTTP and server API calls, including nested organization middleware.
        ctx.context.internalAdapter = {
          ...adapter,
          findSession: async candidate => candidate === token ? resolved : adapter.findSession(candidate),
        };
        const name = ctx.context.authCookies.dontRememberToken.name;
        const marker = remembered(resolved.session) ? undefined : `true.${await makeSignature("true", ctx.context.secret)}`;
        const headers = new Headers(ctx.headers);
        // Better Auth's refresh and cookie writers consume this internal marker.
        // It is derived solely from the persisted session, never client cookies.
        // A signed session token was read from this header, so it is present.
        headers.set("cookie", withLifetimeMarker(headers.get("cookie") as string, name, marker));
        return { context: { headers } };
      }),
    }] },
  };
}
