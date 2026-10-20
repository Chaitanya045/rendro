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

/**
 * The absolute address of a link the shell opens in a new tab once the reader confirms it: any bounded http(s) URL
 * that is not a repository document of the frame. Another site cannot load in the frame, and a page of this site
 * that is not a document must not load there either (#296).
 */
export function newTabLinkHref(value: unknown, baseURI: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value, baseURI);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
