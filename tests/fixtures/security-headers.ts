import { vi } from "vitest";
import * as orgs from "@/orgs";
import * as publications from "@/publications";
import * as minio from "@/minio";
import { managementAccessFixture } from "./management-access";

export const docsBase = "/organizations/org-a/projects/project-a/docs";
export const testUser = { id: "user-a", email: "viewer@example.com", name: "Viewer", emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
const manifestKey = "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json";
export const publisherHtml = '<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><h1>Publisher document</h1><p>Selectable comment text</p><script>window.publisherLoaded=true</script></body></html>';

/** Deterministic backend/storage boundaries; the actual HTTP routes and templates run. */
export function mockSecurityBackend() {
  const organization = { id: "org-a", name: "Test organization", slug: "test",
    members: [{ id: "member-a", userId: testUser.id, role: "owner", user: testUser }], invitations: [] };
  const access = managementAccessFixture(organization, testUser);
  vi.spyOn(orgs, "orgExists").mockResolvedValue(true);
  vi.spyOn(publications, "getPublication").mockResolvedValue({
    orgSlug: "example", slug: "product", sourcePrefix: "example/",
    title: "Product", entryFile: "index.html", createdAt: "2026-01-01", updatedAt: "2026-01-01",
  });
  vi.spyOn(publications, "listPublishedDocumentPaths").mockResolvedValue(["index.html"]);
  const files = [
    { path: "index.html", sha256: "a", size: 100, contentType: "text/html" },
    { path: "assets/site.css", sha256: "b", size: 20, contentType: "text/css" },
  ];
  vi.spyOn(minio, "headObject").mockImplementation(key => Promise.resolve({ contentType: key.endsWith(".css") ? "text/css" : "text/html" }));
  vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files }));
  vi.spyOn(minio, "getObjectStream").mockImplementation(key => Promise.resolve(new Response(key.endsWith(".css") ? "body{color:rgb(1,2,3)}" : publisherHtml).body));
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const accessResponse = access(url);
    if (accessResponse) return Promise.resolve(accessResponse);
    let result: unknown = {};
    if (url.pathname.endsWith("/get-session")) result = { user: testUser, session: { id: "session-a" } };
    else if (url.pathname.endsWith("/deployments/active")) result = { project: { name: "Test project" }, deployment: { manifestKey } };
    else if (url.pathname.endsWith("/publications/public")) result = { publication: { slug: "product", pathPrefix: "", entryFile: "index.html" }, project: { name: "Product" }, deployment: { manifestKey } };
    else if (url.pathname.endsWith("/shares/public")) result = { grant: { documentPath: "index.html", expiresAt: Date.now() + 60_000 }, project: { name: "Product" }, deployment: { manifestKey } };
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
