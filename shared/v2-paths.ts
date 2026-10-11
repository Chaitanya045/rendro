// Publication paths are case-sensitive and preserve Unicode code points.
export function cleanPublicationPath(value: string, allowEmpty: boolean): string | null {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) return allowEmpty ? "" : null;
  return path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") ? null : path;
}

// Used for manifest entries and upload URLs by the v2 deployment API.
export function cleanDeploymentPath(value: string): string | null {
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
