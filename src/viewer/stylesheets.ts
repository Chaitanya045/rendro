import { hasCssImports } from "./css-urls";

type SheetElement = HTMLLinkElement | HTMLStyleElement;

interface SheetState {
  active: SheetElement;
  value: string;
  pending?: SheetElement;
  failures: number;
  retryAt: number;
}

/** Keep the active cascade intact while a renewed sheet (and its imports) loads. */
export function createStylesheetRenewer(): (element: SheetElement, replace: (value: string) => string) => void {
  const states = new WeakMap<SheetElement, SheetState>();
  const isLink = (element: SheetElement): element is HTMLLinkElement => element.tagName === "LINK";
  const valueOf = (element: SheetElement) => isLink(element) ? element.getAttribute("href") : element.textContent;

  function load(state: SheetState): void {
    const old = state.active;
    const oldValue = valueOf(old);
    const replacement = old.cloneNode(false) as SheetElement;
    if (isLink(replacement)) replacement.href = state.value;
    else replacement.textContent = state.value;
    if (old.nonce) replacement.nonce = old.nonce;
    replacement.disabled = old.disabled;
    state.pending = replacement;
    states.set(replacement, state);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    function finish(loaded: boolean): void {
      clearTimeout(timeout);
      replacement.removeEventListener("load", onLoad);
      replacement.removeEventListener("error", onError);
      state.pending = undefined;
      // Do not resurrect a sheet removed or retargeted by publisher scripts.
      if (!old.isConnected || valueOf(old) !== oldValue) {
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
        // of concurrent duplicate sheets. Its content can be newer than this load.
        if (state.value !== valueOf(replacement)) load(state);
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
    // Both link and style load include nested @imports. Inline styles may not
    // dispatch either event (e.g. an inactive import); retain the old graph then.
    if (!isLink(old)) timeout = setTimeout(() => finish(false), 30_000);
    old.after(replacement);
  }

  return (element, replace) => {
    let state = states.get(element);
    if (state && state.active !== element) return; // This is an in-flight clone.
    const current = state?.value ?? valueOf(element);
    if (current === null) return;
    const value = replace(current);
    if (!state) {
      if (value === current) return;
      if (!isLink(element) && !hasCssImports(current)) {
        // No network dependency: replacing these rules is synchronous.
        element.textContent = value;
        return;
      }
      state = { active: element, value, failures: 0, retryAt: 0 };
      states.set(element, state);
    } else state.value = value;
    if (!state.pending && Date.now() >= state.retryAt && value !== valueOf(element)) load(state);
  };
}
