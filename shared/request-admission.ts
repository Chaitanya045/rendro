/** Admission is separate from authentication: callers select the authority used. */
export class RequestAdmissionError extends Error {
  constructor(readonly status: 403 | 415, message: string) { super(message); }
}

export function requireCookieWrite(request: Request, siteUrl: string | undefined, json = true): void {
  let canonical: string | undefined;
  try {
    const url = new URL(siteUrl ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") canonical = url.origin;
  } catch { /* Missing/invalid configuration fails closed. */ }
  const origin = request.headers.get("origin");
  if (!canonical || origin !== canonical || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestAdmissionError(403, "Same-origin request required");
  }
  if (json && request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new RequestAdmissionError(415, "application/json required");
  }
}

export type HttpPolicy = "read" | "cookie-json" | "bearer" | "better-auth";
// Registration metadata lets the inventory test inspect the actual router.
export const httpActionPolicies = new WeakMap<object, HttpPolicy>();
