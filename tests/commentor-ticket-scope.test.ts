import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import projectDocs from "@/routes/project-docs";
import * as blobs from "@/storage";
import { documentCommentScopeFromFrame } from "@/commentor/parent-host";

const manifestKey = "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json";
const manifest = JSON.stringify({ version: 1, files: [{ path: "reference/index.html", sha256: "a", size: 10, contentType: "text/html; charset=utf-8" }] });
const user = { id: "user-a", email: "owner@example.com", name: "Owner", emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() } as User;
const session = "better-auth.session_token=session-secret-value";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function app() {
  const hono = new Hono<{ Variables: { user?: User } }>();
  hono.use("*", async (c, next) => { c.set("user", user); await next(); });
  hono.route("/", projectDocs);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({ project: { name: "Product" }, deployment: { manifestKey } }))));
  vi.spyOn(blobs, "getObjectText").mockResolvedValue(manifest);
  vi.spyOn(blobs, "getObjectStream").mockImplementation(() => Promise.resolve(new Response("<!doctype html><body><h1>Docs</h1></body>").body));
  return hono;
}

describe("the comment widget in a ticketed frame", () => {
  it("is configured with the document's identity only: no ticket, no session, and its scope ignores a ticketed frame URL", async () => {
    const hono = app();
    const base = "/organizations/org-a/projects/project-a/docs";
    const canonical = await (await hono.request(`${base}/files/reference/index.html`, { headers: { Cookie: session } })).text();
    const ticket = /\/docs\/view\/([^/]+)\/files\//.exec(canonical)?.[1];
    expect(ticket).toBeTruthy();
    // The same document served under the ticket the shell renews to.
    const ticketed = await (await hono.request(`${base}/view/${ticket}/files/reference/index.html`)).text();
    for (const html of [canonical, ticketed]) {
      const config = JSON.parse(/window\.COMMENTOR=(\{.*?\});<\/script>/.exec(html)![1]) as Record<string, unknown>;
      expect(config).toEqual({ organizationId: "org-a", projectId: "project-a", documentPath: "reference/index.html", transport: "parent", canWrite: true });
      const script = /<script>window\.COMMENTOR=[\s\S]*?<\/script>/.exec(html)![0];
      expect(script).not.toContain(ticket!);
      expect(script).not.toContain("session-secret-value");
    }
    // The widget's scope comes from the canonical frame address; a ticketed address is not a scope at all.
    const scope = { organizationId: "org-a", projectId: "project-a" as never };
    expect(documentCommentScopeFromFrame(`https://rendro.test${base}/files/reference/index.html`, "https://rendro.test", scope))
      .toEqual({ ...scope, documentPath: "reference/index.html" });
    expect(documentCommentScopeFromFrame(`https://rendro.test${base}/view/${ticket}/files/reference/index.html`, "https://rendro.test", scope)).toBeNull();
  });
});
