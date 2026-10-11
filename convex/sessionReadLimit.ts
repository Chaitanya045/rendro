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
        // Better Auth verifies the cookie's HMAC with AUTH_SECRET. Hash the
        // decoded token (not its encoding/signature) so alternate encodings or
        // IP changes cannot create extra buckets. Never accept a caller's key.
        const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
        let key: string;
        if (token) {
          const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
          key = `session-read:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("")}`;
        } else {
          key = `session-read-unverified:${ctx.headers?.get(AUTH_CLIENT_IP_HEADER) ?? "no-trusted-ip"}`;
        }
        const retryAfter = await consume(key);
        if (retryAfter) throw new APIError("TOO_MANY_REQUESTS", {
          message: "Too many session reads",
        }, { "Retry-After": String(retryAfter) });
      }),
    }] },
  };
}
