/**
 * Fired on the shell's window when another iframe becomes `#content-frame` (an adopted preload,
 * #245); `detail` is the new frame. Scripts that hold the frame element follow it (#254).
 */
export const CONTENT_FRAME_EVENT = "rendro:content-frame";

/*
 * Which document a shell frame shows (#296). The shell answers a frame only while its document is one the shell
 * itself loaded. Every navigation a shell script starts is recorded on the frame element, which no document inside
 * the frame can touch, and each `load` of the frame settles it:
 *
 *   data-navigation  the shell's latest navigation of the frame (a counter)
 *   data-loading     that navigation, until its load
 *   data-document    the navigation the frame's document came from (while loading, the one it is leaving)
 *
 * A load the shell did not start (the document navigating itself, or a reload from the frame's context menu) removes
 * `data-document`: the frame stays untrusted until the shell navigates it again and that navigation loads.
 */
const TRACKING = Symbol.for("rendro.shell-frame-loads");

/** Settle every shell frame's loads, once per document whichever bundles navigate frames in it. */
function trackShellFrameLoads(shell: Document): void {
  const state = shell as Document & { [TRACKING]?: true };
  if (state[TRACKING]) return;
  state[TRACKING] = true;
  // A frame's load never reaches the window (a document ends a load event's path); capture on the document runs
  // before any listener on the frame element, whichever bundle registered first.
  shell.addEventListener("load", event => {
    const frame = event.target as HTMLElement;
    if (frame.tagName !== "IFRAME" || frame.dataset.navigation === undefined) return;
    const loading = frame.dataset.loading;
    delete frame.dataset.loading;
    if (loading === undefined) delete frame.dataset.document;
    else frame.dataset.document = loading;
  }, true);
}

/**
 * Record a navigation of `frame` the shell is about to start (by setting its `src` or replacing its location). Loads
 * are tracked from the first one on: before it, nothing is pending that a load could settle.
 */
export function startShellNavigation(frame: HTMLIFrameElement): void {
  trackShellFrameLoads(frame.ownerDocument);
  const previous = frame.dataset.navigation;
  const navigation = String(Number(previous ?? 0) + 1);
  // A frame's first navigation leaves the empty document it was created with, which runs nothing.
  const src = frame.getAttribute("src");
  if (previous === undefined && (src === null || src === "about:blank")) frame.dataset.document = "0";
  frame.dataset.navigation = navigation;
  frame.dataset.loading = navigation;
}

/** The shell's latest navigation of `frame` while the frame shows a document the shell loaded; otherwise null. */
export function shellFrameNavigation(frame: HTMLIFrameElement): string | null {
  // `data-document` is only ever set together with `data-navigation`.
  return frame.dataset.document === undefined ? null : frame.dataset.navigation as string;
}
