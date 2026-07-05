import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { CONVEX_URL } from "@/config";

let convex: ConvexClient | null = null;
function getConvex(): ConvexClient {
  if (!convex) convex = new ConvexClient(CONVEX_URL);
  return convex;
}

export async function markDeleted(orgSlug: string, fileKey: string): Promise<void> {
  await getConvex().mutation(api.deletedFiles.mark, { orgSlug, fileKey });
}

export async function isDeleted(fileKey: string): Promise<boolean> {
  return await getConvex().query(api.deletedFiles.isDeleted, { fileKey });
}

export async function unmarkDeleted(fileKey: string): Promise<void> {
  await getConvex().mutation(api.deletedFiles.unmark, { fileKey });
}

export async function filterDeleted(keys: string[]): Promise<string[]> {
  return await getConvex().query(api.deletedFiles.filterFn, { keys });
}
