export interface DocumentNavigationTarget {
  fullPath: string;
  search: string;
  fragment: string;
  /** A link to another site, confirmed by the reader and opened in a new tab; the document fields are then empty. */
  href?: string;
}

/** One bounded pending destination; only the reader can reopen a dismissed prompt. */
export function createNavigationConfirmation() {
  let state: "idle" | "visible" | "dismissed" = "idle";
  let pending: DocumentNavigationTarget | null = null;
  return {
    request(target: DocumentNavigationTarget): DocumentNavigationTarget | null {
      // Never change the destination of a visible (possibly focused) Open button.
      if (state === "visible") return null;
      if (pending?.fullPath === target.fullPath && pending.search === target.search
        && pending.fragment === target.fragment
        && pending.href === target.href) return null;
      pending = { ...target };
      // Once dismissed, requests only update this slot: no timers, queue, DOM
      // changes or announcements. Time and frame messages cannot reopen it.
      if (state === "dismissed") return null;
      state = "visible";
      return { ...pending };
    },
    dismiss(): boolean {
      if (state !== "visible") return false;
      state = "dismissed";
      return true;
    },
    // Call only from the parent-owned Review button.
    reopen(): DocumentNavigationTarget | null {
      if (state !== "dismissed" || !pending) return null;
      state = "visible";
      return { ...pending };
    },
    reset() {
      state = "idle";
      pending = null;
    },
  };
}
