import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import workerApp from "@/worker";
import deploymentRoutes from "@/routes/deployments";
import projectDocsRoutes from "@/routes/project-docs";
import publicRoutes from "@/routes/public-v2";
import * as minio from "@/minio";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fail-closed API and manifest boundaries", () => {
  it("does not expose unhandled exception messages or request paths", async () => {
    const response = await workerApp.request(
      "/unexpected-resource",
      undefined,
      { ASSETS: { fetch: () => { throw new Error("storage password leaked in stack"); } } },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("rejects a malformed public manifest before reading an object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      publication: { slug: "product", pathPrefix: "", entryFile: "index.html" },
      project: { name: "Product", slug: "product" },
      deployment: { manifestKey: "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json" },
    })));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ files: { path: "index.html" } }));
    const objectRead = vi.spyOn(minio, "getObjectStream");

    expect((await publicRoutes.request("/p/product/files/index.html")).status).toBe(404);
    expect(objectRead).not.toHaveBeenCalled();
  });

  it("rejects a malformed private manifest before reading an object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      project: { name: "Product" },
      deployment: { manifestKey: "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json" },
    })));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ files: [null] }));
    const objectRead = vi.spyOn(minio, "getObjectStream");
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", async (c, next) => {
      c.set("user", {
        id: "member",
        email: "member@example.test",
        name: "Member",
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await next();
    });
    app.route("/", projectDocsRoutes);

    expect((await app.request("/organizations/org-a/projects/project-a/docs/files/index.html")).status).toBe(404);
    expect(objectRead).not.toHaveBeenCalled();
  });

  it("rejects a declared upload size mismatch before buffering the request body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      deployment: {
        manifestKey: "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json",
      },
    })));
    vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({
      version: 1,
      files: [{
        path: "index.html",
        sha256: "a".repeat(64),
        size: 4,
        contentType: "text/html; charset=utf-8",
      }],
    }));
    const put = vi.spyOn(minio, "putObject");

    const response = await deploymentRoutes.request(
      "/api/rendro/deployments/deploy-a/files/index.html?organizationId=org-a&projectId=project-a",
      {
        method: "PUT",
        headers: { Authorization: "Bearer scoped", "Content-Length": "100" },
        body: "oversized",
      },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Uploaded file size does not match its manifest entry" });
    expect(put).not.toHaveBeenCalled();
  });
});
