import { randomBytes, createHash } from "node:crypto";
import { CONVEX_URL } from "@/config";
import { logger } from "@/logger";

export function generateApiKey(): { raw: string; hash: string } {
  const raw = `rendro_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

const HAS_CONVEX = CONVEX_URL.length > 0;

async function convexQuery(path: string, args: Record<string, unknown>): Promise<unknown> {
  if (!HAS_CONVEX) return null;
  try {
    const res = await fetch(`${CONVEX_URL}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args: [args] }),
    });
    const data = await res.json() as { status: string; value: unknown };
    return data.status === "success" ? data.value : null;
  } catch (err) {
    logger.error({ err: String(err), path }, "convex query failed");
    return null;
  }
}

async function convexMutation(path: string, args: Record<string, unknown>): Promise<unknown> {
  if (!HAS_CONVEX) return null;
  try {
    const res = await fetch(`${CONVEX_URL}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args: [args] }),
    });
    const data = await res.json() as { status: string; value: unknown };
    return data.status === "success" ? data.value : null;
  } catch (err) {
    logger.error({ err: String(err), path }, "convex mutation failed");
    return null;
  }
}

export async function createOrgApiKey(orgSlug: string): Promise<string> {
  const { raw, hash } = generateApiKey();
  await convexMutation("apiKeys:create", { orgSlug, keyHash: hash });
  logger.info({ orgSlug }, "API key created");
  return raw;
}

export async function validateApiKey(key: string): Promise<string | null> {
  const hash = createHash("sha256").update(key).digest("hex");
  const result = await convexQuery("apiKeys:validate", { keyHash: hash });
  return result as string | null;
}
