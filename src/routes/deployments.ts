import { deploymentWriteSignal, readDeploymentBody } from "@/deployment-lease";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authClientIpHeaders } from "@/auth-client-ip";
import { logger } from "@/logger";
import { transientStorageFault } from "@/storage-fault";
import { backendFetch } from "@/backend-fetch";
import { signStorageValidation, STORAGE_ATTESTATION_HEADER } from "../../shared/storage-attestation";
import { CONVEX_INTERNAL_SECRET, CONVEX_SITE_URL } from "@/config";
import {
  copyObject,
  getObjectText,
  headObject,
  listAllKeys,
  putObject,
} from "@/minio";
import { MAX_REUSED_FILES_PER_REQUEST, MAX_DEPLOYMENT_FILES, MAX_COMMIT_LIST_PAGES } from "../../shared/deployment-limits";
import { decodeStoragePath } from "../../shared/storage-path";
import { cleanDeploymentPath } from "../../shared/v2-paths";
import { parseDeploymentManifest, parseDeploymentManifestText, type DeploymentManifest } from "@/stored-manifest";
import { deploymentIndexObjects, openDeploymentIndex } from "@/deployment-index";

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  // Every storage write here is idempotent (fixed key, manifest-checked bytes), so the CLI may replay it.
  const fault = transientStorageFault(error);
  if (fault) {
    logger.error({ category: "StorageError", ...fault }, "Deployment storage unavailable");
    return c.json({ error: "Storage temporarily unavailable", retryable: true }, 503, { "Retry-After": "1", "Cache-Control": "private, no-store" });
  }
  logger.error({ errorType: error.name }, "Deployment request failed");
  return c.json({ error: "Internal server error" }, 500);
});

type DeploymentIdentity = {
  organizationId: string;
  projectId: string;
  deploymentId: string;
};

function objectRoot(identity: DeploymentIdentity): string {
  return `tenants/${identity.organizationId}/projects/${identity.projectId}/deployments/${identity.deploymentId}`;
}

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digestInput = input as Uint8Array<ArrayBuffer>;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers({ Accept: "application/json" });
  for (const name of ["authorization", "content-type", "cookie", "origin", "sec-fetch-site", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function backendRequest(
  path: string,
  request: Request,
  init: { method: string; body?: string; attestation?: string },
): Promise<Response> {
  const target = `${CONVEX_SITE_URL}${path}`;
  const method = init.method;
  const headers = forwardedHeaders(request);
  if (init.attestation) headers.set(STORAGE_ATTESTATION_HEADER, init.attestation);
  (await authClientIpHeaders(request, target, method)).forEach((value, name) => headers.set(name, value));
  return backendFetch(target, {
    method,
    headers,
    body: init.body,
    redirect: "manual",
  }, "deploymentRequest");
}

async function stagingDeployment(
  request: Request,
  identity: DeploymentIdentity,
): Promise<{ deployment: { manifestKey: string; stagingExpiresAt: number; treeIndexKey?: string; previousDeploymentId?: string } } | Response> {
  const query = new URLSearchParams(identity);
  const response = await backendRequest(`/api/rendro/deployments/staging?${query}`, request, { method: "GET" });
  if (!response.ok) return response;
  return response.json() as Promise<{ deployment: { manifestKey: string; stagingExpiresAt: number; treeIndexKey?: string; previousDeploymentId?: string } }>;
}

async function loadManifest(key: string): Promise<DeploymentManifest | null> {
  return parseDeploymentManifestText(await getObjectText(key));
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
  const manifest = "manifest" in body ? parseDeploymentManifest(body.manifest) : null;
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
      stagingExpiresAt: number;
      manifestKey: string;
      treeIndexKey: string;
      objectRoot: string;
      previousDeploymentId?: string;
    };
  };
  try {
    // Readers fall back to the manifest for any key without an index.
    const index = await deploymentIndexObjects(result.deployment.manifestKey, manifest, computedSha);
    await Promise.all([
      putObject(result.deployment.manifestKey, manifestText, "application/json", { sha256: computedSha }, deploymentWriteSignal(result.deployment.stagingExpiresAt)),
      putObject(
        result.deployment.treeIndexKey,
        JSON.stringify({ version: 1, files: manifest.files.map(({ path, size }) => ({ path, size })) }),
        "application/json",
        undefined,
        deploymentWriteSignal(result.deployment.stagingExpiresAt),
      ),
      ...(index?.shards ?? []).map(({ key, body }) => putObject(key, body, "application/json", undefined, deploymentWriteSignal(result.deployment.stagingExpiresAt))),
    ]);
    // The root is written last, so its presence implies every shard is stored.
    if (index) await putObject(index.root.key, index.root.body, "application/json", undefined, deploymentWriteSignal(result.deployment.stagingExpiresAt));
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
  const decodedPath = decodeStoragePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  const filePath = decodedPath === null ? null : cleanDeploymentPath(decodedPath);
  if (!organizationId || !projectId || !filePath) return c.json({ error: "Invalid deployment file path" }, 400);
  const identity = { organizationId, projectId, deploymentId };
  const staging = await stagingDeployment(c.req.raw, identity);
  if (staging instanceof Response) return staging;
  // Reads one index shard (or the cached manifest of an unindexed deployment).
  const index = await openDeploymentIndex(staging.deployment.manifestKey, "staging");
  const expected = await index?.file(filePath);
  if (!expected) return c.json({ error: "File is not present in the deployment manifest" }, 400);
  const declaredLength = c.req.header("Content-Length");
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length !== expected.size) {
      return c.json({ error: "Uploaded file size does not match its manifest entry" }, 413);
    }
  }
  const bytes = await readDeploymentBody(c.req.raw.body, expected.size, () => stagingDeployment(c.req.raw, identity));
  if (!bytes) return c.json({ error: "Uploaded file exceeds its size limit or does not match the manifest size" }, 413);
  if (await sha256(bytes) !== expected.sha256) {
    return c.json({ error: "Uploaded file does not match its manifest entry" }, 400);
  }
  const current = await stagingDeployment(c.req.raw, identity);
  if (current instanceof Response) return current;
  await putObject(
    `${objectRoot(identity)}/files/${filePath}`,
    bytes,
    expected.contentType,
    { sha256: expected.sha256 },
    deploymentWriteSignal(current.deployment.stagingExpiresAt),
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
  if (staging instanceof Response) return staging;
  if (!staging.deployment.previousDeploymentId) {
    return c.json({ error: "There is no previous deployment to reuse" }, 400);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const paths = body && typeof body === "object" && "paths" in body && Array.isArray(body.paths)
    ? body.paths.map((value) => typeof value === "string" ? cleanDeploymentPath(value) : null)
    : [];
  if (paths.some((path) => !path)) return c.json({ error: "Invalid copy path" }, 400);
  if (paths.length > MAX_REUSED_FILES_PER_REQUEST) {
    return c.json({ error: `Copy at most ${MAX_REUSED_FILES_PER_REQUEST} files per request; update the Rendro CLI` }, 400);
  }
  const index = await openDeploymentIndex(staging.deployment.manifestKey, "staging");
  if (!index) return c.json({ error: "Deployment manifest not found" }, 404);
  const previousRoot = objectRoot({ ...identity, deploymentId: staging.deployment.previousDeploymentId });
  const copies = await Promise.all((paths as string[]).map(async (path) => {
    const expected = await index.file(path);
    if (!expected) throw new Error(`File ${path} is not present in the manifest`);
    const source = `${previousRoot}/files/${path}`;
    const sourceMetadata = await headObject(source);
    if (!sourceMetadata || sourceMetadata.size !== expected.size || sourceMetadata.metadata?.sha256 !== expected.sha256) {
      throw new Error(`File ${path} cannot be reused from the previous deployment`);
    }
    return { path, source };
  }));
  const current = await stagingDeployment(c.req.raw, identity);
  if (current instanceof Response) return current;
  const signal = deploymentWriteSignal(current.deployment.stagingExpiresAt);
  await Promise.all(copies.map(({ path, source }) => copyObject(source, `${objectRoot(identity)}/files/${path}`, signal)));
  return c.json({ copied: paths.length });
});

app.post("/api/rendro/deployments/:deploymentId/commit", async (c) => {
  const organizationId = c.req.query("organizationId");
  const projectId = c.req.query("projectId");
  const deploymentId = c.req.param("deploymentId");
  if (!organizationId || !projectId) return c.json({ error: "Missing deployment identity" }, 400);
  const identity = { organizationId, projectId, deploymentId };
  const staging = await stagingDeployment(c.req.raw, identity);
  if (staging instanceof Response) return staging;
  const manifest = await loadManifest(staging.deployment.manifestKey);
  if (!manifest) return c.json({ error: "Deployment manifest not found" }, 404);
  const prefix = `${objectRoot(identity)}/files/`;
  const actual = (await listAllKeys(prefix, { maxKeys: MAX_DEPLOYMENT_FILES, maxPages: MAX_COMMIT_LIST_PAGES })).map((key) => key.slice(prefix.length)).sort();
  const expected = manifest.files.map((file) => file.path);
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    return c.json({ error: "Deployment is incomplete; uploaded files do not match the manifest" }, 409);
  }
  return backendRequest("/api/rendro/deployments/commit", c.req.raw, {
    method: "POST",
    body: JSON.stringify(identity),
    attestation: await signStorageValidation({
      purpose: "deployment-commit", ...identity,
      manifestKey: staging.deployment.manifestKey,
      manifestSha256: await sha256(JSON.stringify(manifest)),
      fileCount: manifest.files.length,
    }, CONVEX_INTERNAL_SECRET),
  });
});

// The generic session proxy intentionally omits Authorization. CLI failure
// callbacks need the same scoped bearer forwarding as start/upload/commit.
app.post("/api/rendro/deployments/fail", async (c) => backendRequest(
  "/api/rendro/deployments/fail", c.req.raw,
  { method: "POST", body: await c.req.text() },
));

export default app;
