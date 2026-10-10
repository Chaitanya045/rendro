export type StoredManifest = {
  files: Array<{ path: string; contentType: string }>;
};

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
      || !("contentType" in entry)
      || typeof entry.contentType !== "string"
    ) return null;
  }
  return value as StoredManifest;
}
