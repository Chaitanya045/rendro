import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL, NODE_ENV } from "@/config";
import { logger } from "@/logger";

export const auth = betterAuth({
  appName: "rendro",
  baseURL: BASE_URL,
  database: new Database("docsync-auth.db") as never,
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

logger.info({ baseURL: BASE_URL }, "better-auth initialized");
