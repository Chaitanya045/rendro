import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagementQueryCache, managementQueryKey, mutationImpact, MANAGEMENT_STALE_TIME, MANAGEMENT_GC_TIME } from "@/management-query/cache";

const identity = { userId: "user-a", organizationId: "org-a", origin: "https://rendro.test" };
const path = "/api/rendro/projects?organizationId=org-a";
const project = "/api/rendro/projects/get?organizationId=org-a&projectId=project-a";
const caches: ReturnType<typeof createManagementQueryCache>[] = [];
function setup() {
  const raw = vi.fn().mockResolvedValue({ projects: [{ name: "First" }] });
  const cache = createManagementQueryCache(identity, raw);
  caches.push(cache);
  return { cache, raw, authorize: vi.fn().mockResolvedValue(undefined) };
}
function gate<T>() {
  let resolve!: (data: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { caches.splice(0).forEach((cache) => cache.clear()); vi.useRealTimers(); });

describe("management query cache policy", () => {
  it.each([
    "/api/auth/organization/get-full-organization?organizationId=org-a",
    "/api/auth/organization/list-invitations?organizationId=org-a",
    "/api/rendro/credentials?organizationId=org-a",
    "/api/rendro/shares?organizationId=org-a&projectId=project-a",
    "/api/rendro/projects?organizationId=org-b",
    "/api/rendro/projects?organizationId=org-a&organizationId=org-b",
    "/api/rendro/projects?organizationId=org-a&unexpected=1",
    "/api/rendro/projects?organizationId=org-a&projectId=project-a",
    "/api/rendro/projects/get?organizationId=org-a",
    "/api/rendro/deployments?organizationId=org-a&projectId=p&projectId=q",
    "https://other.test/api/rendro/projects?organizationId=org-a",
    "/organizations/org-a/projects",
  ])("does not cache %s", (url) => {
    expect(managementQueryKey(url, identity)).toBeNull();
  });

  it("keys by identity, organization, endpoint and project, independent of parameter order", () => {
    const key = managementQueryKey(project, identity);
    expect(key).toEqual(managementQueryKey("/api/rendro/projects/get?projectId=project-a&organizationId=org-a", identity));
    expect(key).not.toEqual(managementQueryKey(project, { ...identity, userId: "user-b" }));
    expect(key).not.toEqual(managementQueryKey(project.replace("project-a", "project-b"), identity));
    expect(managementQueryKey(path, { ...identity, userId: "" })).toBeNull();
  });

  it("reuses fresh data, freshly authorizes each hit, and isolates controller mutations", async () => {
    const { cache, raw, authorize } = setup();
    const first = await cache.request(path, {}, authorize) as { projects: { name: string }[] };
    first.projects[0].name = "Local edit";
    expect(await cache.request(path, {}, authorize)).toEqual({ projects: [{ name: "First" }] });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    await cache.request(path, {}, authorize);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("deduplicates simultaneous network reads", async () => {
    const { cache, raw, authorize } = setup();
    const pending = gate<unknown>(); raw.mockReturnValue(pending.promise);
    const one = cache.request(path, {}, authorize), two = cache.request(path, {}, authorize);
    pending.resolve({ projects: [] });
    await Promise.all([one, two]);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("refetches after the freshness window and collects inactive data", async () => {
    vi.useFakeTimers();
    const { cache, raw, authorize } = setup();
    await cache.request(path, {}, authorize);
    await vi.advanceTimersByTimeAsync(MANAGEMENT_STALE_TIME + 1);
    await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MANAGEMENT_GC_TIME + 1);
    await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(3);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("denies cached private data and clears all entries if authorization fails", async () => {
    const { cache, raw, authorize } = setup();
    await cache.request(path, {}, authorize);
    authorize.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(cache.request(path, {}, authorize)).rejects.toThrow("Forbidden");
    await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("does not reuse failed responses or retry failures silently", async () => {
    const { cache, raw, authorize } = setup();
    raw.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(cache.request(path, {}, authorize)).rejects.toThrow("Unavailable");
    expect(raw).toHaveBeenCalledTimes(1);
    await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("discards all retained data after a 401 from any cached endpoint", async () => {
    const { cache, raw, authorize } = setup();
    await cache.request(path, {}, authorize);
    raw.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await expect(cache.request(project, {}, authorize)).rejects.toThrow("Unauthorized");
    await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(3);
  });

  it("does not release data invalidated during the fresh-membership check", async () => {
    const { cache, authorize } = setup();
    await cache.request(path, {}, authorize);
    const auth = gate<void>(); authorize.mockReturnValueOnce(auth.promise);
    const pending = cache.request(path, {}, authorize);
    cache.clear(); auth.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels disposed page reads and never retains a late transport response", async () => {
    const { cache, raw, authorize } = setup();
    const response = gate<unknown>(); raw.mockReturnValueOnce(response.promise);
    const controller = new AbortController();
    const pending = cache.request(path, { signal: controller.signal }, authorize);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); response.resolve({ projects: [{ name: "Stale" }] });
    await rejected;
    expect(await cache.request(path, {}, authorize)).toEqual({ projects: [{ name: "First" }] });
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("does not start a request for an already-aborted page", async () => {
    const { cache, raw, authorize } = setup();
    await expect(cache.request(path, { signal: AbortSignal.abort() }, authorize)).rejects.toMatchObject({ name: "AbortError" });
    expect(raw).not.toHaveBeenCalled();
  });

  it("clear invalidates completed data and cancels pre-mutation reads", async () => {
    const { cache, raw, authorize } = setup();
    await cache.request(path, {}, authorize);
    const response = gate<unknown>(); raw.mockReturnValueOnce(response.promise);
    const pending = cache.request(project, {}, authorize);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    cache.clear(); response.resolve({ project: { name: "Stale" } }); await rejected;
    await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(3);
  });

  it("visibility/reconnect invalidation refreshes the next read without aborting initial loads", async () => {
    const { cache, raw, authorize } = setup();
    const response = gate<unknown>(); raw.mockReturnValueOnce(response.promise);
    const pending = cache.request(path, {}, authorize);
    cache.invalidate(); response.resolve({ projects: [] });
    await expect(pending).resolves.toEqual({ projects: [] });
    cache.invalidate(); await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("project creation invalidates the list but preserves existing project details", async () => {
    const { cache, raw, authorize } = setup();
    await cache.request(path, {}, authorize); await cache.request(project, {}, authorize);
    cache.invalidateMutation("/api/rendro/projects", { method: "POST", body: JSON.stringify({ organizationId: "org-a" }) });
    raw.mockClear(); await cache.request(path, {}, authorize); await cache.request(project, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(1); expect(raw.mock.calls[0][0]).toBe(path);
  });

  it("credential writes don't invalidate unrelated cached data", async () => {
    const { cache, raw, authorize } = setup(); await cache.request(path, {}, authorize);
    cache.invalidateMutation("/api/rendro/credentials/revoke", { method: "POST", body: JSON.stringify({ organizationId: "org-a" }) });
    await cache.request(path, {}, authorize); expect(raw).toHaveBeenCalledTimes(1);
  });

  it("unknown or authorization-changing writes invalidate all retained data", async () => {
    const { cache, raw, authorize } = setup(); await cache.request(path, {}, authorize);
    cache.invalidateMutation("/api/auth/organization/update-member-role", { method: "POST", body: "{}" });
    await cache.request(path, {}, authorize); expect(raw).toHaveBeenCalledTimes(2);
    expect(mutationImpact("/api/unknown", { method: "POST", body: "broken JSON" }, identity).resource).toBe("all");
  });

  it("a team write aborts a read still in flight and the next read is fresh, before and after the write settles", async () => {
    const { cache, raw, authorize } = setup();
    const older = gate<unknown>(); raw.mockReturnValueOnce(older.promise);
    const shared = [cache.request(path, {}, authorize), cache.request(path, {}, authorize)];
    expect(raw).toHaveBeenCalledTimes(1);
    const rejected = shared.map(read => expect(read).rejects.toMatchObject({ name: "AbortError" }));
    cache.invalidateMutation("/api/auth/organization/add-team-member", { method: "POST", body: JSON.stringify({ organizationId: "org-a" }) });
    older.resolve({ projects: [{ name: "Before the write" }] });
    await Promise.all(rejected);
    raw.mockResolvedValueOnce({ projects: [{ name: "After the write" }] });
    await expect(cache.request(path, {}, authorize)).resolves.toEqual({ projects: [{ name: "After the write" }] });
    // The same applies to a read started while the write was pending: the settlement discards it as well.
    const during = gate<unknown>(); raw.mockReturnValueOnce(during.promise);
    const concurrent = expect(cache.request(project, {}, authorize)).rejects.toMatchObject({ name: "AbortError" });
    cache.invalidateMutation("/api/auth/organization/add-team-member", { method: "POST", body: "{}" });
    during.resolve({ project: { name: "Raced" } });
    await concurrent;
    expect(raw).toHaveBeenCalledTimes(3);
  });

  it("ignores other-organization and malformed broadcast impacts", async () => {
    const { cache, raw, authorize } = setup(); await cache.request(path, {}, authorize);
    cache.applyImpact({ organizationId: "org-b", resource: "all" });
    await cache.request(path, {}, authorize); expect(raw).toHaveBeenCalledTimes(1);
  });

  it("targeted invalidation fences already-resolved cached promises waiting on authorization", async () => {
    const { cache, authorize } = setup(); await cache.request(path, {}, authorize);
    const permission = gate<void>(); authorize.mockReturnValueOnce(permission.promise);
    const pending = cache.request(path, {}, authorize);
    cache.invalidateMutation("/api/rendro/projects", { method: "POST", body: "{}" });
    permission.resolve(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("pins the 30 second freshness window and the 5 minute inactive lifetime", async () => {
    vi.useFakeTimers();
    expect(MANAGEMENT_STALE_TIME).toBe(30_000);
    expect(MANAGEMENT_GC_TIME).toBe(300_000);
    const { cache, raw, authorize } = setup();
    await cache.request(path, {}, authorize);
    await vi.advanceTimersByTimeAsync(29_999);
    await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await cache.request(path, {}, authorize);
    expect(raw).toHaveBeenCalledTimes(2);
    // Inactive data survives (and so needs fresh authorization) until the full five minutes have passed.
    const kept = setup(); await kept.cache.request(path, {}, kept.authorize);
    await vi.advanceTimersByTimeAsync(299_999);
    await kept.cache.request(path, {}, kept.authorize);
    expect(kept.authorize).toHaveBeenCalledTimes(1);
    const collected = setup(); await collected.cache.request(path, {}, collected.authorize);
    await vi.advanceTimersByTimeAsync(300_000);
    await collected.cache.request(path, {}, collected.authorize);
    expect(collected.authorize).not.toHaveBeenCalled();
  });

  it("never retains a one-time credential: the write and any seeded copy bypass the cache and leave nothing in diagnostics", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const { cache, raw, authorize } = setup();
      const credentials = "/api/rendro/credentials?organizationId=org-a";
      raw.mockResolvedValue({ rawKey: "rnd_live_secret" });
      expect(cache.canCache("/api/rendro/credentials")).toBe(false);
      expect(cache.canCache(credentials)).toBe(false);
      await cache.request("/api/rendro/credentials", { method: "POST", body: JSON.stringify({ organizationId: "org-a" }) }, authorize);
      cache.invalidateMutation("/api/rendro/credentials", { method: "POST", body: JSON.stringify({ organizationId: "org-a" }) });
      cache.seed(credentials, { rawKey: "rnd_live_secret" });
      await cache.request(credentials, {}, authorize);
      await cache.request(credentials, {}, authorize);
      expect(raw).toHaveBeenCalledTimes(3);
      expect(authorize).not.toHaveBeenCalled();
      for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain("rnd_live_secret");
    } finally { logs.forEach(log => log.mockRestore()); }
  });
});
