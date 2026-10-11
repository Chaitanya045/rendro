/** Hashes are untrusted bridge data, including the leading # (or no fragment). */
export function validFragment(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096
    && (value === "" || value.startsWith("#"));
}

export function scrollToFragment(fragment: string, host: Window = window): void {
  if (!validFragment(fragment) || !fragment) return;
  let name = fragment.slice(1);
  try { name = decodeURIComponent(name); } catch { /* Literal malformed escapes can be IDs. */ }
  if (!name) { host.scrollTo(0, 0); return; }
  const doc = host.document;
  const target = doc.getElementById(name)
    ?? Array.from(doc.getElementsByName(name)).find(element => element.tagName === "A");
  if (target) target.scrollIntoView();
  else if (name.toLowerCase() === "top") host.scrollTo(0, 0);
}

/** Fragment-only navigation replaces the entry; document navigation still pushes. */
export function replaceViewerFragment(fragment: string, host: Window = window): void {
  if (!validFragment(fragment)) return;
  const url = new URL(host.location.href);
  url.hash = fragment;
  host.history.replaceState(host.history.state, "", url);
}

export function sendDocumentFragment(frame: HTMLIFrameElement, path: string, fragment: string): void {
  if (validFragment(fragment)) frame.contentWindow?.postMessage({ type: "doc-fragment", path, fragment }, "*");
}
