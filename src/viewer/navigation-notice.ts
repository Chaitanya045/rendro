import { createNavigationConfirmation, type DocumentNavigationTarget } from "./navigation-confirmation";

interface NavigationNoticeOptions {
  /** What the prompt says for a target: the question, the Open button and the Review button. */
  describe: (target: DocumentNavigationTarget) => { question: string; open: string; review: string };
  /** The reader pressed Open. The prompt stays until this clears it. */
  open: (target: DocumentNavigationTarget) => void;
}

/**
 * The parent-owned prompt that gates navigation the reader did not start: one visible prompt that is never retargeted,
 * a Dismiss that collapses it to a Review button, and one silently replaced pending target while dismissed. The caller
 * supplies the wording and what Open does; the shell's stylesheet supplies `.document-navigation-notice`.
 */
export function createNavigationNotice({ describe, open: onOpen }: NavigationNoticeOptions, doc: Document = document) {
  const confirmation = createNavigationConfirmation();
  let current: HTMLElement | undefined;

  function show(target: DocumentNavigationTarget) {
    const words = describe(target);
    const notice = doc.createElement("div");
    notice.id = "document-navigation-notice";
    notice.className = "document-navigation-notice";
    const label = doc.createElement("p");
    label.id = "document-navigation-destination";
    label.setAttribute("role", "status");
    label.style.cssText = "margin:0 0 8px;overflow-wrap:anywhere;max-height:6em;overflow:auto";
    label.textContent = words.question;
    const open = doc.createElement("button");
    open.type = "button";
    open.className = "load-more-btn";
    open.setAttribute("aria-describedby", label.id);
    open.textContent = words.open;
    open.addEventListener("click", () => onOpen(target));
    const dismiss = doc.createElement("button");
    dismiss.type = "button";
    dismiss.className = "load-more-btn";
    dismiss.textContent = "Dismiss";
    dismiss.style.marginLeft = "12px";
    dismiss.addEventListener("click", () => {
      if (!confirmation.dismiss()) return;
      const collapsed = doc.createElement("div");
      collapsed.id = "document-navigation-review";
      collapsed.className = "document-navigation-notice";
      const review = doc.createElement("button");
      review.type = "button";
      review.className = "load-more-btn";
      review.textContent = words.review;
      review.addEventListener("click", () => {
        const reopened = confirmation.reopen();
        if (!reopened) return;
        collapsed.remove();
        show(reopened);
        // Focus moves only in response to the reader's explicit parent action.
        current?.querySelector("button")?.focus();
      });
      collapsed.append(review);
      notice.replaceWith(collapsed);
      current = collapsed;
      review.focus();
    });
    notice.append(label, open, dismiss);
    current = notice;
    doc.body.append(notice);
  }

  return {
    offer(target: DocumentNavigationTarget) {
      const requested = confirmation.request(target);
      if (requested) show(requested);
    },
    clear() {
      current?.remove();
      current = undefined;
      confirmation.reset();
    },
  };
}
