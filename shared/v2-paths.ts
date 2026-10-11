import { isCanonicalStorageKey } from "./storage-path";

// Publication form fields retain their existing outer whitespace/delimiter cleanup.
// Like JSON manifest/copy paths, their percent signs are literal filename data.
export function cleanPublicationPath(value: string, allowEmpty: boolean): string | null {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) return allowEmpty ? "" : null;
  return isCanonicalStorageKey(path) ? path : null;
}

// JSON and stored manifests contain canonical paths, never URL-encoded paths.
// Decode upload URL segments once with decodeStoragePath before calling this.
export function cleanDeploymentPath(path: string): string | null {
  return path.length <= 1024 && isCanonicalStorageKey(path) ? path : null;
}
