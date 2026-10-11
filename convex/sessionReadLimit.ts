import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { AUTH_CLIENT_IP_HEADER } from "../shared/auth-client-ip";

/** HTTP session reads only: internal authorization still reads persisted sessions. */
export function sessionReadLimit(consume: (key: string) => Promise<number>): BetterAuthPlugin {
  return {
    id: "rendro-session-read-limit",
    hooks: { before: [{
      matcher: (ctx) => ctx.path === "/get-session" && !!ctx.request,
      handler: createAuthMiddleware(async (ctx) => {
        const ip = ctx.headers?.get(AUTH_CLIENT_IP_HEADER) ?? "no-trusted-ip";
        async function enforce(key: string) {
          const retryAfter = await consume(key);
          if (retryAfter) throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many session reads",
          }, { "Retry-After": String(retryAfter) });
        }
        // Bound even invalid signed-cookie probes before hitting the session store.
        await enforce(`session-read-ip:${ip}`);
        // Only the configured session-token cookie is eligible. OAuth state uses
        // the same HMAC secret, so a signature alone is not proof of a session.
        const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
        const persisted = token ? await ctx.context.internalAdapter.findSession(token) : null;
        let key: string;
        if (token && persisted && persisted.session.expiresAt.getTime() > Date.now()) {
          // Hash the decoded token, keeping the bucket stable across encodings
          // and IP changes without storing raw credentials in limiter keys.
          const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
          key = `session-read:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("")}`;
        } else {
          key = `session-read-unverified:${ip}`;
        }
        await enforce(key);
      }),
    }] },
  };
}
