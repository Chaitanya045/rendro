export function validRelativeDocumentPath(path: string): boolean {
  return Boolean(path)
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
