export function validRelativeDocumentPath(path: string): boolean {
  return path.length <= 4096 && Boolean(path)
    && !path.includes("\\")
    && path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

export function normalizeLoadedDocumentPath(path: string, namespace: string): string | null {
  if (path.startsWith(`${namespace}/`)) {
    const relative = path.slice(namespace.length + 1);
    return validRelativeDocumentPath(relative) ? path : null;
  }
  return validRelativeDocumentPath(path) ? `${namespace}/${path}` : null;
}

export function isContentFrameSource(
  source: MessageEventSource | null,
  contentWindow: WindowProxy | null,
): boolean {
  return contentWindow !== null && source === contentWindow;
}

/** Queries stay separate from authorized paths and cannot introduce a fragment. */
export function validDocumentSearch(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096
    && (value === "" || (value.startsWith("?") && !/[#\r\n]/.test(value)));
}

/** The absolute address of a link to another site: http(s) on an origin other than the viewer's, bounded. */
export function externalLinkHref(value: unknown, baseURI: string, ownOrigin: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value, baseURI);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === ownOrigin) return null;
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
