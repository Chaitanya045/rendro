import { betterAuth } from "better-auth";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL, NODE_ENV } from "@/config";
import { logger } from "@/logger";

export const auth = betterAuth({
  appName: "rendro",
  baseURL: BASE_URL,
  database: memoryAdapter({}),
  secret: BASE_URL + "-dev-secret-change-in-prod",
  socialProviders: {
    google: {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    },
  },
  trustedOrigins: [BASE_URL],
  advanced: NODE_ENV === "development"
    ? { cookiePrefix: "rendro" }
    : {},
});

logger.info({ baseURL: BASE_URL }, "better-auth initialized (memory adapter)");
