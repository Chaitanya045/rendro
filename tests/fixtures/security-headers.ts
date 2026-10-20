import { sessionCache } from "@/middleware/session";
import { vi } from "vitest";

/** A repository's docs (#234); unbound in tests, so its URLs answer with the styled 404. */
export const docsBase = "/r/acme/docs";
export const testUser = { id: "user-a", email: "viewer@example.com", name: "Viewer", emailVerified: true, createdAt: new Date(), updatedAt: new Date() };

/** Deterministic backend/storage boundaries; the actual HTTP routes and templates run. */
export function mockSecurityBackend() {
  sessionCache.clear();
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const result = url.pathname.endsWith("/get-session") ? { user: testUser, session: { id: "session-a", expiresAt: Date.now() + 60_000 } } : {};
    return Promise.resolve(Response.json(result));
  }));
}
