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

  const options = isWorkers
    ? withCloudflare(
        {
          d1: { db: d1Binding as never },
          autoDetectIpAddress: false,
          geolocationTracking: false,
        },
        {
          appName: "rendro",
          baseURL: BASE_URL,
          secret: (typeof process !== "undefined" ? process.env.AUTH_SECRET : "") || "rendro-d1-32chars-fallback!!",
          socialProviders: {
            google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
          },
          trustedOrigins: [BASE_URL],
          advanced: {},
        },
      )
    : {
        appName: "rendro",
        baseURL: BASE_URL,
        database: (await import("@better-auth/memory-adapter")).memoryAdapter({}),
        secret: process.env.AUTH_SECRET || "rendro-dev-secret-change-in-production-32chars",
        socialProviders: {
          google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
        },
        trustedOrigins: [BASE_URL],
        advanced: {},
      };

  instance = betterAuth(options as any) as unknown as AuthInstance;
  logger.info({ baseURL: BASE_URL, db: isWorkers ? "d1/drizzle" : "memory" }, "better-auth initialized");
  return instance;
}

export let auth: AuthInstance | null = null;
if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
  getAuth().then(a => { auth = a; });
}

export type { AuthInstance };
