import "./fixtures/management-page-presentation";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { MANAGEMENT_SHELL_VERSION, renderManagementNavigationRuntime } from "@/routes/management-navigation";

describe("management page request lifecycle", () => {
  it("installs disposable scopes without persistent navigation on onboarding pages with secret-leave protection", () => {
    const ui: Record<string, unknown> = {};
    const windowListeners = vi.fn();
    const documentListeners = vi.fn();
    const replaceState = vi.fn();
    const main = {
      getAttribute: (name: string) => ({
        "data-cp-organization-id": "org",
        "data-cp-shell-version": MANAGEMENT_SHELL_VERSION,
        "data-cp-user-id": "qa",
      })[name] ?? "",
    };
    const location = new URL("https://rendro.test/organizations/org/onboarding");
    const context = {
      AbortController,
      AbortSignal,
      DOMException,
      URL,
      addEventListener: windowListeners,
      document: {
        addEventListener: documentListeners,
        dispatchEvent: vi.fn(),
        querySelector: vi.fn(() => main),
      },
      history: { state: null, replaceState },
      location,
      window: {
        AbortController,
        DOMParser: class DOMParserMock {},
        RendroUI: ui,
        fetch: vi.fn(),
      },
    };

    expect(() => { vm.runInNewContext(renderManagementNavigationRuntime(), context); }).not.toThrow();
    expect(ui.createPageScope).toBeTypeOf("function");
    expect(ui.navigate).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
    expect(documentListeners).not.toHaveBeenCalled();
    expect(windowListeners).toHaveBeenCalledWith("commentor-sign-out", expect.any(Function));
    const scope = (ui.createPageScope as () => { isActive(): boolean; signal: AbortSignal; onCleanup(callback: () => void): void })();
    const cleanup = vi.fn();
    scope.onCleanup(cleanup);
    windowListeners.mock.calls.find(([name]) => name === "commentor-sign-out")![1]();
    expect(scope.isActive()).toBe(false);
    expect(scope.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
