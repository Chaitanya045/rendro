import { CONVEX_URL } from "@/config";

async function convexQuery(path: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args: [args] }),
  });
  const data = await res.json() as { status: string; value: unknown };
  return data.status === "success" ? data.value : null;
}

async function convexMutation(path: string, args: Record<string, unknown>): Promise<void> {
  await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args: [args] }),
  });
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
