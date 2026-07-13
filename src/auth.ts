// Auth module: for Workers, auth is proxied to Convex. For local dev, uses memory adapter.

import { betterAuth } from "better-auth";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL, AUTH_SECRET } from "./config";
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
    // Workers: auth is proxied to Convex HTTP actions. getAuth() is not used directly.
    // The worker.ts handles /api/auth/* proxy. Return a stub.
    instance = {
      handler: () => Promise.resolve(new Response("Auth proxy — use /api/auth/*", { status: 404 })),
      api: { getSession: async () => null, signOut: async () => {} },
    };
    return instance;
  }

  // Local dev: memory adapter
  instance = betterAuth({
    appName: "rendro",
    baseURL: BASE_URL,
    database: memoryAdapter({}),
    secret: AUTH_SECRET,
    socialProviders: {
      google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
    },
    trustedOrigins: [BASE_URL],
    advanced: {},
  }) as unknown as AuthInstance;
  logger.info({ baseURL: BASE_URL }, "better-auth initialized (memory/dev)");
  return instance;
}

export let auth: AuthInstance | null = null;
if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
  getAuth().then(a => { auth = a; });
}
