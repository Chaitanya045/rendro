import { createHash } from "node:crypto";
import { createServer, type RequestListener } from "node:http";

export const publicationSlug = "workerd-smoke";
const prefix = "tenants/e2e-org/projects/e2e-project/deployments/e2e-release/";
const html = '<!doctype html><html><head><title>Worker publication</title></head><body><h1>Publication from local storage</h1><img src="diagram.svg" alt="Local diagram"><script>document.body.dataset.publisherReady="yes"</script></body></html>';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><title>Local diagram</title><rect width="80" height="40" fill="green"/></svg>';
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const manifest = JSON.stringify({
  version: 1,
  files: [
    { path: "index.html", contentType: "text/html", size: Buffer.byteLength(html), sha256: digest(html) },
    { path: "diagram.svg", contentType: "image/svg+xml", size: Buffer.byteLength(svg), sha256: digest(svg) },
    // Manifest entry with no object exercises the real AWS SDK's S3 404 path.
    { path: "deleted.svg", contentType: "image/svg+xml", size: 0, sha256: digest("") },
  ],
});
const objects = new Map([
  [`/docs/${prefix}manifest.json`, { body: manifest, type: "application/json" }],
  [`/docs/${prefix}files/index.html`, { body: html, type: "text/html" }],
  [`/docs/${prefix}files/diagram.svg`, { body: svg, type: "image/svg+xml" }],
]);

export async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

/** Temporary read-only HTTP fixtures. #109 replaces these with real backends. */
export function startConvexStub() {
  return listen((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && url.pathname === "/api/rendro/publications/public") {
      if (url.searchParams.get("slug") !== publicationSlug) {
        response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
        return;
      }
      response.end(JSON.stringify({
        publication: { slug: publicationSlug, pathPrefix: "", entryFile: "index.html", title: "Worker publication" },
        project: { name: "Worker publication", slug: "e2e-project" },
        deployment: { manifestKey: `${prefix}manifest.json`, manifestSha256: digest(manifest) },
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/get-session") {
      response.end("null");
      return;
    }
    // Do not invent successful responses for backend contracts we have not seeded.
    response.writeHead(501).end(JSON.stringify({ error: "Unimplemented E2E Convex endpoint" }));
  });
}

/** S3 GET/HEAD wire protocol, including XML errors; the real Worker SDK does the reads. */
export function startStorageStub(accessKey: string) {
  return listen((request, response) => {
    if (!["GET", "HEAD"].includes(request.method ?? "")
      || !request.headers.authorization?.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKey}/`)) {
      response.writeHead(403, { "Content-Type": "application/xml" }).end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    const object = objects.get(path);
    if (!object) {
      response.writeHead(404, { "Content-Type": "application/xml" }).end("<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>");
      return;
    }
    response.writeHead(200, {
      "Content-Type": object.type,
      "Content-Length": Buffer.byteLength(object.body),
      ETag: `"${digest(object.body)}"`,
    });
    response.end(request.method === "HEAD" ? undefined : object.body);
  });
}
