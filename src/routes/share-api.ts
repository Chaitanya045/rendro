import { MAX_SHARE_METADATA_BYTES } from "../../shared/share-assets";
import { Hono } from "hono";
import { authClientIpHeaders } from "@/auth-client-ip";
import { backendFetch } from "@/backend-fetch";
import { signStorageValidation, STORAGE_ATTESTATION_HEADER } from "../../shared/storage-attestation";
import { CONVEX_INTERNAL_SECRET, CONVEX_SITE_URL } from "@/config";
import { getObjectStream, getObjectText } from "@/minio";
import { parseStoredManifest } from "@/stored-manifest";
import { isCanonicalStorageKey, modernStoragePrefix } from "@/storage-boundary";
import { collectShareAssets, ShareAssetError } from "@/share-assets";

const app = new Hono();

app.post("/api/rendro/shares", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "Invalid share body" }, 400);
  const organizationId = "organizationId" in body ? body.organizationId : undefined;
  const projectId = "projectId" in body ? body.projectId : undefined;
  const documentPath = "documentPath" in body ? body.documentPath : undefined;
  const expiresInSeconds = "expiresInSeconds" in body ? body.expiresInSeconds : undefined;
  if (typeof organizationId !== "string" || typeof projectId !== "string" || typeof documentPath !== "string"
    || typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)
    || expiresInSeconds < 60 || expiresInSeconds > 60 * 60 * 24 * 30
    || !isCanonicalStorageKey(documentPath)) return c.json({ error: "Invalid share fields" }, 400);
  // Serialize only supported fields; caller extras must not consume the asset budget.
  const metadata = { organizationId, projectId, documentPath, expiresInSeconds };
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > MAX_SHARE_METADATA_BYTES) {
    return c.json({ error: "Share metadata exceeds the size limit" }, 400);
  }
  const headers = new Headers({ Accept: "application/json" });
  // Share creation is session-only; caller proofs and API credentials are not forwarded.
  for (const name of ["cookie", "content-type", "origin", "sec-fetch-site", "user-agent"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const target = `${CONVEX_SITE_URL}/api/rendro/deployments/active?${new URLSearchParams({ organizationId, projectId })}`;
  (await authClientIpHeaders(c.req.raw, target, "GET")).forEach((value, name) => headers.set(name, value));
  const response = await backendFetch(target, { headers, redirect: "manual" }, "shareRequest");
  if (!response.ok) return response;
  const { deployment } = await response.json() as { deployment?: {
    _id: string; manifestKey: string; manifestSha256: string; fileCount: number; status: string;
  } };
  if (!deployment || !["active", "superseded"].includes(deployment.status)) {
    return c.json({ error: "Share requires an available deployment" }, 404);
  }
  const prefix = modernStoragePrefix({ organizationId, projectId, manifestKey: deployment.manifestKey });
  if (!prefix) return c.json({ error: "Share deployment unavailable" }, 404);
  const manifest = parseStoredManifest(await getObjectText(deployment.manifestKey));
  if (!manifest) return c.json({ error: "Share manifest unavailable" }, 404);
  let assetPaths: string[];
  try {
    assetPaths = await collectShareAssets(manifest, documentPath, path => getObjectStream(prefix + path));
  } catch (error) {
    if (error instanceof ShareAssetError) {
      return c.json({ error: error.message, code: error.code, reason: error.reason }, 400);
    }
    throw error;
  }
  headers.set(STORAGE_ATTESTATION_HEADER, await signStorageValidation({
    purpose: "share-assets", organizationId, projectId, deploymentId: deployment._id,
    manifestKey: deployment.manifestKey, manifestSha256: deployment.manifestSha256, fileCount: deployment.fileCount,
    documentPath, assetPaths,
  }, CONVEX_INTERNAL_SECRET));
  const createTarget = `${CONVEX_SITE_URL}/api/rendro/shares`;
  (await authClientIpHeaders(c.req.raw, createTarget, "POST")).forEach((value, name) => headers.set(name, value));
  return backendFetch(createTarget, {
    method: "POST", headers, body: JSON.stringify({ ...metadata, assetPaths }), redirect: "manual",
  }, "shareRequest");
});

export default app;
