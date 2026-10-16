/** The only public API exception is a successful, cookie-free signing-key read. */
export function apiCacheControl(request: Request, response: Response): string {
  if (request.method === "GET"
    && new URL(request.url).pathname === "/api/auth/convex/jwks"
    && response.status === 200
    && !response.headers.has("set-cookie")) {
    return "public, max-age=300, must-revalidate";
  }
  return "private, no-store";
}
