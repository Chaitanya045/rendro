import { Window, type HTMLButtonElement as HappyButton, type HTMLElement as HappyElement } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CommentWriteCooldown } from "../src/commentor/write-cooldown";

let win: Window;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); void win.happyDOM.close(); });
function fixture() {
  vi.useFakeTimers();
  win = new Window();
  vi.stubGlobal("document", win.document);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<button data-testid="commentor-composer-post">Post</button><button data-testid="commentor-reply-send" aria-busy="true" disabled>Sending</button>';
  const buttons = Array.from(root.querySelectorAll("button"));
  const cooldown = new CommentWriteCooldown(root as unknown as ShadowRoot);
  return { host, root, buttons, cooldown };
}

it("counts down, preserves pending controls, and enables retry without submitting", async () => {
  const { root, buttons, cooldown } = fixture();
  cooldown.start(2100);
  expect(buttons.every(button => button.disabled)).toBe(true);
  expect(root.querySelector('[role="status"]')!.textContent).toContain("3 seconds");
  expect(root.querySelector('[role="status"]')!.getAttribute("aria-live")).toBe("polite");
  await vi.advanceTimersByTimeAsync(1000);
  expect(root.querySelector('.comment-quota')!.textContent).toContain("2 seconds");
  // The live region keeps the start announcement; only the aria-hidden countdown ticked.
  expect(root.querySelector('[role="status"]')!.textContent).toContain("3 seconds");
  // Newly rendered controls must inherit the same quota.
  const next = win.document.createElement("button");
  next.dataset.testid = "commentor-reply-send";
  cooldown.updateButton(next as unknown as HTMLButtonElement);
  root.append(next);
  expect(next.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1100);
  expect(cooldown.active).toBe(false);
  expect(buttons[0].disabled).toBe(false);
  expect(buttons[1].disabled).toBe(true);
  expect(next.disabled).toBe(false);
  expect(root.querySelector('[role="status"]')!.textContent).toContain("You can post comments again now.");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(root.querySelector('.comment-quota')).not.toBeNull();
  cooldown.reset();
  expect(root.querySelector('.comment-quota')).toBeNull();
});

it("dismissal keeps the cooldown, while identity reset or disconnected host stops it", async () => {
  const { host, root, buttons, cooldown } = fixture();
  cooldown.start(1000);
  root.querySelector<HappyButton>('.comment-quota button')!.click();
  expect(root.querySelector<HappyElement>('.comment-quota')!.hidden).toBe(true);
  expect(cooldown.active).toBe(true);
  cooldown.start(2000);
  expect(root.querySelectorAll('.comment-quota')).toHaveLength(1);
  expect(root.querySelector<HappyElement>('.comment-quota')!.hidden).toBe(false);
  cooldown.reset();
  expect(buttons[0].disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(root.querySelector('.comment-quota')).toBeNull();
  cooldown.start(2000);
  host.remove();
  await vi.advanceTimersByTimeAsync(1000);
  expect(cooldown.active).toBe(false);
  expect(root.querySelector('.comment-quota')).toBeNull();
});

it("announces once at the start and once at the end, never per second", async () => {
  const { root, cooldown } = fixture();
  const live = root.querySelector<HappyElement>('[role="status"]')!;
  // The live region exists and is empty before any announcement.
  expect(live.textContent).toBe("");
  const writes: string[] = [];
  new win.MutationObserver(() => writes.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
  cooldown.start(3000);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(writes.map(text => text.trim())).toEqual(["Too many comments right now; try again in 3 seconds.", "You can post comments again now."]);
  expect(live.closest(".comment-quota")).toBeNull();
  expect(root.querySelector('.comment-quota [aria-hidden="true"]')).not.toBeNull();
  // Reset (identity change) is silent: it clears without announcing.
  cooldown.start(1000);
  cooldown.reset();
  expect(live.textContent).toBe("");
});

it("repeats an identical announcement distinguishably and returns focus to the draft on dismissal", () => {
  const { root, cooldown } = fixture();
  const live = root.querySelector<HappyElement>('[role="status"]')!;
  const draft = win.document.createElement("textarea");
  root.append(draft);
  const focus = vi.spyOn(draft, "focus");
  cooldown.start(2000, () => draft as unknown as HTMLElement);
  const first = live.textContent;
  cooldown.start(2000, () => undefined);
  cooldown.start(2000, () => draft as unknown as HTMLElement);
  expect(live.textContent.trim()).toBe(first.trim());
  root.querySelector<HappyButton>('.comment-quota button')!.click();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(root.querySelector<HappyElement>('.comment-quota')!.hidden).toBe(true);
  cooldown.reveal();
  expect(root.querySelector<HappyElement>('.comment-quota')!.hidden).toBe(false);
  cooldown.reset();
  cooldown.reveal();
  expect(root.querySelector('.comment-quota')).toBeNull();
  cooldown.start(1000);
  root.querySelector<HappyButton>('.comment-quota button')!.click();
});
