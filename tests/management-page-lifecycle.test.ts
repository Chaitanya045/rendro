import vm from "node:vm";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it, vi } from "vitest";

import { MANAGEMENT_SHELL_VERSION, renderManagementNavigationRuntime } from "@/routes/management-navigation";
import publicationPages from "@/routes/publication-pages";
import sharePages from "@/routes/share-pages";

type PageCase = {
  name: string;
  path: string;
  routes: typeof publicationPages;
  requestCount: number;
  loadEnd: string;
};

const pages: PageCase[] = [
  {
    name: "publication",
    path: "/organizations/org/projects/project/publications",
    routes: publicationPages,
    requestCount: 4,
    loadEnd: "  function render(",
  },
  {
    name: "share",
    path: "/organizations/org/projects/project/shares",
    routes: sharePages,
    requestCount: 3,
    loadEnd: "  load(false);",
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadRuntime(page: PageCase) {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "qa", name: "QA", email: "qa@example.test" } as User);
    await next();
  });
  app.route("/", page.routes);
  const html = await (await app.request(page.path)).text();

  const activeStart = html.indexOf("  function active(){");
  const activeEnd = html.indexOf("\n", activeStart);
  const loadStart = html.indexOf("  async function load(");
  const loadEnd = html.indexOf(page.loadEnd, loadStart);
  expect(activeStart).toBeGreaterThan(-1);
  expect(activeEnd).toBeGreaterThan(activeStart);
  expect(loadStart).toBeGreaterThan(-1);
  expect(loadEnd).toBeGreaterThan(loadStart);

  const gate = deferred<unknown>();
  let scopeActive = true;
  const request = vi.fn(() => gate.promise);
  const render = vi.fn();
  const document = {
    getElementById: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn(),
  };
  const list = {
    innerHTML: "initial",
    querySelector: vi.fn(),
  };
  const context = vm.createContext({
    document,
    list,
    loading: "loading",
    loadVersion: 0,
    query: "?organizationId=org&projectId=project",
    render,
    state: { organizationId: "org", projectId: "project", userId: "qa" },
    ui: { request, isActive: () => scopeActive },
  });
  vm.runInContext(
    `${html.slice(activeStart, activeEnd)}\n${html.slice(loadStart, loadEnd)}`,
    context,
  );

  return {
    document,
    gate,
    list,
    render,
    request,
    setScopeActive(value: boolean) { scopeActive = value; },
    startLoad: () => vm.runInContext("load()", context) as Promise<void>,
  };
}

describe("management page request lifecycle", () => {
  it("does not install persistent navigation on onboarding pages with secret-leave protection", () => {
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
    const location = new URL("https://rendro.test/organizations/org/onboarding?projectId=project");
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
    expect(ui.createPageScope).toBeUndefined();
    expect(ui.navigate).toBeUndefined();
    expect(replaceState).not.toHaveBeenCalled();
    expect(documentListeners).not.toHaveBeenCalled();
    expect(windowListeners).not.toHaveBeenCalled();
  });

  it.each(pages)("does not paint a disposed $name page after a successful load", async (page) => {
    const runtime = await loadRuntime(page);
    const completion = runtime.startLoad();
    expect(runtime.request).toHaveBeenCalledTimes(page.requestCount);
    expect(runtime.list.innerHTML).toBe("loading");

    runtime.setScopeActive(false);
    runtime.gate.resolve({});
    await completion;

    expect(runtime.list.innerHTML).toBe("loading");
    expect(runtime.render).not.toHaveBeenCalled();
    expect(runtime.document.querySelectorAll).not.toHaveBeenCalled();
    expect(runtime.document.querySelector).not.toHaveBeenCalled();
    expect(runtime.document.getElementById).not.toHaveBeenCalled();
  });

  it.each(pages)("does not paint a disposed $name page after a rejected load", async (page) => {
    const runtime = await loadRuntime(page);
    const completion = runtime.startLoad();
    expect(runtime.request).toHaveBeenCalledTimes(page.requestCount);
    expect(runtime.list.innerHTML).toBe("loading");

    runtime.setScopeActive(false);
    runtime.gate.reject(new Error("late request failure"));
    await completion;

    expect(runtime.list.innerHTML).toBe("loading");
    expect(runtime.list.querySelector).not.toHaveBeenCalled();
    expect(runtime.render).not.toHaveBeenCalled();
    expect(runtime.document.querySelectorAll).not.toHaveBeenCalled();
    expect(runtime.document.querySelector).not.toHaveBeenCalled();
    expect(runtime.document.getElementById).not.toHaveBeenCalled();
  });
});
