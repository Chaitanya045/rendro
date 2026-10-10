import { logger } from "@/logger";

/** Never forward a backend's diagnostic response to a browser or CLI. */
export async function backendFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, init);
    if (response.status < 500) return response;
    logger.error({ status: response.status, body: await response.text() }, "Backend request failed");
  } catch (error) {
    logger.error({ err: error }, "Backend request failed");
  }
  return Response.json({ error: "Backend unavailable" }, { status: 502 });
}
