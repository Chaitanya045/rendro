import { convexMutation, convexQuery, convexQueryRequired } from "@/convex-internal";

export async function markDeleted(orgSlug: string, fileKey: string): Promise<void> {
  await convexMutation("deletedFiles:mark", { orgSlug, fileKey });
}

export async function isDeleted(fileKey: string, requireBackend = false): Promise<boolean> {
  const result = await (requireBackend ? convexQueryRequired : convexQuery)("deletedFiles:isDeleted", { fileKey });
  if (requireBackend && typeof result !== "boolean") throw new Error("Invalid deletion response");
  return result === true;
}

export async function unmarkDeleted(fileKey: string): Promise<void> {
  await convexMutation("deletedFiles:unmark", { fileKey });
}

export async function filterDeleted(keys: string[]): Promise<string[]> {
  const result = await convexQuery("deletedFiles:filterFn", { keys });
  return (result as string[]) ?? keys;
}
