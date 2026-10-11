// Only a non-secret, server-derived user ID belongs in this namespace.
export const COMMENT_RECOVERY_PREFIX = "commentor-operations:";
const OWNER_KEY = "commentor-recovery-user";

export function clearCommentRecovery(storage: Storage): void {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith(COMMENT_RECOVERY_PREFIX) || key === OWNER_KEY) storage.removeItem(key);
  }
}

export function syncCommentRecoveryUser(storage: Storage, userId: string | null): void {
  if (!userId || storage.getItem(OWNER_KEY) !== userId) clearCommentRecovery(storage);
  if (userId) storage.setItem(OWNER_KEY, userId);
}

// Installed on shells with sign-out controls, including pages without a widget.
// Clearing before navigation also prevents BFCache from reviving another user's UI.
export function renderCommentRecoveryLifecycle(userId: string | null): string {
  const id = JSON.stringify(userId).replace(/</g, "\\u003c");
  return `<script>(() => {
    const clear = () => {
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i);
          if (key?.startsWith("commentor-operations:") || key === "commentor-recovery-user") sessionStorage.removeItem(key);
        }
      } catch {}
      window.dispatchEvent(new Event("commentor-sign-out"));
    };
    try {
      const userId = ${id};
      if (!userId || sessionStorage.getItem("commentor-recovery-user") !== userId) clear();
      if (userId) sessionStorage.setItem("commentor-recovery-user", userId);
    } catch {}
    const signOut = (event) => {
      const control = event.target?.closest?.("a[href], form[action]");
      if (!control) return;
      const url = new URL(control.getAttribute("href") || control.getAttribute("action"), location.href);
      if (url.origin === location.origin && url.pathname === "/api/auth/sign-out") clear();
    };
    document.addEventListener("click", signOut, true);
    document.addEventListener("submit", signOut, true);
  })();</script>`;
}
