import { cleanDeploymentPath } from "../shared/v2-paths";
import { MAX_DEPLOYMENT_FILES, validDeploymentCounts, deploymentFileLimitError } from "../shared/deployment-limits";

export type StoredManifest = {
  files: Array<{ path: string; contentType: string }>;
};

export type ManifestFile = {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
};

export type DeploymentManifest = {
  version: 1;
  files: ManifestFile[];
};

/** Lenient reader for already-stored manifests, including deployments that
 * predate the current per-deployment limits. Paths stay canonical. */
export function parseStoredManifest(text: string | null): StoredManifest | null {
  if (!text) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || !("files" in value) || !Array.isArray(value.files)) return null;
  for (const entry of value.files as unknown[]) {
    if (
      !entry
      || typeof entry !== "object"
      || !("path" in entry)
      || typeof entry.path !== "string"
      || cleanDeploymentPath(entry.path) === null
      || !("contentType" in entry)
      || typeof entry.contentType !== "string"
    ) return null;
  }
  return value as StoredManifest;
}

/** Strict parser for new and staging manifests: sorted, unique, canonical
 * paths with hashes, sizes and MIME types inside the deployment limits. */
export function parseDeploymentManifest(value: unknown): DeploymentManifest | null {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return null;
  if (!("files" in value) || !Array.isArray(value.files) || value.files.length > MAX_DEPLOYMENT_FILES) return null;
  const files: ManifestFile[] = [];
  const paths = new Set<string>();
  let byteCount = 0;
  for (const entry of value.files as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const rawPath = "path" in entry && typeof entry.path === "string" ? entry.path : "";
    const path = cleanDeploymentPath(rawPath);
    const fileSha = "sha256" in entry && typeof entry.sha256 === "string" ? entry.sha256 : "";
    const size = "size" in entry && typeof entry.size === "number" ? entry.size : -1;
    const contentType = "contentType" in entry && typeof entry.contentType === "string"
      ? entry.contentType
      : "application/octet-stream";
    if (!path || paths.has(path) || !/^[a-f0-9]{64}$/.test(fileSha) || deploymentFileLimitError(rawPath, size, contentType)) return null;
    byteCount += size;
    if (!validDeploymentCounts(value.files.length, byteCount)) return null;
    paths.add(path);
    files.push({ path, sha256: fileSha, size, contentType });
  }
  if (files.some((file, index) => index > 0 && files[index - 1].path >= file.path)) return null;
  return { version: 1, files };
}

export function parseDeploymentManifestText(text: string | null): DeploymentManifest | null {
  if (!text) return null;
  try { return parseDeploymentManifest(JSON.parse(text)); } catch { return null; }
}
