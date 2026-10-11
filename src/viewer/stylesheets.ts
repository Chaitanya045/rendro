interface SheetState {
  active: HTMLLinkElement;
  href: string;
  pending?: HTMLLinkElement;
  failures: number;
  retryAt: number;
}

/** Keep the active cascade intact while a renewed sheet (and its imports) loads. */
export function createStylesheetRenewer(): (link: HTMLLinkElement, replace: (url: string) => string) => void {
  const states = new WeakMap<HTMLLinkElement, SheetState>();

  function load(state: SheetState): void {
    const old = state.active;
    const oldHref = old.getAttribute("href");
    const replacement = old.cloneNode(false) as HTMLLinkElement;
    replacement.href = state.href;
    replacement.disabled = old.disabled;
    state.pending = replacement;
    states.set(replacement, state);

    function finish(loaded: boolean): void {
      replacement.removeEventListener("load", onLoad);
      replacement.removeEventListener("error", onError);
      state.pending = undefined;
      // Do not resurrect a sheet removed or retargeted by publisher scripts.
      if (!old.isConnected || old.getAttribute("href") !== oldHref) {
        replacement.remove();
        states.delete(old);
        states.delete(replacement);
        return;
      }
      if (loaded) {
        old.remove();
        states.delete(old);
        state.active = replacement;
        state.failures = 0;
        state.retryAt = 0;
        // Coalesce overlapping renewals into one latest successor, never a chain
        // of concurrent duplicate links. Its URL can be newer than this load.
        if (state.href !== replacement.href) load(state);
      } else {
        replacement.remove();
        states.delete(replacement);
        state.retryAt = Date.now() + Math.min(60_000 * 2 ** state.failures, 15 * 60_000);
        state.failures = Math.min(state.failures + 1, 4);
        // Retry only on a subsequent renewal, retaining the old loaded sheet.
      }
    }
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    replacement.addEventListener("load", onLoad);
    replacement.addEventListener("error", onError);
    // Adjacent insertion preserves order relative to every other sheet/style.
    // Link load includes @imports, whose relative URLs inherit the new href.
    old.after(replacement);
  }

  return (link, replace) => {
    let state = states.get(link);
    if (state && state.active !== link) return; // This is an in-flight clone.
    const current = state?.href ?? link.getAttribute("href");
    if (current === null) return;
    const href = replace(current);
    if (!state) {
      if (href === current) return;
      state = { active: link, href, failures: 0, retryAt: 0 };
      states.set(link, state);
    } else state.href = href;
    if (!state.pending && Date.now() >= state.retryAt && href !== link.href) load(state);
  };
}
