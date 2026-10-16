import { apiCacheControl } from "../shared/http-cache";

/** Public signing keys may be cached briefly; tokens, sessions and errors may not. */
export function cacheJwksResponse(request: Request, response: Response): Response {
  const cacheControl = apiCacheControl(request, response);
  if (cacheControl === "private, no-store") return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { status: response.status, headers });
}
