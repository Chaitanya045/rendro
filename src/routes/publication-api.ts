import { Hono } from "hono";
import { CONVEX_SITE_URL } from "@/config";
import { getObjectText } from "@/minio";

const app = new Hono();

type Manifest = { files: Array<{ path: string; contentType: string }> };
type Deployment = { _id: string; manifestKey: string; status: string };

function cleanPath(value: string, allowEmpty: boolean): string | null {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) return allowEmpty ? "" : null;
  return path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") ? null : path;
}

function parseManifest(value: string | null): Manifest | null {
  if (!value) return null;
  try { return JSON.parse(value) as Manifest; } catch { return null; }
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
  for (const name of ["authorization", "cookie", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function backend(path: string, request: Request, method = "GET", body?: string): Promise<Response> {
  return fetch(`${CONVEX_SITE_URL}${path}`, {
    method,
    body,
    headers: forwardedHeaders(request),
    redirect: "manual",
  });
}

app.post("/api/rendro/publications", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "Invalid publication body" }, 400);
  const organizationId = "organizationId" in body ? body.organizationId : undefined;
  const projectId = "projectId" in body ? body.projectId : undefined;
  const pathPrefixValue = "pathPrefix" in body ? body.pathPrefix : undefined;
  const entryFileValue = "entryFile" in body ? body.entryFile : undefined;
  const trackingMode = "trackingMode" in body ? body.trackingMode : undefined;
  const pinnedDeploymentId = "pinnedDeploymentId" in body ? body.pinnedDeploymentId : undefined;
  if (
    typeof organizationId !== "string"
    || typeof projectId !== "string"
    || typeof pathPrefixValue !== "string"
    || typeof entryFileValue !== "string"
  ) return c.json({ error: "Invalid publication fields" }, 400);
  const pathPrefix = cleanPath(pathPrefixValue, true);
  const entryFile = cleanPath(entryFileValue, false);
  if (pathPrefix === null || !entryFile) return c.json({ error: "Invalid publication path" }, 400);
  const query = new URLSearchParams({ organizationId, projectId });
  let deployment: Deployment | undefined;
  if (trackingMode === "pinned" && typeof pinnedDeploymentId === "string") {
    const response = await backend(`/api/rendro/deployments?${query}`, c.req.raw);
    if (!response.ok) return response;
    const result = await response.json() as { deployments: Deployment[] };
    deployment = result.deployments.find((candidate) => candidate._id === pinnedDeploymentId);
  } else {
    const response = await backend(`/api/rendro/deployments/active?${query}`, c.req.raw);
    if (!response.ok) return response;
    const result = await response.json() as { deployment?: Deployment };
    deployment = result.deployment;
  }
  if (!deployment || deployment.status === "failed" || deployment.status === "staging") {
    return c.json({ error: "Publication requires an available deployment" }, 409);
  }
  const text = await getObjectText(deployment.manifestKey);
  const manifest = parseManifest(text);
  const fullEntry = pathPrefix ? `${pathPrefix}/${entryFile}` : entryFile;
  if (!manifest?.files.some((file) => file.path === fullEntry && file.contentType.startsWith("text/html"))) {
    return c.json({ error: "Publication entry file is not present in the selected deployment path" }, 400);
  }
  return backend("/api/rendro/publications", c.req.raw, "POST", JSON.stringify(body));
});

export default app;
