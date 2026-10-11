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

export function loadedDocumentAction(
  loadedPath: string,
  currentPath: string | undefined,
  expectedPath: string | null,
): "ignore" | "sync" | "reload" {
  if (expectedPath) return loadedPath === expectedPath ? "sync" : "ignore";
  return Boolean(currentPath) && loadedPath !== currentPath ? "reload" : "sync";
}

/** Queries stay separate from authorized paths and cannot introduce a fragment. */
export function validDocumentSearch(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096
    && (value === "" || (value.startsWith("?") && !/[#\r\n]/.test(value)));
}
