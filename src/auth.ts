// Auth module: in Workers, proxies to Convex. In local dev, uses memory adapter.

import { betterAuth } from "better-auth";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL, CONVEX_URL } from "./config";
import { logger } from "./logger";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface AuthInstance {
  handler: (req: Request) => Response | Promise<Response>;
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{ user: unknown } | null>;
    signOut: (opts: { headers: Headers }) => Promise<unknown>;
  };
}

let instance: AuthInstance | null = null;

export async function getAuth(): Promise<AuthInstance> {
  if (instance) return instance;

  const isWorkers = typeof process === "undefined" || process.env.NODE_ENV === "production";

  if (isWorkers) {
    // Workers: proxy to Convex HTTP actions
    instance = createProxyAuth();
    logger.info("better-auth proxy mode (Convex)");
    return instance;
  }

  // Local dev: memory adapter
  instance = betterAuth({
    appName: "rendro",
    baseURL: BASE_URL,
    database: memoryAdapter({}),
    secret: process.env.AUTH_SECRET || "rendro-dev-secret-change-in-production-32chars",
    socialProviders: {
      google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
    },
    trustedOrigins: [BASE_URL],
    advanced: {},
  }) as unknown as AuthInstance;
  logger.info({ baseURL: BASE_URL }, "better-auth initialized (memory/dev)");
  return instance;
}

function createProxyAuth(): AuthInstance {
  const convexSite = CONVEX_URL.replace(".cloud", ".site");
  return {
    handler: async (req: Request) => {
      const url = new URL(req.url);
      const target = `${convexSite}${url.pathname}${url.search}`;
      try {
        const res = await fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : undefined,
        });
        return res;
      } catch (err: unknown) {
        const e = err as Error;
        logger.error({ err: e.message }, "Auth proxy error");
        return new Response(JSON.stringify({ error: "Auth service unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    },
    api: {
      getSession: async (opts: { headers: Headers }) => {
        try {
          const res = await fetch(`${convexSite}/api/auth/get-session`, {
            method: "GET",
            headers: opts.headers,
          });
          if (!res.ok) return null;
          return res.json();
        } catch { return null; }
      },
      signOut: async () => {},
    },
  };
}

export let auth: AuthInstance | null = null;
getAuth().then(a => { auth = a; });
