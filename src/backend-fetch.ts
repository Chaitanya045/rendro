import { evictRejectedSession } from "@/session-cache";
import { logger } from "@/logger";

// Static caller names only: URLs, paths, and request data can contain secrets.
type BackendOperation = "proxyConvexRequest";

/** Never forward or log a backend's diagnostic response. */
export async function backendFetch(
  url: string,
  init: RequestInit | undefined,
  operation: BackendOperation,
): Promise<Response> {
  try {
    const response = await fetch(url, init);
    await evictRejectedSession(new Headers(init?.headers).get("cookie") ?? "", response.status);
    if (response.status < 500) return response;
    logger.error({ category: "UpstreamError", operation, status: response.status }, "Backend request failed");
  } catch {
    // No upstream HTTP status exists when fetch rejects. Do not inspect the
    // exception: even its message, stack, or custom fields may contain secrets.
    logger.error({ category: "TransportError", operation, status: null }, "Backend request failed");
  }
  return Response.json({ error: "Backend unavailable" }, { status: 502 });
}
