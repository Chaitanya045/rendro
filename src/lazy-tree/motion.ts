export function indicatorTransition(animate: boolean, reducedMotion: boolean): string {
  return animate && !reducedMotion
    ? "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease"
    : "none";
}

export function folderTransitionOverride(reducedMotion: boolean): string {
  return reducedMotion ? "none" : "";
}
