/** Request paths can contain bearer capabilities; never log their ciphertext. */
export function redactViewerPath(path: string): string {
  return path.replace(/(\/(?:docs|legacy-view\/[^/]+)\/view\/)[^/?#]+/g, "$1[redacted]");
}
