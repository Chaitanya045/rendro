export const COMMENTOR_THEME_READY = "commentor-theme-ready";

export function requestParentTheme(target: Pick<WindowProxy, "postMessage">): void {
  target.postMessage({ type: COMMENTOR_THEME_READY }, "*");
}

export function isThemeReadyMessage(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && "type" in data && data.type === COMMENTOR_THEME_READY);
}
