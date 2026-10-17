import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { createOrganizationListCache, installOrganizationListCache, ORGANIZATIONS_STALE_TIME } from "@/management-query/organizations";

const path = "/api/auth/organization/list";
const orgs = [{ id: "org-a", name: "Alpha", slug: "alpha" }];
const identity = { userId: "user-a", origin: "https://rendro.test" };
const caches: ReturnType<typeof createOrganizationListCache>[] = [];
const windows: Window[] = [];
function setup() {
  const raw = vi.fn().mockResolvedValue(orgs), changed = vi.fn();
  const cache = createOrganizationListCache(identity, raw, changed); caches.push(cache);
  return { raw, changed, cache };
}
afterEach(async () => {
  for (const win of windows.splice(0)) { win.dispatchEvent(new win.Event("pagehide")); await win.happyDOM.close(); }
  await Promise.all(caches.splice(0).map(cache => cache.clear())); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("organization display list cache", () => {
  it("reuses fresh reads, strips permission-bearing fields and isolates local mutations", async () => {
    const { cache, raw } = setup(); raw.mockResolvedValue([{ ...orgs[0], role: "owner", members: ["private"] }]);
    const first = await cache.request(path) as typeof orgs; first[0].name = "Local edit";
    expect(await cache.request(path)).toEqual(orgs); expect(raw).toHaveBeenCalledOnce();
  });
  it("deduplicates chooser/menu reads and closing one consumer does not cancel the other", async () => {
    const { cache, raw } = setup(); let finish!: (value: unknown) => void;
    raw.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const menu = cache.request(path, { signal: controller.signal }).catch((error: unknown) => error);
    const chooser = cache.request(path); controller.abort(); finish(orgs);
    expect(await menu).toMatchObject({ name: "AbortError" }); expect(await chooser).toEqual(orgs);
    expect(await cache.request(path)).toEqual(orgs); expect(raw).toHaveBeenCalledOnce();
  });
  it("reuses quick navigation but refreshes external membership changes within 30 seconds", async () => {
    vi.useFakeTimers(); const { cache, raw } = setup(); await cache.request(path);
    expect(ORGANIZATIONS_STALE_TIME).toBe(30_000);
    vi.advanceTimersByTime(29_999); await cache.request(path);
    expect(raw).toHaveBeenCalledOnce();
    raw.mockResolvedValue([]); vi.advanceTimersByTime(1);
    expect(await cache.request(path)).toEqual([]); expect(raw).toHaveBeenCalledTimes(2);
  });
  it.each(["create", "update", "delete", "leave", "accept-invitation", "add-member", "remove-member"])("invalidates after %s", async action => {
    const { cache, raw, changed } = setup(); await cache.request(path);
    await cache.request("/api/auth/organization/" + action, { method: "POST", body: "{}" });
    raw.mockResolvedValue([...orgs, { id: "new", name: "New", slug: "new" }]);
    expect(await cache.request(path)).toHaveLength(2); expect(changed).toHaveBeenCalledTimes(2); expect(raw).toHaveBeenCalledTimes(3);
  });
  it("does not invalidate for unrelated writes or cache authorization reads", async () => {
    const { cache, raw } = setup(); await cache.request(path);
    await cache.request("/api/rendro/projects", { method: "POST" }); await cache.request(path);
    await cache.request("/api/rendro/management/access"); await cache.request("/api/rendro/management/access");
    expect(raw).toHaveBeenCalledTimes(4);
  });
  it("clears on permission failures and does not retain malformed or rejected lists", async () => {
    const { cache, raw } = setup(); await cache.request(path);
    raw.mockRejectedValueOnce(Object.assign(new Error("Denied"), { status: 403 }));
    await expect(cache.request("/api/rendro/management/access")).rejects.toThrow("Denied");
    raw.mockResolvedValueOnce([{ id: 1 }]); await expect(cache.request(path)).rejects.toThrow("Invalid organization list");
    raw.mockRejectedValueOnce(new Error("Offline")); await expect(cache.request(path)).rejects.toThrow("Offline");
    expect(await cache.request(path)).toEqual(orgs); expect(raw).toHaveBeenCalledTimes(5);
  });
  it("prevents a read started before a mutation from restoring an old list", async () => {
    const { cache, raw } = setup(); let finish!: (value: unknown) => void;
    raw.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = cache.request(path).catch((error: unknown) => error);
    await cache.request("/api/auth/organization/update", { method: "POST" }); finish([{ id: "stale", name: "Old" }]);
    expect(await old).toBeInstanceOf(Error); expect(await cache.request(path)).toEqual(orgs);
  });
  it("invalidates even when a mutation result is uncertain and keeps users isolated", async () => {
    const { cache, raw } = setup(); await cache.request(path);
    raw.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(cache.request("/api/auth/organization/create", { method: "POST" })).rejects.toThrow();
    await cache.request(path); expect(raw).toHaveBeenCalledTimes(3);
    const otherRaw = vi.fn().mockResolvedValue([]), other = createOrganizationListCache({ ...identity, userId: "user-b" }, otherRaw); caches.push(other);
    expect(await other.request(path)).toEqual([]); expect(await cache.request(path)).toEqual(orgs);
  });
  it("wires cross-tab invalidation and sign-out without refetching for visibility, reconnect or page exit", async () => {
    const win = new Window({ url: identity.origin }); windows.push(win);
    vi.stubGlobal("window", win); vi.stubGlobal("document", win.document); vi.stubGlobal("Element", win.Element);
    const channels: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("BroadcastChannel", class {
      onmessage = null; postMessage = vi.fn(); close() {} constructor() { channels.push(this); }
    });
    const raw = vi.fn().mockResolvedValue(orgs), request = installOrganizationListCache(identity, raw);
    await request(path); await request(path); expect(raw).toHaveBeenCalledTimes(1);
    channels[0].onmessage!({ data: { userId: "other", kind: "invalidate" } }); await request(path); expect(raw).toHaveBeenCalledTimes(1);
    channels[0].onmessage!({ data: { userId: identity.userId, kind: "invalidate" } }); await request(path); expect(raw).toHaveBeenCalledTimes(2);
    win.dispatchEvent(new win.Event("online")); await request(path); expect(raw).toHaveBeenCalledTimes(2);
    Object.defineProperty(win.document, "hidden", { value: false });
    win.document.dispatchEvent(new win.Event("visibilitychange")); await request(path); expect(raw).toHaveBeenCalledTimes(2);
    await request("/api/auth/organization/create", { method: "POST" });
    expect(channels[0].postMessage).toHaveBeenCalledWith({ userId: identity.userId, kind: "invalidate" });
    await request(path); win.dispatchEvent(new win.Event("pagehide")); await request(path); expect(raw).toHaveBeenCalledTimes(4);
    win.dispatchEvent(new win.Event("commentor-sign-out"));
    expect(channels[0].postMessage).toHaveBeenCalledWith({ userId: identity.userId, kind: "clear" });
    await expect(request(path)).rejects.toMatchObject({ name: "AbortError" });
    expect(raw).toHaveBeenCalledTimes(4);
  });
  it.each(["persisted", "queued", "in-flight"])("clears %s organization data on sign-out and isolates the next account", async phase => {
    vi.useFakeTimers();
    const win = new Window({ url: identity.origin }); windows.push(win);
    vi.stubGlobal("window", win); vi.stubGlobal("document", win.document);
    vi.stubGlobal("sessionStorage", win.sessionStorage);
    vi.stubGlobal("BroadcastChannel", class { onmessage = null; postMessage() {} close() {} });
    const raw = vi.fn().mockResolvedValue(orgs);
    let finish!: (value: unknown) => void;
    if (phase === "in-flight") raw.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const request = installOrganizationListCache(identity, raw);
    const pending = request(path).catch((error: unknown) => error);
    if (phase === "in-flight") await vi.waitFor(() => expect(raw).toHaveBeenCalledOnce());
    else expect(await pending).toEqual(orgs);
    if (phase === "persisted") {
      await vi.runAllTimersAsync();
      expect(win.sessionStorage.length).toBe(1);
    }

    win.dispatchEvent(new win.Event("commentor-sign-out"));
    if (phase === "in-flight") { finish(orgs); expect(await pending).toBeInstanceOf(Error); }
    await vi.runAllTimersAsync();
    expect(win.sessionStorage.length).toBe(0);
    await expect(request(path)).rejects.toMatchObject({ name: "AbortError" });
    expect(raw).toHaveBeenCalledOnce();

    const nextOrgs = [{ id: "org-b", name: "Beta", slug: "beta" }];
    const nextRaw = vi.fn().mockResolvedValue(nextOrgs);
    const next = installOrganizationListCache({ ...identity, userId: "user-b" }, nextRaw);
    expect(await next(path)).toEqual(nextOrgs); expect(nextRaw).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(win.sessionStorage.getItem(win.sessionStorage.key(0)!)).not.toContain("Alpha");
    // Returning to the original account must also fetch, not restore pre-sign-out data.
    const returningRaw = vi.fn().mockResolvedValue([]);
    expect(await installOrganizationListCache(identity, returningRaw)(path)).toEqual([]);
    expect(returningRaw).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it.each([401, 403])("a %s from any organization read removes the persisted list so a reload cannot restore it", async status => {
    vi.useFakeTimers();
    const win = new Window({ url: identity.origin }); windows.push(win);
    vi.stubGlobal("window", win); vi.stubGlobal("document", win.document);
    vi.stubGlobal("sessionStorage", win.sessionStorage);
    vi.stubGlobal("BroadcastChannel", class { onmessage = null; postMessage() {} close() {} });
    const raw = vi.fn().mockResolvedValue(orgs);
    const request = installOrganizationListCache(identity, raw);
    await request(path); await vi.runAllTimersAsync();
    expect(win.sessionStorage.length).toBe(1);

    raw.mockRejectedValueOnce(Object.assign(new Error("Denied"), { status }));
    await expect(request("/api/rendro/management/access")).rejects.toThrow("Denied");
    await vi.runAllTimersAsync();
    expect(win.sessionStorage.length).toBe(0);

    // A fresh page load finds nothing to restore and asks the server again.
    const reloaded = vi.fn().mockResolvedValue([]);
    expect(await installOrganizationListCache(identity, reloaded)(path)).toEqual([]);
    expect(reloaded).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("restores the sanitized list across a full-page navigation and removes it after an organization change", async () => {
    const win = new Window({ url: identity.origin }); windows.push(win);
    vi.stubGlobal("window", win); vi.stubGlobal("document", win.document); vi.stubGlobal("Element", win.Element);
    vi.stubGlobal("sessionStorage", win.sessionStorage);
    vi.stubGlobal("BroadcastChannel", class { onmessage = null; postMessage() {} close() {} });
    const firstRaw = vi.fn().mockResolvedValue([{ ...orgs[0], role: "owner", members: ["private"] }]);
    const first = installOrganizationListCache(identity, firstRaw);
    expect(await first(path)).toEqual(orgs); await new Promise<void>(resolve => setTimeout(resolve, 0));
    const stored = Array.from({ length: win.sessionStorage.length }, (_, index) => win.sessionStorage.getItem(win.sessionStorage.key(index)!)).join("");
    expect(stored).toContain("Alpha"); expect(stored).not.toContain("owner"); expect(stored).not.toContain("private");

    const destinationRaw = vi.fn().mockResolvedValue(orgs), destination = installOrganizationListCache(identity, destinationRaw);
    expect(await destination(path)).toEqual(orgs); expect(destinationRaw).not.toHaveBeenCalled();
    await destination("/api/auth/organization/update", { method: "POST", body: "{}" });
    destinationRaw.mockResolvedValue([{ id: "org-b", name: "Beta", slug: "beta" }]);
    expect(await destination(path)).toEqual([{ id: "org-b", name: "Beta", slug: "beta" }]);
    expect(destinationRaw).toHaveBeenCalledTimes(2);
  });
  describe("restricted browsers", () => {
    function browser(setup: (win: Window) => void) {
      const win = new Window({ url: identity.origin }); windows.push(win);
      vi.stubGlobal("window", win); vi.stubGlobal("document", win.document);
      setup(win);
      const raw = vi.fn().mockResolvedValue(orgs);
      return { win, raw, request: installOrganizationListCache(identity, raw) };
    }
    const blocked = () => ({
      get length(): number { throw new DOMException("Blocked", "SecurityError"); },
      key: () => { throw new DOMException("Blocked", "SecurityError"); },
      getItem: () => { throw new DOMException("Blocked", "SecurityError"); },
      setItem: () => { throw new DOMException("Blocked", "SecurityError"); },
      removeItem: () => { throw new DOMException("Blocked", "SecurityError"); },
    });
    it("keeps in-memory caching, invalidation and sign-out when session storage is blocked", async () => {
      const { win, raw, request } = browser(() => {
        vi.stubGlobal("sessionStorage", blocked());
        vi.stubGlobal("BroadcastChannel", class { onmessage = null; postMessage() {} close() {} });
      });
      expect(await request(path)).toEqual(orgs); expect(await request(path)).toEqual(orgs);
      expect(raw).toHaveBeenCalledOnce();
      await request("/api/auth/organization/update", { method: "POST", body: "{}" });
      await request(path); expect(raw).toHaveBeenCalledTimes(3);
      win.dispatchEvent(new win.Event("commentor-sign-out"));
      await expect(request(path)).rejects.toMatchObject({ name: "AbortError" });
      expect(raw).toHaveBeenCalledTimes(3);
    });
    it("works without BroadcastChannel: mutations still invalidate locally and sign-out still disposes", async () => {
      const { win, raw, request } = browser(window => {
        vi.stubGlobal("sessionStorage", window.sessionStorage);
        vi.stubGlobal("BroadcastChannel", undefined);
      });
      await request(path);
      await expect(request("/api/auth/organization/create", { method: "POST", body: "{}" })).resolves.toBeDefined();
      await request(path); expect(raw).toHaveBeenCalledTimes(3);
      win.dispatchEvent(new win.Event("commentor-sign-out"));
      await expect(request(path)).rejects.toMatchObject({ name: "AbortError" });
    });
    it("survives a BroadcastChannel that cannot be constructed or posted to", async () => {
      const refused = browser(window => {
        vi.stubGlobal("sessionStorage", window.sessionStorage);
        vi.stubGlobal("BroadcastChannel", class { constructor() { throw new DOMException("Denied", "SecurityError"); } });
      });
      await refused.request(path);
      await refused.request("/api/auth/organization/delete", { method: "POST", body: "{}" });
      await refused.request(path); expect(refused.raw).toHaveBeenCalledTimes(3);
      refused.win.dispatchEvent(new refused.win.Event("commentor-sign-out"));
      await expect(refused.request(path)).rejects.toMatchObject({ name: "AbortError" });

      const mute = browser(window => {
        vi.stubGlobal("sessionStorage", window.sessionStorage);
        vi.stubGlobal("BroadcastChannel", class { onmessage = null; close() {} postMessage() { throw new DOMException("Closed", "InvalidStateError"); } });
      });
      await mute.request(path);
      await expect(mute.request("/api/auth/organization/leave", { method: "POST", body: "{}" })).resolves.toBeDefined();
      await mute.request(path); expect(mute.raw).toHaveBeenCalledTimes(3);
      mute.win.dispatchEvent(new mute.win.Event("commentor-sign-out"));
      await expect(mute.request(path)).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});
