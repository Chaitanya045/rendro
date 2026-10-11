/** Public signing keys may be cached briefly; tokens, sessions and errors may not. */
export function cacheJwksResponse(request: Request, response: Response): Response {
  if (
    request.method !== "GET"
    || new URL(request.url).pathname !== "/api/auth/convex/jwks"
    || response.status !== 200
    || response.headers.has("set-cookie")
  ) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=300, must-revalidate");
  return new Response(response.body, { status: response.status, headers });
}
