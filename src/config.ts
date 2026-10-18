import { z } from "zod/v4";

const envSchema = z.object({
  // Logging
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

  // Convex (Google OAuth credentials belong only to Convex)
  CONVEX_URL: z.string().default(""),
  CONVEX_SITE_URL: z.string().url().optional(),
  CONVEX_INTERNAL_SECRET: z
    .string()
    .min(32, "CONVEX_INTERNAL_SECRET must be at least 32 characters"),
  // Signs legacy /share/:token links; independent of Convex Better Auth.
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  // Bearer for Convex's retention endpoints, used only by the scheduled purge. Optional so a
  // deployment without it still serves traffic; the purge then reports itself disabled.
  RETENTION_SECRET: z.string().min(32, "RETENTION_SECRET must be at least 32 characters").optional(),
});

type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const raw: Record<string, string | undefined> = { ...process.env };
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${errors}`);
  }
  return result.data;
}

const env = loadEnv();

export const NODE_ENV = env.NODE_ENV;
export const LOG_LEVEL = env.LOG_LEVEL ?? (NODE_ENV === "production" ? "info" : "debug");
export const CONVEX_URL = env.CONVEX_URL;
export const CONVEX_INTERNAL_SECRET = env.CONVEX_INTERNAL_SECRET;
export const CONVEX_SITE_URL = env.CONVEX_SITE_URL
  ?? (CONVEX_URL.startsWith("http://127.0.0.1:3210")
    ? CONVEX_URL.replace(/:3210$/, ":3211")
    : CONVEX_URL.replace(/\.cloud$/, ".site"));

export const AUTH_SECRET = env.AUTH_SECRET;
export const RETENTION_SECRET = env.RETENTION_SECRET;
