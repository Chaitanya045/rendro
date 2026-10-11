import { isCanonicalStorageKey } from "../shared/storage-path";
export { decodeStoragePath, isCanonicalStorageKey } from "../shared/storage-path";

/** Existing legacy data stays in place. The entire modern root is reserved;
 * ambiguous historical legacy data under it is unavailable, never migrated. */
export function legacyStoragePrefix(org: string): string | null {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(org) && org !== "tenants" ? `${org}/` : null;
}

export function isLegacyStorageKey(org: string, key: string): boolean {
  const prefix = legacyStoragePrefix(org);
  return !!prefix && isCanonicalStorageKey(key) && key.startsWith(prefix);
}

export function isLegacyStoragePrefix(org: string, prefix: string): boolean {
  const root = legacyStoragePrefix(org);
  return !!root && (prefix === root || (prefix.endsWith("/") && isLegacyStorageKey(org, prefix.slice(0, -1))));
}

export function modernStoragePrefix(scope: { organizationId: string; projectId: string; manifestKey: string }): string | null {
  const { organizationId, projectId, manifestKey } = scope;
  if (![organizationId, projectId].every(id => isCanonicalStorageKey(id) && !id.includes("/"))
    || !isCanonicalStorageKey(manifestKey)) return null;
  const root = `tenants/${organizationId}/projects/${projectId}/deployments/`;
  if (!manifestKey.startsWith(root)) return null;
  const parts = manifestKey.slice(root.length).split("/");
  return parts.length === 2 && parts[1] === "manifest.json" ? `${root}${parts[0]}/files/` : null;
}

export function modernStorageKey(scope: { organizationId: string; projectId: string; manifestKey: string }, path: string): string | null {
  const prefix = modernStoragePrefix(scope);
  if (!prefix || !isCanonicalStorageKey(path)) return null;
  const key = prefix + path;
  return isCanonicalStorageKey(key) && key.startsWith(prefix) ? key : null;
}
