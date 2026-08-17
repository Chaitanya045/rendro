import { Hono } from "hono";
import { CONVEX_SITE_URL } from "@/config";
import {
  copyObject,
  getObjectText,
  headObject,
  listAllKeys,
  putObject,
} from "@/minio";

const app = new Hono();

type ManifestFile = {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
};

type DeploymentManifest = {
  version: 1;
  files: ManifestFile[];
};

type DeploymentIdentity = {
  organizationId: string;
  projectId: string;
  deploymentId: string;
};

function safePath(value: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  const path = decoded.replace(/^\/+/, "");
  if (
    !path
    || path.length > 1024
    || path.includes("\\")
    || path.split("/").some((part) => !part || part === "." || part === "..")
  ) return null;
  return path;
}

function objectRoot(identity: DeploymentIdentity): string {
  return `tenants/${identity.organizationId}/projects/${identity.projectId}/deployments/${identity.deploymentId}`;
}

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digestInput = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers({ Accept: "application/json" });
  for (const name of ["authorization", "content-type", "cookie", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function backendRequest(
  path: string,
  request: Request,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  return fetch(`${CONVEX_SITE_URL}${path}`, {
    method: init.method ?? request.method,
    headers: forwardedHeaders(request),
    body: init.body,
    redirect: "manual",
  });
}

function parseManifest(value: unknown): DeploymentManifest | null {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return null;
  if (!("files" in value) || !Array.isArray(value.files)) return null;
  const files: ManifestFile[] = [];
  const paths = new Set<string>();
  for (const entry of value.files as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const path = "path" in entry && typeof entry.path === "string" ? safePath(entry.path) : null;
    const fileSha = "sha256" in entry && typeof entry.sha256 === "string" ? entry.sha256 : "";
    const size = "size" in entry && typeof entry.size === "number" ? entry.size : -1;
    const contentType = "contentType" in entry && typeof entry.contentType === "string"
      ? entry.contentType
      : "application/octet-stream";
    if (!path || paths.has(path) || !/^[a-f0-9]{64}$/.test(fileSha) || size < 0) return null;
    paths.add(path);
    files.push({ path, sha256: fileSha, size, contentType });
  }
  if (files.some((file, index) => index > 0 && files[index - 1].path >= file.path)) return null;
  return { version: 1, files };
}

async function stagingDeployment(
  request: Request,
  identity: DeploymentIdentity,
): Promise<{ deployment: { manifestKey: string; treeIndexKey?: string; previousDeploymentId?: string } } | null> {
  const query = new URLSearchParams(identity);
  const response = await backendRequest(`/api/rendro/deployments/staging?${query}`, request, { method: "GET" });
  if (!response.ok) return null;
  return response.json() as Promise<{ deployment: { manifestKey: string; treeIndexKey?: string; previousDeploymentId?: string } }>;
}

async function loadManifest(key: string): Promise<DeploymentManifest | null> {
  const text = await getObjectText(key);
  if (!text) return null;
  try { return parseManifest(JSON.parse(text)); } catch { return null; }
}

app.get("/api/rendro/deployments/check", async (c) => {
  const query = new URL(c.req.url).search;
  const response = await backendRequest(`/api/rendro/deployments/active${query}`, c.req.raw, { method: "GET" });
  if (!response.ok) return response;
  const result = await response.json() as { deployment: { manifestKey: string } | null };
  if (!result.deployment) return c.json({ deployment: null, manifest: null });
  const manifest = await loadManifest(result.deployment.manifestKey);
  return c.json({ deployment: result.deployment, manifest });
});

app.post("/api/rendro/deployments/start", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "Invalid deployment body" }, 400);
  const manifest = "manifest" in body ? parseManifest(body.manifest) : null;
  const organizationId = "organizationId" in body ? body.organizationId : null;
  const projectId = "projectId" in body ? body.projectId : null;
  const manifestSha256 = "manifestSha256" in body ? body.manifestSha256 : null;
  if (!manifest || typeof organizationId !== "string" || typeof projectId !== "string") {
    return c.json({ error: "Valid organizationId, projectId, and sorted manifest are required" }, 400);
  }
  const manifestText = JSON.stringify(manifest);
  const computedSha = await sha256(manifestText);
  const byteCount = manifest.files.reduce((total, file) => total + file.size, 0);
  if (manifestSha256 !== computedSha) return c.json({ error: "Manifest checksum mismatch" }, 400);
  const backendBody = JSON.stringify({
    ...body,
    manifest: undefined,
    fileCount: manifest.files.length,
    byteCount,
    manifestSha256: computedSha,
  });
  const response = await backendRequest("/api/rendro/deployments/start", c.req.raw, {
    method: "POST",
    body: backendBody,
  });
  if (!response.ok) return response;
  const result = await response.json() as {
    deployment: {
      deploymentId: string;
      manifestKey: string;
      treeIndexKey: string;
      objectRoot: string;
      previousDeploymentId?: string;
    };
  };
  try {
    await Promise.all([
      putObject(result.deployment.manifestKey, manifestText, "application/json", { sha256: computedSha }),
      putObject(
        result.deployment.treeIndexKey,
        JSON.stringify({ version: 1, files: manifest.files.map(({ path, size }) => ({ path, size })) }),
        "application/json",
      ),
    ]);
  } catch (error: unknown) {
    await backendRequest("/api/rendro/deployments/fail", c.req.raw, {
      method: "POST",
      body: JSON.stringify({
        organizationId,
        projectId,
        deploymentId: result.deployment.deploymentId,
        reason: error instanceof Error ? error.message : String(error),
      }),
    });
    return c.json({ error: "Unable to initialize deployment storage" }, 502);
  }
  return c.json(result, 201);
});

app.put("/api/rendro/deployments/:deploymentId/files/*", async (c) => {
  const organizationId = c.req.query("organizationId");
  const projectId = c.req.query("projectId");
  const deploymentId = c.req.param("deploymentId");
  const filePath = safePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!organizationId || !projectId || !filePath) return c.json({ error: "Invalid deployment file path" }, 400);
  const identity = { organizationId, projectId, deploymentId };
  const staging = await stagingDeployment(c.req.raw, identity);
  if (!staging) return c.json({ error: "Invalid key or staging deployment" }, 401);
  const manifest = await loadManifest(staging.deployment.manifestKey);
  const expected = manifest?.files.find((file) => file.path === filePath);
  if (!expected) return c.json({ error: "File is not present in the deployment manifest" }, 400);
  const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
  if (bytes.byteLength !== expected.size || await sha256(bytes) !== expected.sha256) {
    return c.json({ error: "Uploaded file does not match its manifest entry" }, 400);
  }
  await putObject(
    `${objectRoot(identity)}/files/${filePath}`,
    bytes,
    expected.contentType,
    { sha256: expected.sha256 },
  );
  return c.json({ uploaded: filePath });
});

app.post("/api/rendro/deployments/:deploymentId/copy", async (c) => {
  const organizationId = c.req.query("organizationId");
  const projectId = c.req.query("projectId");
  const deploymentId = c.req.param("deploymentId");
  if (!organizationId || !projectId) return c.json({ error: "Missing deployment identity" }, 400);
  const identity = { organizationId, projectId, deploymentId };
  const staging = await stagingDeployment(c.req.raw, identity);
  if (!staging?.deployment.previousDeploymentId) {
    return c.json({ error: "There is no previous deployment to reuse" }, 400);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const paths = body && typeof body === "object" && "paths" in body && Array.isArray(body.paths)
    ? body.paths.map((value) => typeof value === "string" ? safePath(value) : null)
    : [];
  if (paths.some((path) => !path)) return c.json({ error: "Invalid copy path" }, 400);
  const manifest = await loadManifest(staging.deployment.manifestKey);
  if (!manifest) return c.json({ error: "Deployment manifest not found" }, 404);
  const expectedByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const previousRoot = objectRoot({ ...identity, deploymentId: staging.deployment.previousDeploymentId });
  for (let start = 0; start < paths.length; start += 32) {
    const batch = paths.slice(start, start + 32) as string[];
    await Promise.all(batch.map(async (path) => {
      const expected = expectedByPath.get(path);
      if (!expected) throw new Error(`File ${path} is not present in the manifest`);
      const source = `${previousRoot}/files/${path}`;
      const sourceMetadata = await headObject(source);
      if (!sourceMetadata || sourceMetadata.size !== expected.size || sourceMetadata.metadata?.sha256 !== expected.sha256) {
        throw new Error(`File ${path} cannot be reused from the previous deployment`);
      }
      await copyObject(source, `${objectRoot(identity)}/files/${path}`);
    }));
  }
  return c.json({ copied: paths.length });
});

app.post("/api/rendro/deployments/:deploymentId/commit", async (c) => {
  const organizationId = c.req.query("organizationId");
  const projectId = c.req.query("projectId");
  const deploymentId = c.req.param("deploymentId");
  if (!organizationId || !projectId) return c.json({ error: "Missing deployment identity" }, 400);
  const identity = { organizationId, projectId, deploymentId };
  const staging = await stagingDeployment(c.req.raw, identity);
  if (!staging) return c.json({ error: "Invalid key or staging deployment" }, 401);
  const manifest = await loadManifest(staging.deployment.manifestKey);
  if (!manifest) return c.json({ error: "Deployment manifest not found" }, 404);
  const prefix = `${objectRoot(identity)}/files/`;
  const actual = (await listAllKeys(prefix)).map((key) => key.slice(prefix.length)).sort();
  const expected = manifest.files.map((file) => file.path);
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    return c.json({ error: "Deployment is incomplete; uploaded files do not match the manifest" }, 409);
  }
  return backendRequest("/api/rendro/deployments/commit", c.req.raw, {
    method: "POST",
    body: JSON.stringify(identity),
  });
});

export default app;
