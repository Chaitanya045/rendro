import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { CONVEX_URL } from "@/config";

const convex = new ConvexClient(CONVEX_URL);

export async function markDeleted(orgSlug: string, fileKey: string): Promise<void> {
  await convex.mutation(api.deletedFiles.mark, { orgSlug, fileKey });
}

export async function isDeleted(fileKey: string): Promise<boolean> {
  return await convex.query(api.deletedFiles.isDeleted, { fileKey });
}

export async function unmarkDeleted(fileKey: string): Promise<void> {
  await convex.mutation(api.deletedFiles.unmark, { fileKey });
}

export async function filterDeleted(keys: string[]): Promise<string[]> {
  return await convex.query(api.deletedFiles.filterFn, { keys });
}
