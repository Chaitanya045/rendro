import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent } from "./auth";
import { betterAuth } from "better-auth/minimal";
import { convex } from "@convex-dev/better-auth/plugins";
import authConfig from "./auth.config";

const http = httpRouter();

// Catch-all for GET and POST under /api/auth/
http.route({
  pathPrefix: "/api/auth/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const auth = betterAuth({
      appName: "rendro",
      baseURL: process.env.SITE_URL!,
      trustedOrigins: [process.env.SITE_URL!],
      database: authComponent.adapter(ctx),
      socialProviders: {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      },
      plugins: [convex({ authConfig })],
    });
    return auth.handler(request);
  }),
});

http.route({
  pathPrefix: "/api/auth/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = betterAuth({
      appName: "rendro",
      baseURL: process.env.SITE_URL!,
      trustedOrigins: [process.env.SITE_URL!],
      database: authComponent.adapter(ctx),
      socialProviders: {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      },
      plugins: [convex({ authConfig })],
    });
    return auth.handler(request);
  }),
});

export default http;
