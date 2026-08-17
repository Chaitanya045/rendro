import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import type { BetterAuthOptions } from "better-auth/minimal";

export const authComponent = createClient<DataModel>(components.betterAuth);
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createAuthOptions(ctx: GenericCtx<DataModel>) {
  const siteUrl = requiredEnv("SITE_URL");
  return {
    appName: "rendro",
    // Use rendro.app as baseURL so callbacks/redirects point to the Workers proxy,
    // which forwards to Convex internally.
    baseURL: siteUrl,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    socialProviders: {
      google: {
        clientId: requiredEnv("GOOGLE_CLIENT_ID"),
        clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
      },
    },
  } satisfies BetterAuthOptions;
}
