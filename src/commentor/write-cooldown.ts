import { commentQuotaMessage } from "./error-mapping";

const submissions = '[data-testid="commentor-composer-post"], [data-testid="commentor-reply-send"], [data-testid="commentor-edit-save"]';

/** One quota covers threads, replies and edits, including controls recreated by live updates. */
export class CommentWriteCooldown {
  private until = 0;
  private timer: number | undefined;
  private notice: HTMLElement | undefined;
  private message: HTMLElement | undefined;
  private field: (() => HTMLElement | undefined) | undefined;
  private announcements = 0;
  // Present (and empty) before the first announcement so assistive technology registers it.
  private readonly live: HTMLElement;

  constructor(private readonly root: ShadowRoot) {
    this.live = document.createElement("div");
    this.live.className = "quota-live";
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("aria-atomic", "true");
    root.append(this.live);
  }

  get active(): boolean { return Date.now() < this.until; }

  updateButton(button: HTMLButtonElement): void {
    if (this.active) {
      button.dataset.quotaDisabled = "true";
      button.disabled = true;
    } else if (button.dataset.quotaDisabled) {
      delete button.dataset.quotaDisabled;
      button.disabled = button.hasAttribute("aria-busy");
    }
  }

  private updateButtons(): void {
    this.root.querySelectorAll<HTMLButtonElement>(submissions).forEach(button => this.updateButton(button));
  }

  /** `field` finds the draft the reader was typing in; it regains focus when the notice is dismissed. */
  start(delay: number, field?: () => HTMLElement | undefined): void {
    this.reset();
    this.until = Date.now() + delay;
    this.field = field;
    const notice = document.createElement("div");
    notice.className = "toast error comment-quota";
    // The visible countdown changes every second, so it stays out of the live region.
    const message = document.createElement("span");
    message.setAttribute("aria-hidden", "true");
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      notice.hidden = true;
      this.field?.()?.focus();
    });
    notice.append(message, dismiss);
    this.root.append(notice);
    this.notice = notice;
    this.message = message;
    this.tick(true);
  }

  /** Pressing Enter in a draft during a dismissed cooldown shows the reason again. */
  reveal(): void {
    if (this.notice) this.notice.hidden = false;
  }

  private announce(text: string): void {
    this.live.textContent = text + (this.announcements++ % 2 ? "\u00a0" : "");
  }

  private tick = (initial = false): void => {
    if (!this.root.host.isConnected) { this.reset(); return; }
    const seconds = Math.max(0, Math.ceil((this.until - Date.now()) / 1000));
    const text = commentQuotaMessage(seconds);
    this.message!.textContent = text;
    // Announce when the delay starts and once when it ends, never per second.
    if (initial === true || seconds === 0) this.announce(text);
    this.updateButtons();
    if (this.active) this.timer = window.setTimeout(this.tick, Math.min(1000, this.until - Date.now()));
  };

  reset(): void {
    window.clearTimeout(this.timer);
    this.until = 0;
    this.notice?.remove();
    this.notice = undefined;
    this.message = undefined;
    this.field = undefined;
    this.live.textContent = "";
    this.updateButtons();
  }
}
