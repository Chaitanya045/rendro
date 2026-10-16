import { commentQuotaMessage } from "./errors";

const submissions = '[data-testid="commentor-composer-post"], [data-testid="commentor-reply-send"]';

/** One quota covers both threads and replies, including controls recreated by live updates. */
export class CommentWriteCooldown {
  private until = 0;
  private timer: number | undefined;
  private notice: HTMLElement | undefined;
  private message: HTMLElement | undefined;

  constructor(private readonly root: ShadowRoot) {}

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

  start(delay: number): void {
    this.reset();
    this.until = Date.now() + delay;
    const notice = document.createElement("div");
    notice.className = "toast error comment-quota";
    const message = document.createElement("span");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    message.setAttribute("aria-atomic", "true");
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => { notice.hidden = true; });
    notice.append(message, dismiss);
    this.root.append(notice);
    this.notice = notice;
    this.message = message;
    this.tick();
  }

  private tick = (): void => {
    if (!this.root.host.isConnected) { this.reset(); return; }
    this.message!.textContent = commentQuotaMessage(Math.max(0, Math.ceil((this.until - Date.now()) / 1000)));
    this.updateButtons();
    if (this.active) this.timer = window.setTimeout(this.tick, Math.min(1000, this.until - Date.now()));
  };

  reset(): void {
    window.clearTimeout(this.timer);
    this.until = 0;
    this.notice?.remove();
    this.notice = undefined;
    this.message = undefined;
    this.updateButtons();
  }
}
