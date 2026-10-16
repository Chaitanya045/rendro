import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import { sessionExpiryMs } from "./sessionReadLimit";

const day = 86_400_000;
type LifetimeSession = { rememberMe?: boolean | null; createdAt: unknown; expiresAt: unknown };

// Legacy sessions have no choice recorded. Preserve their existing lifetime,
// including records already extended before this fix; never trust a cookie.
function remembered(session: LifetimeSession): boolean {
  return session.rememberMe ?? sessionExpiryMs(session.expiresAt) - sessionExpiryMs(session.createdAt) > day;
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
      matcher: () => true,
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
        const headers = new Headers(ctx.headers);
        // A signed session token was read from this header, so it is present.
        const cookies = (headers.get("cookie") as string).split(";")
          .map(part => part.trim()).filter(part => part && part.split("=", 1)[0] !== name);
        if (!remembered(resolved.session)) {
          cookies.push(`${name}=${encodeURIComponent(`true.${await makeSignature("true", ctx.context.secret)}`)}`);
        }
        // Better Auth's refresh and cookie writers consume this internal header.
        // It is derived solely from the persisted session, never client markers.
        headers.set("cookie", cookies.join("; "));
        return { context: { headers } };
      }),
    }] },
  };
}
