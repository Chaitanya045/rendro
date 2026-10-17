import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { MANAGEMENT_SHELL_VERSION, renderManagementNavigationRuntime } from "@/routes/management-navigation";

interface PageScope {
  request(path: string, options?: RequestInit): Promise<unknown>;
  preventNavigation(check: (detail: { kind: string }) => boolean): () => void;
}

interface RuntimeUi {
  request: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  createPageScope(): PageScope;
  navigate(href: string): Promise<boolean>;
}

interface DocumentSpec {
  label: string;
  envelope?: boolean;
  organizationId?: string;
  projectId?: string;
  shellVersion?: string;
  userId?: string;
}

interface ResponseLike {
  ok: boolean;
  url: string;
  text(): Promise<string>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ContentMock {
  parent: MainMock | null = null;
  readonly heading = { focus: vi.fn(), tabIndex: 0 };
  readonly classList = { add: vi.fn(), remove: vi.fn(), replace: vi.fn() };
  readonly dialogs: object[] = [];
  innerHTML = "";

  constructor(readonly label: string) {}

  replaceWith(next: ContentMock): void {
    if (!this.parent) return;
    this.parent.current = next;
    next.parent = this.parent;
    this.parent = null;
  }

  querySelector(selector: string): object | null {
    if (selector === "h1") return this.heading;
    if (selector === ".loading-view,.skeleton-table-row" && /loading-view|skeleton-table-row/.test(this.innerHTML)) return {};
    return null;
  }

  querySelectorAll(selector: string): object[] {
    return selector === ":scope > dialog" ? this.dialogs : [];
  }

  append(node: object): void { this.dialogs.push(node); }
  cloneNode(): ContentMock {
    const clone = new ContentMock(this.label);
    clone.innerHTML = this.innerHTML;
    clone.dialogs.push(...this.dialogs);
    return clone;
  }
  removeAttribute(): void {}
  setAttribute(): void {}

  get isConnected(): boolean { return this.parent !== null; }
}

class MainMock {
  current: ContentMock;

  constructor(
    readonly organizationId = "org-a",
    readonly userId = "user-a",
    readonly shellVersion = MANAGEMENT_SHELL_VERSION,
    readonly projectId = "",
  ) {
    this.current = new ContentMock("initial");
    this.current.parent = this;
  }

  getAttribute(name: string): string | null {
    return ({
      "data-cp-organization-id": this.organizationId,
      "data-cp-project-id": this.projectId,
      "data-cp-shell-version": this.shellVersion,
      "data-cp-user-id": this.userId,
    })[name] ?? null;
  }

  querySelector(selector: string): ContentMock | null {
    return selector === ":scope > .cp-content" ? this.current : null;
  }

  append(content: ContentMock): void {
    this.current = content;
    content.parent = this;
  }
}

function navigationRuntime(initialPath = "/organizations/org-a/people", entry: { type?: string; state?: Record<string, unknown> } = {}) {
  const origin = "https://rendro.test";
  const initialUrl = `${origin}${initialPath}`;
  const listeners = new Map<string, (event: { state?: Record<string, unknown> | null }) => void>();
  const parsedDocuments = new Map<string, ReturnType<typeof responseDocument>>();
  const fetchGates: Array<ReturnType<typeof deferred<ResponseLike>>> = [];
  const fetchOptions: RequestInit[] = [];
  const appendedScripts: Array<{ textContent: string; setAttribute(name: string, value: string): void }> = [];
  const main = new MainMock();
  const openDocs = { setAttribute: vi.fn() };
  const importNode = vi.fn((content: ContentMock) => content);
  const replaceLocation = vi.fn();
  const assignLocation = vi.fn();
  let locationUrl = new URL(initialUrl);
  let scrollY = 164;

  const location = {
    get href() { return locationUrl.href; },
    get origin() { return locationUrl.origin; },
    get pathname() { return locationUrl.pathname; },
    get search() { return locationUrl.search; },
    get hash() { return locationUrl.hash; },
    assign(href: string) { assignLocation(href); setLocation(href); },
    replace(href: string) { replaceLocation(href); setLocation(href); },
  };
  function setLocation(href: string): void { locationUrl = new URL(href, locationUrl); }

  const history = {
    scrollRestoration: "auto",
    state: (entry.state ?? null) as Record<string, unknown> | null,
    go: vi.fn(),
    pushState: vi.fn((state: Record<string, unknown>, _title: string, href: string) => {
      history.state = state;
      setLocation(href);
    }),
    replaceState: vi.fn((state: Record<string, unknown>, _title: string, href: string) => {
      history.state = state;
      setLocation(href);
    }),
  };

  const fetchMock = vi.fn((_href: string, options: RequestInit) => {
    const gate = deferred<ResponseLike>();
    fetchGates.push(gate);
    fetchOptions.push(options);
    return gate.promise;
  });
  const baseRequest = vi.fn();
  const ui = {
    request: baseRequest,
    busy: vi.fn(),
    copyText: vi.fn(),
    toast: vi.fn(),
    openDialog: vi.fn(),
    applyTheme: vi.fn(),
    setNav: vi.fn(),
    syncActiveNav: vi.fn(),
    enhancePage: vi.fn(),
  };
  const themeMount = vi.fn();
  const document = {
    activeElement: null as object | null,
    body: {
      append(script: { textContent: string; setAttribute(name: string, value: string): void }) {
        appendedScripts.push(script);
      },
    },
    title: "Initial",
    addEventListener(name: string, callback: (event: { state?: Record<string, unknown> | null }) => void) {
      listeners.set(name, callback);
    },
    createElement(tag: string) {
      if (tag === "div") return new ContentMock("skeleton");
      return { textContent: "", setAttribute: vi.fn() };
    },
    dispatchEvent: vi.fn(() => true),
    importNode,
    querySelector(selector: string) {
      if (selector === ".cp-main[data-cp-route-envelope]") return main;
      if (selector === "[data-cp-open-docs]") return openDocs;
      return null;
    },
    querySelectorAll: vi.fn(() => []),
  };
  class DOMParserMock {
    parseFromString(marker: string): ReturnType<typeof responseDocument> {
      const parsed = parsedDocuments.get(marker);
      if (!parsed) throw new Error(`Missing parsed document ${marker}`);
      return parsed;
    }
  }
  class CustomEventMock {
    constructor(readonly type: string, readonly init: unknown) {}
  }
  const mutationCallbacks = new Set<() => void>();
  class MutationObserverMock {
    constructor(private readonly callback: () => void) {}
    disconnect(): void { mutationCallbacks.delete(this.callback); }
    observe(): void { mutationCallbacks.add(this.callback); }
  }
  const scrollTo = vi.fn((_x: number, y: number) => { scrollY = y; });
  const windowObject = {
    AbortController,
    DOMParser: DOMParserMock,
    RendroTheme: { mount: themeMount },
    RendroUI: ui,
    fetch: fetchMock,
    get scrollY() { return scrollY; },
    scrollTo,
  };
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    CustomEvent: CustomEventMock,
    DOMException,
    DOMParser: DOMParserMock,
    Element: class ElementMock {},
    MutationObserver: MutationObserverMock,
    URL,
    addEventListener: (name: string, callback: (event: { state?: Record<string, unknown> | null }) => void) => listeners.set(name, callback),
    clearTimeout,
    document,
    fetch: fetchMock,
    history,
    location,
    performance: entry.type ? { getEntriesByType: () => [{ type: entry.type }] } : undefined,
    setTimeout,
    window: windowObject,
  });
  vm.runInContext(renderManagementNavigationRuntime("org-a"), context);
  history.pushState.mockClear();
  history.replaceState.mockClear();

  function resolveFetch(index: number, spec: DocumentSpec, responseUrl: string, ok = true): void {
    const marker = `document-${index}`;
    const parsed = responseDocument(spec);
    parsed.content.innerHTML = main.current.innerHTML;
    parsedDocuments.set(marker, parsed);
    fetchGates[index].resolve({ ok, url: responseUrl, text: () => Promise.resolve(marker) });
  }

  return {
    appendedScripts,
    assignLocation,
    document,
    fetchGates,
    fetchMock,
    fetchOptions,
    history,
    importNode,
    initialUrl,
    listeners,
    location,
    main,
    replaceLocation,
    finishRendering() {
      main.current.innerHTML = "";
      [...mutationCallbacks].forEach((callback) => callback());
    },
    resolveFetch,
    observers: () => mutationCallbacks.size,
    setLocation,
    themeMount,
    ui: ui as typeof ui & RuntimeUi,
    window: windowObject,
  };
}

function responseDocument(spec: DocumentSpec) {
  const content = new ContentMock(`incoming:${spec.label}`);
  const nextMain = new MainMock(
    spec.organizationId ?? "org-a",
    spec.userId ?? "user-a",
    spec.shellVersion ?? MANAGEMENT_SHELL_VERSION,
    spec.projectId ?? "",
  );
  nextMain.current = content;
  content.parent = nextMain;
  const pageScript = {
    textContent: `page:${spec.label}`,
    getAttribute: vi.fn(() => null),
  };
  return {
    content,
    title: `Title ${spec.label}`,
    querySelector(selector: string) {
      if (selector === ".cp-main[data-cp-route-envelope]") return spec.envelope === false ? null : nextMain;
      if (selector === "script[data-cp-page-state]") return { textContent: "{}" };
      if (selector === "script[data-cp-page-script]") return pageScript;
      if (selector === "[data-cp-open-docs]") return { getAttribute: () => "/organizations/org-a/projects" };
      return null;
    },
  };
}

async function flushNavigation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("management navigation regressions", () => {
  it("cancels rapid navigation and ignores an older response that arrives last", async () => {
    const runtime = navigationRuntime();
    const publications = `${new URL(runtime.initialUrl).origin}/organizations/org-a/projects/project-a/publications`;
    const shares = `${new URL(runtime.initialUrl).origin}/organizations/org-a/projects/project-a/shares`;

    const older = runtime.ui.navigate(publications);
    const olderSignal = runtime.fetchOptions[0].signal as AbortSignal;
    const newer = runtime.ui.navigate(shares);
    const pendingShares = runtime.main.current;
    expect(olderSignal.aborted).toBe(true);

    runtime.resolveFetch(1, { label: "shares", projectId: "project-a" }, shares);
    await expect(newer).resolves.toBe(true);
    runtime.resolveFetch(0, { label: "publications", projectId: "project-a" }, publications);
    await expect(older).resolves.toBe(false);

    expect(runtime.main.current).toBe(pendingShares);
    expect(runtime.appendedScripts.map((script) => script.textContent)).toEqual(["page:shares"]);
    expect(runtime.replaceLocation).not.toHaveBeenCalled();
  });

  it("retries the same destination while its previous request is still pending", async () => {
    const runtime = navigationRuntime();
    const teams = `${new URL(runtime.initialUrl).origin}/organizations/org-a/teams`;

    const first = runtime.ui.navigate(teams);
    const firstSignal = runtime.fetchOptions[0].signal as AbortSignal;
    const retry = runtime.ui.navigate(teams);
    const pendingRetry = runtime.main.current;
    expect(firstSignal.aborted).toBe(true);
    expect(runtime.fetchMock).toHaveBeenCalledTimes(2);

    runtime.resolveFetch(1, { label: "teams" }, teams);
    await expect(retry).resolves.toBe(true);
    runtime.resolveFetch(0, { label: "stale-teams" }, teams);
    await expect(first).resolves.toBe(false);
    expect(runtime.main.current).toBe(pendingRetry);
    expect(runtime.appendedScripts.map((script) => script.textContent)).toEqual(["page:teams"]);
  });

  it.each([
    ["missing envelope", { envelope: false }],
    ["organization mismatch", { organizationId: "org-b" }],
    ["user mismatch", { userId: "user-b" }],
    ["shell version mismatch", { shellVersion: "outdated" }],
  ] as const)("fails hard without injecting a response with %s", async (_label, invalid) => {
    const runtime = navigationRuntime();
    const destination = `${new URL(runtime.initialUrl).origin}/organizations/org-a/teams`;

    const navigation = runtime.ui.navigate(destination);
    runtime.resolveFetch(0, { label: "untrusted", ...invalid }, destination);

    await expect(navigation).resolves.toBe(false);
    expect(runtime.replaceLocation).toHaveBeenCalledWith(destination);
    expect(runtime.importNode).not.toHaveBeenCalled();
    expect(runtime.appendedScripts).toHaveLength(0);
    expect(runtime.main.current.label).toBe("skeleton");
  });

  it("does not prompt twice for an accepted cross-organization departure", async () => {
    const runtime = navigationRuntime("/organizations/org-a/settings");
    const blocker = vi.fn((detail: { kind: string }) => detail.kind !== "unload");
    runtime.ui.createPageScope().preventNavigation(blocker);
    const navigation = runtime.ui.navigate("/organizations/org-b/settings");
    // Unload is dispatched by a navigation task, not necessarily synchronously.
    await new Promise(resolve => setTimeout(resolve, 10));
    const unload = { state: undefined, preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    runtime.listeners.get("beforeunload")!(unload);
    await expect(navigation).resolves.toBe(true);
    expect(runtime.assignLocation).toHaveBeenCalledExactlyOnceWith("https://rendro.test/organizations/org-b/settings");
    expect(blocker).toHaveBeenCalledOnce();
    expect(blocker.mock.calls[0][0].kind).toBe("navigation");
    expect(unload.preventDefault).not.toHaveBeenCalled();
    // An unrelated close/reload must still protect unsaved edits.
    runtime.listeners.get("beforeunload")!(unload);
    expect(unload.preventDefault).toHaveBeenCalledOnce();
  });

  it("revokes unused unload approval when the user resumes editing after stopping navigation", async () => {
    const runtime = navigationRuntime("/organizations/org-a/settings");
    runtime.ui.createPageScope().preventNavigation(detail => detail.kind !== "unload");
    await runtime.ui.navigate("/organizations/org-b/settings");
    runtime.listeners.get("input")!({});
    const unload = { state: undefined, preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    runtime.listeners.get("beforeunload")!(unload);
    expect(unload.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not start a cross-organization departure when discard is declined", async () => {
    const runtime = navigationRuntime("/organizations/org-a/settings");
    runtime.ui.createPageScope().preventNavigation(() => false);
    await expect(runtime.ui.navigate("/organizations/org-b/settings")).resolves.toBe(false);
    expect(runtime.assignLocation).not.toHaveBeenCalled();
    const unload = { state: undefined, preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    runtime.listeners.get("beforeunload")!(unload);
    expect(unload.preventDefault).toHaveBeenCalledOnce();
  });

  it("reverses a blocked Back, then permits Back and Forward route restoration", async () => {
    const runtime = navigationRuntime();
    const teams = `${new URL(runtime.initialUrl).origin}/organizations/org-a/teams`;
    const initialState = { __rendroManagementIndex: 0, __rendroScrollY: 41 };
    const teamsState = { __rendroManagementIndex: 1, __rendroScrollY: 0 };
    const toTeams = runtime.ui.navigate(teams);
    runtime.resolveFetch(0, { label: "teams" }, teams);
    await toTeams;

    const scope = runtime.ui.createPageScope();
    const removeBlocker = scope.preventNavigation(() => false);
    runtime.setLocation(runtime.initialUrl);
    runtime.listeners.get("popstate")!({ state: initialState });
    expect(runtime.history.go).toHaveBeenCalledWith(1);
    expect(runtime.fetchMock).toHaveBeenCalledTimes(1);

    runtime.setLocation(teams);
    runtime.listeners.get("popstate")!({ state: teamsState });
    removeBlocker();
    runtime.setLocation(runtime.initialUrl);
    runtime.listeners.get("popstate")!({ state: initialState });
    expect(runtime.fetchMock).toHaveBeenCalledTimes(2);
    const pendingBack = runtime.main.current;
    runtime.resolveFetch(1, { label: "people-back" }, runtime.initialUrl);
    await flushNavigation();
    expect(runtime.main.current).toBe(pendingBack);
    expect(runtime.appendedScripts.at(-1)?.textContent).toBe("page:people-back");

    runtime.setLocation(teams);
    runtime.listeners.get("popstate")!({ state: teamsState });
    expect(runtime.fetchMock).toHaveBeenCalledTimes(3);
    const pendingForward = runtime.main.current;
    runtime.resolveFetch(2, { label: "teams-forward" }, teams);
    await flushNavigation();
    expect(runtime.main.current).toBe(pendingForward);
    expect(runtime.appendedScripts.at(-1)?.textContent).toBe("page:teams-forward");
  });

  it("pushes a new entry for a new route or query, replaces for the current route, and leaves same-page fragments to the browser", async () => {
    const runtime = navigationRuntime();
    const origin = new URL(runtime.initialUrl).origin;
    const teams = `${origin}/organizations/org-a/teams`;

    // A new route records the departing scroll on the old entry, then pushes a fresh one.
    const toTeams = runtime.ui.navigate(teams);
    runtime.resolveFetch(0, { label: "teams" }, teams);
    await toTeams;
    expect(runtime.history.replaceState.mock.calls[0]).toEqual([{ __rendroManagementIndex: 0, __rendroScrollY: 164 }, "", runtime.initialUrl]);
    expect(runtime.history.pushState).toHaveBeenCalledExactlyOnceWith({ __rendroManagementIndex: 1, __rendroScrollY: 0 }, "", teams);

    // Repeating the current route replaces its entry; the history length does not grow.
    runtime.history.pushState.mockClear(); runtime.history.replaceState.mockClear();
    const again = runtime.ui.navigate(teams);
    runtime.resolveFetch(1, { label: "teams-again" }, teams);
    await again;
    expect(runtime.history.pushState).not.toHaveBeenCalled();
    expect(runtime.history.replaceState).toHaveBeenCalledWith({ __rendroManagementIndex: 1, __rendroScrollY: 0 }, "", teams);

    // A different query on the same path is a different entry.
    const filtered = `${teams}?view=all`;
    const toQuery = runtime.ui.navigate(filtered);
    runtime.resolveFetch(2, { label: "teams-query" }, filtered);
    await toQuery;
    expect(runtime.history.pushState).toHaveBeenCalledExactlyOnceWith({ __rendroManagementIndex: 2, __rendroScrollY: 0 }, "", filtered);

    // A same-page fragment is the browser's own navigation: no fetch, no router history write.
    runtime.history.pushState.mockClear();
    const fetches = runtime.fetchMock.mock.calls.length;
    await expect(runtime.ui.navigate(`${filtered}#section`)).resolves.toBe(true);
    expect(runtime.assignLocation).toHaveBeenCalledExactlyOnceWith(`${filtered}#section`);
    expect(runtime.fetchMock.mock.calls).toHaveLength(fetches);
    expect(runtime.history.pushState).not.toHaveBeenCalled();
  });

  it("keeps at most one loading observer, and releases it when the page settles, is superseded or signs out", async () => {
    const runtime = navigationRuntime();
    const origin = new URL(runtime.initialUrl).origin;
    const teams = `${origin}/organizations/org-a/teams`, settings = `${origin}/organizations/org-a/settings`;
    expect(runtime.observers()).toBe(0);

    // The skeleton is watched until real content replaces it.
    const toTeams = runtime.ui.navigate(teams);
    expect(runtime.observers()).toBe(1);
    // A newer navigation supersedes it: the old observer is disconnected before the new one starts.
    const toSettings = runtime.ui.navigate(settings);
    expect(runtime.observers()).toBe(1);
    runtime.resolveFetch(0, { label: "stale" }, teams);
    runtime.resolveFetch(1, { label: "settings" }, settings);
    await Promise.all([toTeams, toSettings]);
    runtime.finishRendering();
    expect(runtime.observers()).toBe(0);

    // Signing out while a destination is still loading releases it too.
    void runtime.ui.navigate(teams);
    expect(runtime.observers()).toBe(1);
    runtime.listeners.get("commentor-sign-out")!({});
    expect(runtime.observers()).toBe(0);
  });

  it("preserves a requested fragment and reuses the existing shell/theme mount", async () => {
    const runtime = navigationRuntime();
    const destination = `${new URL(runtime.initialUrl).origin}/organizations/org-a/projects/project-a#deployments`;
    const responseUrl = destination.replace("#deployments", "");

    const navigation = runtime.ui.navigate(destination);
    const pendingProject = runtime.main.current;
    runtime.resolveFetch(0, { label: "project", projectId: "project-a" }, responseUrl);
    await expect(navigation).resolves.toBe(true);

    expect(runtime.location.hash).toBe("#deployments");
    expect(runtime.main.current).toBe(pendingProject);
    expect(runtime.appendedScripts.map((script) => script.textContent)).toEqual(["page:project"]);
    expect(runtime.themeMount).not.toHaveBeenCalled();
    expect(runtime.main.organizationId).toBe("org-a");
    expect(runtime.main.userId).toBe("user-a");
  });

  it("captures outgoing scroll before the skeleton resets it", async () => {
    const runtime = navigationRuntime();
    const teams = `${new URL(runtime.initialUrl).origin}/organizations/org-a/teams`;
    const navigation = runtime.ui.navigate(teams);

    expect(runtime.history.replaceState).toHaveBeenCalledWith(
      expect.objectContaining({ __rendroManagementIndex: 0, __rendroScrollY: 164 }),
      "",
      runtime.initialUrl,
    );
    expect(runtime.window.scrollTo).toHaveBeenCalledWith(0, 0);
    runtime.resolveFetch(0, { label: "teams" }, teams);
    await navigation;
  });

  async function backToSavedScroll(runtime: ReturnType<typeof navigationRuntime>, savedScroll: number) {
    const teams = `${new URL(runtime.initialUrl).origin}/organizations/org-a/teams`;
    const toTeams = runtime.ui.navigate(teams);
    runtime.resolveFetch(0, { label: "teams" }, teams);
    await toTeams;
    runtime.setLocation(runtime.initialUrl);
    runtime.listeners.get("popstate")!({ state: { __rendroManagementIndex: 0, __rendroScrollY: savedScroll } });
    runtime.window.scrollTo.mockClear();
    return runtime;
  }

  it("restores the saved offset once the restored page has rendered", async () => {
    const runtime = await backToSavedScroll(navigationRuntime(), 300);
    runtime.resolveFetch(1, { label: "people-back" }, runtime.initialUrl);
    await flushNavigation();
    expect(runtime.window.scrollTo).not.toHaveBeenCalled();
    runtime.finishRendering();
    expect(runtime.window.scrollTo).toHaveBeenCalledOnce();
    expect(runtime.window.scrollTo).toHaveBeenLastCalledWith(0, 300);
    expect(runtime.window.scrollY).toBe(300);
  });

  it("takes over scroll restoration and keeps the current offset with the history entry when the page is hidden", () => {
    const runtime = navigationRuntime();
    expect(runtime.history.scrollRestoration).toBe("manual");
    runtime.listeners.get("pagehide")!({});
    expect(runtime.history.replaceState).toHaveBeenLastCalledWith(
      expect.objectContaining({ __rendroManagementIndex: 0, __rendroScrollY: 164 }),
      "",
      runtime.initialUrl,
    );
  });

  it.each(["reload", "back_forward"])("restores the entry's offset after a %s", (type) => {
    const runtime = navigationRuntime("/organizations/org-a/people", { type, state: { __rendroManagementIndex: 2, __rendroScrollY: 90 } });
    expect(runtime.window.scrollTo).toHaveBeenCalledOnce();
    expect(runtime.window.scrollTo).toHaveBeenCalledWith(0, 90);
  });

  it.each([["navigate", { __rendroScrollY: 90 }], ["reload", { __rendroScrollY: 0 }]])("does not restore after a %s without a saved offset", (type, state) => {
    const runtime = navigationRuntime("/organizations/org-a/people", { type, state });
    runtime.finishRendering();
    expect(runtime.window.scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the scroll position the user chose while the restored page was loading", async () => {
    const runtime = await backToSavedScroll(navigationRuntime(), 300);
    runtime.listeners.get("wheel")!({});
    runtime.resolveFetch(1, { label: "people-back" }, runtime.initialUrl);
    await flushNavigation();
    runtime.finishRendering();
    expect(runtime.window.scrollTo).not.toHaveBeenCalled();
  });

  it("drops a pending restore when a newer navigation starts", async () => {
    const runtime = await backToSavedScroll(navigationRuntime(), 300);
    const settings = `${new URL(runtime.initialUrl).origin}/organizations/org-a/settings`;
    const next = runtime.ui.navigate(settings);
    runtime.window.scrollTo.mockClear();
    runtime.resolveFetch(1, { label: "ignored" }, runtime.initialUrl);
    runtime.resolveFetch(2, { label: "settings" }, settings);
    await next;
    runtime.finishRendering();
    expect(runtime.window.scrollTo).not.toHaveBeenCalledWith(0, 300);
  });

  it("aborts pending navigation on sign-out and never mounts its late response", async () => {
    const runtime = navigationRuntime();
    const teams = `${new URL(runtime.initialUrl).origin}/organizations/org-a/teams`;
    const navigation = runtime.ui.navigate(teams);
    const signal = runtime.fetchMock.mock.calls[0][1].signal;
    runtime.listeners.get("commentor-sign-out")!({});
    expect(signal?.aborted).toBe(true);
    runtime.resolveFetch(0, { label: "late-private-page" }, teams);
    await expect(navigation).resolves.toBe(false);
    expect(runtime.appendedScripts).toEqual([]);
    expect(runtime.assignLocation).not.toHaveBeenCalled();
    expect(runtime.replaceLocation).not.toHaveBeenCalled();
  });

  it("deduplicates an in-flight scoped GET but fetches it again after settlement", async () => {
    const runtime = navigationRuntime();
    const scope = runtime.ui.createPageScope();
    const gate = deferred<unknown>();
    runtime.ui.request.mockImplementationOnce(() => gate.promise).mockResolvedValueOnce({ sequence: 2 });

    const first = scope.request("/api/data");
    const duplicate = scope.request("/api/data");
    expect(runtime.ui.request).toHaveBeenCalledTimes(1);
    gate.resolve({ sequence: 1 });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([{ sequence: 1 }, { sequence: 1 }]);

    await expect(scope.request("/api/data")).resolves.toEqual({ sequence: 2 });
    expect(runtime.ui.request).toHaveBeenCalledTimes(2);
  });
});
