import { bootCommentorParentHost } from "./parent-host";

let dispose: (() => void) | null = null;
function mount(frameAlreadyLoaded = false): void {
  if (!dispose) dispose = bootCommentorParentHost(frameAlreadyLoaded);
}
function unmount(): void {
  dispose?.();
  dispose = null;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => mount(), { once: true });
} else {
  mount();
}
window.addEventListener("pagehide", unmount);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) mount(true);
});
