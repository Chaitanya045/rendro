import { randomBytes, createHash } from "node:crypto";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { CONVEX_URL } from "@/config";
import { logger } from "@/logger";

const convex = new ConvexClient(CONVEX_URL);

export function generateApiKey(): { raw: string; hash: string } {
  const raw = `rendro_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export async function createOrgApiKey(orgSlug: string): Promise<string> {
  const { raw, hash } = generateApiKey();
  await convex.mutation(api.apiKeys.create, { orgSlug, keyHash: hash });
  logger.info({ orgSlug }, "API key created");
  return raw;
}

export async function validateApiKey(key: string): Promise<string | null> {
  const hash = createHash("sha256").update(key).digest("hex");
  return await convex.query(api.apiKeys.validate, { keyHash: hash });
}
