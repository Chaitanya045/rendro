import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { AUTH_CLIENT_IP_HEADER } from "../shared/auth-client-ip";

/** Convex returns epoch milliseconds; other adapters may return Dates/ISO strings. */
export function sessionExpiryMs(value: unknown): number {
  try {
    const ms = value instanceof Date ? value.getTime()
      : typeof value === "number" ? value
        : typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : 0;
  } catch {
    return 0;
  }
}

// Exact read-only endpoints. Invitation writes and all credential endpoints keep
// Better Auth's strict IP limits. Query parameters cannot split these buckets.
export const organizationReadPaths = [
  "/organization/get-full-organization",
  "/organization/list",
  "/organization/list-invitations",
] as const;

/** HTTP reads only: internal authorization still reads persisted sessions. */
export function sessionReadLimit(consume: (key: string) => Promise<number>): BetterAuthPlugin {
  return authReadLimit(consume, false);
}

export function organizationReadLimit(consume: (key: string) => Promise<number>): BetterAuthPlugin {
  return authReadLimit(consume, true);
}

function authReadLimit(consume: (key: string) => Promise<number>, organizationReads: boolean): BetterAuthPlugin {
  const prefix = organizationReads ? "organization-read" : "session-read";
  return {
    id: `rendro-${prefix}-limit`,
    hooks: { before: [{
      matcher: (ctx) => !!ctx.request && (organizationReads
        ? organizationReadPaths.some(path => path === ctx.path) && ctx.request.method === "GET"
        : ctx.path === "/get-session"),
      handler: createAuthMiddleware(async (ctx) => {
        const ip = ctx.headers?.get(AUTH_CLIENT_IP_HEADER) ?? "no-trusted-ip";
        async function enforce(key: string) {
          const retryAfter = await consume(key);
          if (retryAfter) throw new APIError("TOO_MANY_REQUESTS", {
            message: organizationReads ? "Too many organization reads" : "Too many session reads",
          }, { "Retry-After": String(retryAfter) });
        }
        // Bound even invalid signed-cookie probes before hitting the session store.
        await enforce(`${prefix}-ip:${ip}`);
        // Only the configured session-token cookie is eligible. OAuth state uses
        // the same HMAC secret, so a signature alone is not proof of a session.
        const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
        const adapter = ctx.context.internalAdapter;
        const persisted = token ? await adapter.findSession(token) : null;
        const expiresAt = sessionExpiryMs(persisted?.session.expiresAt);
        const resolved = persisted ? {
          ...persisted,
          session: { ...persisted.session, expiresAt: new Date(expiresAt) },
        } : null;
        // Better Auth clones context per endpoint dispatch, but its adapter is
        // shared. Replace that reference, never mutate the shared adapter. The
        // endpoint's unconditional findSession consumes this result (even null).
        // Other tokens still resolve normally; the next HTTP request reads anew.
        ctx.context.internalAdapter = {
          ...adapter,
          findSession: async (candidate) => candidate === token ? resolved : adapter.findSession(candidate),
        };
        let key: string;
        if (token && persisted && expiresAt > Date.now()) {
          // Session reads use the token; organization reads use the verified user
          // so opening fresh sessions cannot multiply the allowance. Hash both
          // to avoid storing credentials or identity in limiter keys.
          const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(organizationReads ? persisted.user.id : token));
          key = `${prefix}:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("")}`;
        } else {
          key = `${prefix}-unverified:${ip}`;
        }
        await enforce(key);
      }),
    }] },
  };
}
