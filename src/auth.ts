import { betterAuth } from "better-auth";
import { memoryAdapter } from "@better-auth/memory-adapter";
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

export async function getAuth() {
  if (instance) return instance;

  instance = betterAuth({
    appName: "rendro",
    baseURL: BASE_URL,
    database: memoryAdapter({}),
    secret: process.env.AUTH_SECRET || "rendro-dev-secret-32chars!!",
    socialProviders: {
      google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
    },
    trustedOrigins: [BASE_URL],
    advanced: {},
  }) as unknown as AuthInstance;

  logger.info({ baseURL: BASE_URL }, "better-auth initialized (memory)");
  return instance;
}

export let auth: AuthInstance | null = null;
getAuth().then(a => { auth = a; });

export type { AuthInstance };
