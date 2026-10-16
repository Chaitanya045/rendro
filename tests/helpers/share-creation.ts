import { vi } from "vitest";
import { registerAuthClientIp } from "../../src/auth-client-ip";
import { Hono } from "hono";
import shareApi from "../../src/routes/share-api";
import * as storage from "../../src/minio";
import { cookieWriteFixture, admissionHeaders } from "./cookie-write-fixture";

const path = "/api/rendro/shares";
export async function shareCreationFixture() {
  const f = await cookieWriteFixture();
  const deployment = (await f.backend.run(ctx => ctx.db.get(f.projectId)))!.activeDeploymentId!;
  const record = (await f.backend.run(ctx => ctx.db.get(deployment)))!;
  const body = { organizationId: f.organizationId, projectId: f.projectId, documentPath: "guide/index.html", expiresInSeconds: 600 };
  const files = [
    { path: "guide/index.html", contentType: "text/html", body: '<link rel="stylesheet" href="style.css"><img src="image"><script src="script"></script>' },
    { path: "guide/style.css", contentType: "text/css", body: '@font-face{src:url(font)}p{background:url(image)}' },
    { path: "guide/image", contentType: "image/png", body: "image" },
    { path: "guide/font", contentType: "font/woff2", body: "font" },
    { path: "guide/script", contentType: "application/javascript", body: "script" },
    { path: "guide/private.json", contentType: "application/json", body: "private" },
  ];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    return f.backend.fetch(parsed.pathname + parsed.search, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  const manifest = vi.spyOn(storage, "getObjectText").mockResolvedValue(JSON.stringify({ files }));
  const read = vi.spyOn(storage, "getObjectStream").mockImplementation(key => {
    const file = files.find(file => key === record.manifestKey.replace("manifest.json", "files/" + file.path));
    return Promise.resolve(file ? new Response(file.body).body : null);
  });
  const app = new Hono().route("/", shareApi);
  app.onError(() => new Response("Unavailable", { status: 500 }));
  const request = (input: unknown = body, headers = admissionHeaders({ cookie: f.cookie })) => {
    const request = new Request("http://localhost:3000" + path, { method: "POST", headers, body: JSON.stringify(input) });
    registerAuthClientIp(request, "192.0.2.1");
    return app.request(request);
  };
  return { ...f, body, record, fetchMock, manifest, read, app, request };
}
