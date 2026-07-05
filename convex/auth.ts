import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import type { BetterAuthOptions } from "better-auth/minimal";

export const authComponent = createClient<DataModel>(components.betterAuth);

export function createAuthOptions(ctx: GenericCtx<DataModel>) {
  return {
    appName: "rendro",
    // Use rendro.app as baseURL so callbacks/redirects point to the Workers proxy,
    // which forwards to Convex internally.
    baseURL: process.env.SITE_URL!,
    trustedOrigins: [process.env.SITE_URL!],
    database: authComponent.adapter(ctx),
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
    },
  } satisfies BetterAuthOptions;
}

import { query } from "./_generated/server";
import { v } from "convex/values";

// Lightweight session lookup for Workers proxy
export const verifySession = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "session",
      where: [{ field: "token", value: args.token }],
    });
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) return null;
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: session.userId }],
    });
    return user ?? null;
  },
});
