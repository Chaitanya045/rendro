import { viewerBackendJson, ViewerBackendError } from "@/viewer-backend";
import { CONVEX_INTERNAL_SECRET, CONVEX_URL } from "@/config";

async function callRequired(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  if (!CONVEX_URL || !CONVEX_INTERNAL_SECRET) throw new ViewerBackendError();
  const data = await viewerBackendJson<{ status: string; value: unknown }>(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args: [{ ...args, internalSecret: CONVEX_INTERNAL_SECRET }] }),
  });
  if (!data || data.status !== "success" || !Object.hasOwn(data, "value")) throw new ViewerBackendError();
  return data.value;
}

export function convexQueryRequired(path: string, args: Record<string, unknown>): Promise<unknown> {
  return callRequired("query", path, args);
}
export function convexMutationRequired(path: string, args: Record<string, unknown>): Promise<unknown> {
  return callRequired("mutation", path, args);
}
