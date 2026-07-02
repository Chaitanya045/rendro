import { z } from "zod/v4";
import { timingSafeEqual } from "node:crypto";

const envSchema = z.object({
  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // MinIO
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().default("docs"),
  MINIO_REGION: z.string().default("us-east-1"),
  MINIO_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BASE_URL: z.string().url().default("http://localhost:3000"),
  CONVEX_URL: z.string().default(""),
  // Auth DB secret (dev only — prod should use a real secret)
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),

  // Sync token for CLI auth
  SYNC_TOKEN: z.string().default("dev-sync-token"),
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

export const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
export const NODE_ENV = env.NODE_ENV;

export const MINIO_ENDPOINT = env.MINIO_ENDPOINT;
export const MINIO_ACCESS_KEY = env.MINIO_ACCESS_KEY;
export const MINIO_SECRET_KEY = env.MINIO_SECRET_KEY;
export const MINIO_BUCKET = env.MINIO_BUCKET;
export const MINIO_REGION = env.MINIO_REGION;
export const MINIO_FORCE_PATH_STYLE = env.MINIO_FORCE_PATH_STYLE;

export const PORT = env.PORT;
export const BASE_URL = env.BASE_URL;
export const CONVEX_URL = env.CONVEX_URL;

export const AUTH_SECRET = env.AUTH_SECRET;

const SYNC_TOKEN_BUF = new TextEncoder().encode(env.SYNC_TOKEN);

export function verifySyncToken(token: string): boolean {
  const a = new TextEncoder().encode(token);
  if (a.length !== SYNC_TOKEN_BUF.length) return false;
  try {
    return timingSafeEqual(a, SYNC_TOKEN_BUF);
  } catch {
    return false;
  }
}
