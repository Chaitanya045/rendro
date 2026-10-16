import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagementQueryCache, managementQueryKey, mutationImpact } from "@/management-query/cache";
import { createOrganizationListCache, installOrganizationListCache } from "@/management-query/organizations";

const identity = { userId: "user-a", organizationId: "org-a", origin: "https://rendro.test" };
const projects = "/api/rendro/projects?organizationId=org-a";
const orgPath = "/api/auth/organization/list";
const orgs = [{ id: "org-a", name: "Alpha", slug: "alpha" }];
const caches: ReturnType<typeof createManagementQueryCache>[] = [];
const orgCaches: ReturnType<typeof createOrganizationListCache>[] = [];
const windows: Window[] = [];
afterEach(async () => {
  caches.splice(0).forEach(cache => cache.clear());
  await Promise.all(orgCaches.splice(0).map(cache => cache.clear()));
  for (const win of windows.splice(0)) await win.happyDOM.close();
  vi.unstubAllGlobals();
});

describe("management query cache edge paths", () => {
  it.each([
    ["a cross-origin target", "https://other.test/api/rendro/publications/remove", { body: JSON.stringify({ projectId: "p" }) }],
    ["another organization's body", "/api/rendro/projects", { body: JSON.stringify({ organizationId: "org-b" }) }],
  ])("conservatively invalidates everything for %s", (_name, path, options) => {
    expect(mutationImpact(path, options, identity)).toEqual({ organizationId: "org-a", resource: "all" });
  });

  it("invalidates every project's publications when the write names no project", () => {
    for (const body of [{}, { projectId: 7 }, { projectId: "" }]) {
      expect(mutationImpact("/api/rendro/publications", { body: JSON.stringify(body) }, identity))
        .toEqual({ organizationId: "org-a", resource: "publications" });
    }
    expect(mutationImpact("/api/rendro/publications", { body: JSON.stringify({ projectId: "p" }) }, identity))
      .toEqual({ organizationId: "org-a", resource: "publications", projectId: "p" });
  });

  it("never caches an unparseable URL", () => {
    expect(managementQueryKey("http://[", identity)).toBeNull();
  });

  it("passes uncacheable requests straight to the transport without authorization", async () => {
    const raw = vi.fn().mockResolvedValue({ ok: true }), authorize = vi.fn();
    const cache = createManagementQueryCache(identity, raw); caches.push(cache);
    const options = { method: "POST" };
    expect(await cache.request("/api/rendro/credentials?organizationId=org-a", options, authorize)).toEqual({ ok: true });
    expect(raw).toHaveBeenCalledWith("/api/rendro/credentials?organizationId=org-a", options);
    expect(authorize).not.toHaveBeenCalled();
    expect(cache.canCache("/api/rendro/credentials?organizationId=org-a")).toBe(false);
  });

  it("does not release retained data to a page aborted while its authorization is pending", async () => {
    const raw = vi.fn().mockResolvedValue({ projects: [] });
    const cache = createManagementQueryCache(identity, raw); caches.push(cache);
    await cache.request(projects, {}, vi.fn().mockResolvedValue(undefined));
    let allow!: () => void;
    const authorize = vi.fn(() => new Promise<void>(resolve => { allow = resolve; }));
    const controller = new AbortController();
    const pending = cache.request(projects, { signal: controller.signal }, authorize).catch((error: unknown) => error);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    controller.abort(); allow();
    expect(await pending).toMatchObject({ name: "AbortError", message: "Page navigation aborted" });
    expect(raw).toHaveBeenCalledOnce();
  });
});

describe("organization list cache edge paths", () => {
  function plain() {
    const raw = vi.fn().mockResolvedValue(orgs);
    const cache = createOrganizationListCache({ userId: "user-a", origin: identity.origin }, raw); orgCaches.push(cache);
    return { raw, cache };
  }

  it.each([{}, "text", null])("rejects a non-array response %j and retains nothing", async response => {
    const { raw, cache } = plain(); raw.mockResolvedValueOnce(response);
    await expect(cache.request(orgPath)).rejects.toThrow("Invalid organization list");
    expect(await cache.request(orgPath)).toEqual(orgs); expect(raw).toHaveBeenCalledTimes(2);
  });

  it.each([null, "org", 3])("rejects the non-object member %j", async value => {
    const { raw, cache } = plain(); raw.mockResolvedValueOnce([value]);
    await expect(cache.request(orgPath)).rejects.toThrow("Invalid organization list");
  });

  it("does not start a request for an already-aborted menu", async () => {
    const { raw, cache } = plain(); const controller = new AbortController(); controller.abort();
    await expect(cache.request(orgPath, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(raw).not.toHaveBeenCalled();
  });

  it("rejects a cached read that an invalidation removed before its consumer resumed", async () => {
    const { raw, cache } = plain(); await cache.request(orgPath);
    const resumed = cache.request(orgPath).catch((error: unknown) => error);
    void cache.invalidate();
    expect(await resumed).toMatchObject({ message: "Organizations changed. Please try again." });
    expect(await cache.request(orgPath)).toEqual(orgs); expect(raw).toHaveBeenCalledTimes(2);
  });

  describe("installed cache", () => {
    function install(options: { signedOut?: boolean; storage?: Storage } = {}) {
      const win = new Window({ url: identity.origin }); windows.push(win);
      if (options.signedOut) win.document.documentElement.dataset.rendroSignedOut = "true";
      vi.stubGlobal("window", win); vi.stubGlobal("document", win.document);
      vi.stubGlobal("sessionStorage", options.storage ?? win.sessionStorage);
      const channels: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
      vi.stubGlobal("BroadcastChannel", class {
        onmessage = null; postMessage = vi.fn(); close = vi.fn(); constructor() { channels.push(this); }
      });
      const raw = vi.fn().mockResolvedValue(orgs);
      return { win, channels, raw, request: installOrganizationListCache({ userId: "user-a", origin: identity.origin }, raw) };
    }

    it("ignores malformed, other-account and unknown broadcasts", async () => {
      const { channels, raw, request } = install();
      await request(orgPath);
      for (const data of [null, "invalidate", { kind: "invalidate" }, { userId: "other", kind: "clear" }, { userId: "user-a", kind: "unknown" }]) {
        channels[0].onmessage!({ data });
      }
      await request(orgPath);
      expect(raw).toHaveBeenCalledOnce(); expect(channels[0].postMessage).not.toHaveBeenCalled();
    });

    it("disposes without echoing when another tab signs the same account out", async () => {
      const { channels, raw, request } = install();
      await request(orgPath);
      channels[0].onmessage!({ data: { userId: "user-a", kind: "clear" } });
      await expect(request(orgPath)).rejects.toMatchObject({ name: "AbortError", message: "Organization list cache disposed" });
      expect(channels[0].postMessage).not.toHaveBeenCalled(); expect(channels[0].close).toHaveBeenCalledOnce();
      expect(raw).toHaveBeenCalledOnce();
    });

    it("starts disposed when the document is already signed out", async () => {
      const { channels, raw, request } = install({ signedOut: true });
      await expect(request(orgPath)).rejects.toMatchObject({ name: "AbortError" });
      expect(raw).not.toHaveBeenCalled(); expect(channels[0].close).toHaveBeenCalledOnce();
      expect(channels[0].postMessage).not.toHaveBeenCalled();
    });

    it("skips persisted keys that vanish while storage is enumerated", async () => {
      const store = new Map<string, string>();
      const storage = {
        get length() { return store.size + 1; },
        key: (index: number) => index < store.size ? [...store.keys()][index] : "vanished",
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
      } as unknown as Storage;
      const { win, request } = install({ storage });
      await request(orgPath);
      await vi.waitFor(() => expect([...store.keys()].some(key => key.startsWith("rendro-organization-list-user-a"))).toBe(true));
      win.dispatchEvent(new win.Event("commentor-sign-out"));
      await vi.waitFor(() => expect([...store.keys()].some(key => key.startsWith("rendro-organization-list-user-a"))).toBe(false));
    });
  });
});
