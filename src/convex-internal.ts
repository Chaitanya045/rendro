import { viewerBackendJson, ViewerBackendError } from "@/viewer-backend";
import { CONVEX_INTERNAL_SECRET, CONVEX_URL } from "@/config";
import { logger } from "@/logger";

// Legacy slug-tenancy helpers call internal-secret-guarded Convex functions
// through the public function API. Failures are logged and resolve to null.
const HAS_CONVEX = CONVEX_URL.length > 0;

async function callConvex(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  if (!HAS_CONVEX) return null;
  try {
    const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        args: [{ ...args, internalSecret: CONVEX_INTERNAL_SECRET }],
      }),
    });
    const data = await res.json() as { status: string; value: unknown };
    return data.status === "success" ? data.value : null;
  } catch (err) {
    logger.error({ err: String(err), path }, `convex ${kind} failed`);
    return null;
  }
}

export function convexQuery(path: string, args: Record<string, unknown>): Promise<unknown> {
  return callConvex("query", path, args);
}

export function convexMutation(path: string, args: Record<string, unknown>): Promise<unknown> {
  return callConvex("mutation", path, args);
}

/** Viewer authorization checks must fail closed without disguising an outage. */
export async function convexQueryRequired(path: string, args: Record<string, unknown>): Promise<unknown> {
  if (!HAS_CONVEX) throw new ViewerBackendError();
  const data = await viewerBackendJson<{ status: string; value: unknown }>(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args: [{ ...args, internalSecret: CONVEX_INTERNAL_SECRET }] }),
  });
  if (!data || data.status !== "success") throw new ViewerBackendError();
  return data.value;
}
