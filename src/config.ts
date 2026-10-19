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
  // Signs same-origin image proxy URLs (/img/<sig>/<url>) at ingest; dedicated, never reused.
  IMAGE_PROXY_SECRET: z.string().min(32, "IMAGE_PROXY_SECRET must be at least 32 characters"),
  // Signs repository capability cookies and asset tickets (#234). Its own secret: rotating it
  // only signs readers back in through the permission source.
  REPO_CAPABILITY_SECRET: z
    .string()
    .min(32, "REPO_CAPABILITY_SECRET must be at least 32 characters"),
  // Seals private-repository content in R2 (#263): per-repository AES-256-GCM keys are derived
  // from it. Dedicated, and the same value on the ingest Worker. During a rotation the previous
  // key stays as REPO_CONTENT_KEY_PREVIOUS until no content sealed under it remains.
  REPO_CONTENT_KEY: z.string().min(32, "REPO_CONTENT_KEY must be at least 32 characters"),
  REPO_CONTENT_KEY_PREVIOUS: z.string().min(32, "REPO_CONTENT_KEY_PREVIOUS must be at least 32 characters").optional(),
}).refine(
  (value) => ![value.AUTH_SECRET, value.CONVEX_INTERNAL_SECRET, value.RETENTION_SECRET, value.IMAGE_PROXY_SECRET].includes(value.REPO_CAPABILITY_SECRET),
  { path: ["REPO_CAPABILITY_SECRET"], message: "REPO_CAPABILITY_SECRET must not reuse another secret" },
).refine(
  (value) => ![value.AUTH_SECRET, value.CONVEX_INTERNAL_SECRET, value.RETENTION_SECRET, value.IMAGE_PROXY_SECRET, value.REPO_CAPABILITY_SECRET, value.REPO_CONTENT_KEY_PREVIOUS]
    .includes(value.REPO_CONTENT_KEY),
  { path: ["REPO_CONTENT_KEY"], message: "REPO_CONTENT_KEY must not reuse another secret" },
);

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
export const IMAGE_PROXY_SECRET = env.IMAGE_PROXY_SECRET;
export const REPO_CAPABILITY_SECRET = env.REPO_CAPABILITY_SECRET;
export const REPO_CONTENT_KEY = env.REPO_CONTENT_KEY;
export const REPO_CONTENT_KEY_PREVIOUS = env.REPO_CONTENT_KEY_PREVIOUS;
