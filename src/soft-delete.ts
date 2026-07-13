import { CONVEX_URL } from "@/config";
import { logger } from "@/logger";

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

async function convexMutation(path: string, args: Record<string, unknown>): Promise<void> {
  if (!HAS_CONVEX) return;
  try {
    await fetch(`${CONVEX_URL}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args: [args] }),
    });
  } catch (err) {
    logger.error({ err: String(err), path }, "convex mutation failed");
  }
}

export async function markDeleted(orgSlug: string, fileKey: string): Promise<void> {
  await convexMutation("deletedFiles:mark", { orgSlug, fileKey });
}

export async function isDeleted(fileKey: string): Promise<boolean> {
  const result = await convexQuery("deletedFiles:isDeleted", { fileKey });
  return result === true;
}

export async function unmarkDeleted(fileKey: string): Promise<void> {
  await convexMutation("deletedFiles:unmark", { fileKey });
}

export async function filterDeleted(keys: string[]): Promise<string[]> {
  const result = await convexQuery("deletedFiles:filterFn", { keys });
  return (result as string[]) ?? keys;
}
