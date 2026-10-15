import { convexMutationRequired, convexQueryRequired } from "@/convex-internal";
import { ViewerBackendError } from "./viewer-backend";

export async function markDeleted(orgSlug: string, fileKey: string): Promise<void> {
  const result = await convexMutationRequired("deletedFiles:mark", { orgSlug, fileKey });
  if (result !== null) throw new ViewerBackendError();
}

export async function isDeleted(fileKey: string): Promise<boolean> {
  const result = await convexQueryRequired("deletedFiles:isDeleted", { fileKey });
  if (typeof result !== "boolean") throw new ViewerBackendError();
  return result;
}

export async function filterDeleted(keys: string[]): Promise<string[]> {
  const visible: string[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    const batch = keys.slice(offset, offset + 100);
    const result = await convexQueryRequired("deletedFiles:filterFn", { keys: batch });
    if (!Array.isArray(result) || result.some(key => typeof key !== "string" || !batch.includes(key))
      || new Set(result).size !== result.length) throw new ViewerBackendError();
    visible.push(...result as string[]);
  }
  return visible;
}
