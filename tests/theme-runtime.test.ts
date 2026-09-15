import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderThemeAssets, sharedThemeRuntime, sharedThemeStyles } from "@/routes/theme";

class ClassListMock {
  values = new Set<string>();
  toggle(name: string, enabled: boolean) { if (enabled) this.values.add(name); else this.values.delete(name); }
  add(name: string) { this.values.add(name); }
  remove(name: string) { this.values.delete(name); }
  contains(name: string) { return this.values.has(name); }
}

class ElementMock {
  classList = new ClassListMock();
  className = "";
  textContent = "";
  dataset: Record<string, string> = {};
  style = { transform: "", values: new Map<string, string>(), setProperty: (key: string, value: string) => this.style.values.set(key, value) };
  attributes = new Map<string, string>();
  children: ElementMock[] = [];
  listeners = new Map<string, Set<() => void>>();
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  append(...children: ElementMock[]) { this.children.push(...children); }
  replaceChildren(...children: ElementMock[]) { this.children = children; }
  addEventListener(type: string, listener: () => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  getBoundingClientRect() { return { left: 10, top: 20, width: 40, height: 40 }; }
}

function themeRuntime(options: { saved?: string | null; dark?: boolean; reduced?: boolean; transitions?: boolean; asyncUpdates?: boolean; animateThrows?: boolean } = {}) {
  let dark = Boolean(options.dark);
  let reducedMotion = Boolean(options.reduced);
  const mediaListeners = new Map<string, Set<() => void>>();
  const windowListeners = new Map<string, Set<(event: { key: string; newValue: string | null }) => void>>();
  const storage = new Map<string, string>();
  if (options.saved) storage.set("commentor-theme", options.saved);
  const root = new ElementMock();
  const animations: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
  const animate = options.animateThrows ? vi.fn(() => { throw new Error("animation failed"); }) : vi.fn(() => {
    const animation = { cancel: vi.fn() };
    animations.push(animation);
    return animation;
  });
  (root as unknown as { animate: typeof animate }).animate = animate;
  const transitions: Array<{ skipTransition: ReturnType<typeof vi.fn>; ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void>; runUpdate(): void; failUpdate(): void }> = [];
  const document = {
    documentElement: root,
    createElement: () => new ElementMock(),
    startViewTransition: options.transitions ? vi.fn((update: () => void) => {
      let resolveUpdate!: () => void;
      let rejectUpdate!: (error: Error) => void;
      let resolveFinished!: () => void;
      const updateCallbackDone = new Promise<void>((resolve, reject) => { resolveUpdate = resolve; rejectUpdate = reject; });
      const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
      const transition = { skipTransition: vi.fn(), ready: Promise.resolve(), finished, updateCallbackDone, runUpdate() { update(); resolveUpdate(); resolveFinished(); }, failUpdate() { rejectUpdate(new Error("snapshot failed")); resolveFinished(); } };
      transitions.push(transition);
      if (!options.asyncUpdates) transition.runUpdate();
      return transition;
    }) : undefined,
  };
  const matchMedia = (query: string) => ({
    get matches() { return query.includes("color-scheme") ? dark : reducedMotion; },
    addEventListener: (_type: string, listener: () => void) => { const set = mediaListeners.get(query) ?? new Set(); set.add(listener); mediaListeners.set(query, set); },
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.get(query)?.delete(listener),
  });
  const windowObject: Record<string, unknown> = {
    matchMedia,
    addEventListener: (type: string, listener: (event: { key: string; newValue: string | null }) => void) => { const set = windowListeners.get(type) ?? new Set(); set.add(listener); windowListeners.set(type, set); },
    removeEventListener: (type: string, listener: (event: { key: string; newValue: string | null }) => void) => windowListeners.get(type)?.delete(listener),
  };
  const context = vm.createContext({
    window: windowObject,
    document,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    innerWidth: 400,
    innerHeight: 800,
    Math,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(sharedThemeRuntime, context);
  const api = windowObject.RendroTheme as { mount(button: ElementMock, onChange?: (mode: string, resolved: string) => void): { apply(mode: string, persist?: boolean, animate?: boolean): void; getMode(): string; destroy(): void }; getMode(): string };
  const legacy = windowObject.RendroUI as { applyTheme(mode: string, persist?: boolean, animate?: boolean): void };
  return { api, legacy, root, storage, animate, animations, transitions, mediaListeners, windowListeners, button: new ElementMock(), document, setDark(value: boolean) { dark = value; }, setReduced(value: boolean) { reducedMotion = value; } };
}

describe("shared theme runtime", () => {
  it("applies the saved/system theme before mount and cycles system → dark → light", () => {
    const runtime = themeRuntime({ dark: true });
    expect(runtime.root.dataset.theme).toBe("system");
    expect(runtime.root.dataset.resolvedTheme).toBe("dark");
    expect(runtime.root.classList.contains("dark")).toBe(true);
    const changes: string[] = [];
    const controller = runtime.api.mount(runtime.button, (mode) => changes.push(mode));
    expect(changes).toEqual(["system"]);
    expect(runtime.button.children[0]?.children[0]?.children.map((icon) => icon.textContent)).toEqual(["contrast", "dark_mode", "light_mode", "contrast"]);
    expect(runtime.button.classList.contains("rendro-theme-control")).toBe(true);
    runtime.button.dispatch("click");
    expect(controller.getMode()).toBe("dark");
    expect(runtime.storage.get("commentor-theme")).toBe("dark");
    expect(runtime.button.attributes.get("aria-label")).toBe("Switch to light theme");
    runtime.button.dispatch("click");
    runtime.button.dispatch("click");
    expect(controller.getMode()).toBe("system");
  });

  it("syncs storage and system changes and supports the legacy external hook", () => {
    const runtime = themeRuntime({ saved: "light" });
    const controller = runtime.api.mount(runtime.button);
    for (const listener of runtime.windowListeners.get("storage") ?? []) listener({ key: "commentor-theme", newValue: "dark" });
    expect(controller.getMode()).toBe("dark");
    runtime.legacy.applyTheme("light", false, false);
    expect(controller.getMode()).toBe("light");
    expect(runtime.api.getMode()).toBe("light");
  });

  it("keeps passive screens synchronized before a control mounts", () => {
    const runtime = themeRuntime();
    for (const listener of runtime.windowListeners.get("storage") ?? []) listener({ key: "commentor-theme", newValue: "dark" });
    expect(runtime.root.dataset.theme).toBe("dark");
    runtime.legacy.applyTheme("system", false, false);
    runtime.setDark(true);
    for (const [query, listeners] of runtime.mediaListeners) {
      if (query.includes("color-scheme")) for (const listener of listeners) listener();
    }
    expect(runtime.root.dataset.resolvedTheme).toBe("dark");
  });

  it("uses direct application for reduced motion and safely supersedes rapid transitions", async () => {
    const reduced = themeRuntime({ reduced: true, transitions: true });
    reduced.api.mount(reduced.button).apply("dark", true, true);
    expect((reduced.document.startViewTransition as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    const runtime = themeRuntime({ transitions: true });
    const controller = runtime.api.mount(runtime.button);
    controller.apply("dark", true, true);
    controller.apply("light", true, true);
    expect(runtime.transitions).toHaveLength(2);
    expect(runtime.transitions[0]?.skipTransition).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(runtime.animate).toHaveBeenCalled();
    expect(runtime.animations[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.root.classList.contains("rendro-theme-rippling")).toBe(false);
  });

  it("releases only the active radial animation after completion or cancellation", async () => {
    const runtime = themeRuntime({ transitions: true });
    const controller = runtime.api.mount(runtime.button);
    controller.apply("dark", true, true);
    await Promise.resolve();
    expect(runtime.animations).toHaveLength(1);
    expect(runtime.animations[0]?.cancel).toHaveBeenCalledTimes(1);

    const pending = themeRuntime({ transitions: true, asyncUpdates: true });
    const pendingController = pending.api.mount(pending.button);
    pendingController.apply("dark", true, true);
    await Promise.resolve();
    expect(pending.animations).toHaveLength(1);
    pendingController.apply("light", false, false);
    expect(pending.animations[0]?.cancel).toHaveBeenCalledTimes(1);
    pending.transitions[0]?.runUpdate();
    await Promise.resolve();
    expect(pending.animations[0]?.cancel).toHaveBeenCalledTimes(1);
  });

  it("cycles intended modes before asynchronous snapshots and recovers from animation failure", async () => {
    const runtime = themeRuntime({ transitions: true, asyncUpdates: true });
    const controller = runtime.api.mount(runtime.button);
    runtime.button.dispatch("click");
    runtime.button.dispatch("click");
    expect(controller.getMode()).toBe("light");
    runtime.transitions[0]?.runUpdate();
    runtime.transitions[1]?.runUpdate();
    await Promise.resolve();
    expect(runtime.root.dataset.theme).toBe("light");
    expect(runtime.transitions[0]?.skipTransition).toHaveBeenCalledTimes(1);

    const failure = themeRuntime({ transitions: true, animateThrows: true });
    failure.api.mount(failure.button).apply("dark", true, true);
    await Promise.resolve();
    expect(failure.root.dataset.theme).toBe("dark");
    expect(failure.transitions[0]?.skipTransition).toHaveBeenCalled();
    expect(failure.root.classList.contains("rendro-theme-rippling")).toBe(false);

    const rejected = themeRuntime({ transitions: true, asyncUpdates: true });
    rejected.api.mount(rejected.button).apply("dark", true, true);
    rejected.transitions[0]?.failUpdate();
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected.root.dataset.theme).toBe("dark");
    expect(rejected.root.classList.contains("rendro-theme-rippling")).toBe(false);
  });

  it("invalidates queued callbacks on direct updates, destruction, and reduced-motion changes", async () => {
    const direct = themeRuntime({ transitions: true, asyncUpdates: true });
    const directController = direct.api.mount(direct.button);
    directController.apply("dark", true, true);
    directController.apply("light", false, false);
    direct.transitions[0]?.runUpdate();
    await Promise.resolve();
    expect(direct.root.dataset.theme).toBe("light");
    expect(direct.storage.has("commentor-theme")).toBe(false);
    expect(direct.transitions[0]?.skipTransition).toHaveBeenCalled();

    const destroyed = themeRuntime({ transitions: true, asyncUpdates: true });
    const destroyedController = destroyed.api.mount(destroyed.button);
    destroyedController.apply("dark", true, true);
    destroyedController.destroy();
    destroyed.transitions[0]?.runUpdate();
    await Promise.resolve();
    expect(destroyed.root.dataset.theme).toBe("system");
    expect(destroyed.storage.has("commentor-theme")).toBe(false);

    const motion = themeRuntime({ transitions: true, asyncUpdates: true });
    const motionController = motion.api.mount(motion.button);
    motionController.apply("dark", true, true);
    motion.setReduced(true);
    for (const [query, listeners] of motion.mediaListeners) {
      if (query.includes("reduced-motion")) for (const listener of listeners) listener();
    }
    motion.transitions[0]?.runUpdate();
    await Promise.resolve();
    expect(motion.root.dataset.theme).toBe("dark");
    expect(motion.storage.get("commentor-theme")).toBe("dark");
    expect(motion.transitions[0]?.skipTransition).toHaveBeenCalled();
    expect(motion.root.classList.contains("rendro-theme-rippling")).toBe(false);
  });

  it("renders embeddable, uniquely scoped assets", () => {
    expect(sharedThemeStyles).toContain(".rendro-theme-control.rendro-theme-control{");
    expect(sharedThemeStyles).toContain("transform 150ms cubic-bezier(.4,0,.2,1)");
    expect(sharedThemeStyles).toContain("rendro-theme-icon-track");
    expect(sharedThemeStyles).toContain("--rendro-theme-x");
    expect(renderThemeAssets()).toContain("<style data-rendro-theme>");
    expect(renderThemeAssets()).toContain("<script data-rendro-theme>");
  });
});
