import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL } from "./config";
import { logger } from "./logger";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface AuthInstance {
  handler: (req: Request) => Response | Promise<Response>;
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{ user: unknown } | null>;
    signOut: (opts: { headers: Headers }) => Promise<unknown>;
  };
}

let instance: AuthInstance | null = null;

export async function getAuth(env?: Record<string, unknown>) {
  if (instance) return instance;

  const d1Binding = env?.rendro_auth as unknown;
  const isWorkers = !!d1Binding;

  if (isWorkers) {
    const options = withCloudflare(
      { d1Native: d1Binding as never },
      {
        appName: "rendro",
        baseURL: BASE_URL,
        secret: (typeof process !== "undefined" ? process.env.AUTH_SECRET : "") || "rendro-fallback-secret-32chars!!",
        socialProviders: {
          google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
        },
        trustedOrigins: [BASE_URL],
        advanced: {},
      },
    );
    instance = betterAuth(options) as unknown as AuthInstance;
    logger.info({ baseURL: BASE_URL }, "better-auth initialized (D1)");
  } else {
    const { memoryAdapter } = await import("@better-auth/memory-adapter");
    instance = betterAuth({
      appName: "rendro",
      baseURL: BASE_URL,
      database: memoryAdapter({}),
      secret: process.env.AUTH_SECRET || "rendro-dev-secret-change-in-production-32chars",
      socialProviders: {
        google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
      },
      trustedOrigins: [BASE_URL],
      advanced: { cookiePrefix: "rendro" },
    }) as unknown as AuthInstance;
    logger.info({ baseURL: BASE_URL }, "better-auth initialized (memory)");
  }

  return instance;
}

export let auth: AuthInstance | null = null;
if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
  getAuth().then(a => { auth = a; });
}

export type { AuthInstance };
