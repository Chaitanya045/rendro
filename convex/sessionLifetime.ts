import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import { parseCookies } from "better-call";
import { sessionExpiryMs } from "./sessionReadLimit";

const day = 86_400_000;
type LifetimeSession = { rememberMe?: boolean | null; createdAt: unknown; expiresAt: unknown };

// Legacy sessions have no choice recorded. Preserve their existing lifetime,
// including records already extended before this fix; never trust a cookie.
function remembered(session: LifetimeSession): boolean {
  return session.rememberMe ?? sessionExpiryMs(session.expiresAt) - sessionExpiryMs(session.createdAt) > day;
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
