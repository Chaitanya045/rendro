const COMMENTOR_THEME_READY = "commentor-theme-ready";

export function requestParentTheme(target: Pick<WindowProxy, "postMessage">): void {
  target.postMessage({ type: COMMENTOR_THEME_READY }, "*");
}
