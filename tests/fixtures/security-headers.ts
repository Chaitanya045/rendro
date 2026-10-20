import { sessionCache } from "@/middleware/session";
import { vi } from "vitest";
import { managementAccessFixture } from "./management-access";

/** A repository's docs (#234); unbound in tests, so its URLs answer with the styled 404. */
export const docsBase = "/r/acme/docs";
export const testUser = { id: "user-a", email: "viewer@example.com", name: "Viewer", emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
export const publisherHtml = '<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><h1>Publisher document</h1><p>Selectable comment text</p><script>window.publisherLoaded=true</script></body></html>';

/** Deterministic backend/storage boundaries; the actual HTTP routes and templates run. */
export function mockSecurityBackend() {
  sessionCache.clear();
  const organization = { id: "org-a", name: "Test organization", slug: "test",
    members: [{ id: "member-a", userId: testUser.id, role: "owner", user: testUser }], invitations: [] };
  const access = managementAccessFixture(organization, testUser);
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const accessResponse = access(url);
    if (accessResponse) return Promise.resolve(accessResponse);
    let result: unknown = {};
    if (url.pathname.endsWith("/get-session")) result = { user: testUser, session: { id: "session-a", expiresAt: Date.now() + 60_000 } };
    else if (url.pathname.endsWith("/organization/list")) result = [{ id: "org-a", name: "Test organization", slug: "test" }];
    else if (url.pathname.endsWith("/organization/get-full-organization")) result = organization;
    else if (url.pathname.endsWith("/organization/get-invitation") && url.searchParams.get("id") === "test") result = {
      id: "test", organizationId: organization.id, organizationName: organization.name,
      email: testUser.email, role: "member", status: "pending", expiresAt: Date.now() + 60_000,
    };
    else if (url.pathname.endsWith("/organization/list-invitations") || url.pathname.endsWith("/projects")) result = [];
    return Promise.resolve(Response.json(result));
  }));
}
