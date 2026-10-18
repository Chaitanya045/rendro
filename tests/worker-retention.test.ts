import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryBucket, r2Error } from "./helpers/memory-bucket";

const log = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock("../src/logger", () => ({ logger: log }));

const SECRET = "r".repeat(32);
const claim = { _id: "deployment", organizationId: "org", projectId: "project", purgeToken: "token" };
const prefix = "tenants/org/projects/project/deployments/deployment/";
const fetchMock = vi.fn<typeof fetch>();

async function load(env: Record<string, string | undefined> = { CONVEX_SITE_URL: "https://retention.invalid", RETENTION_SECRET: SECRET }) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const storage = await import("../src/storage");
  const bucket = memoryBucket();
  storage.bindStorage(bucket);
  const { purgeExpiredDeployments } = await import("../src/retention");
  return { purgeExpiredDeployments, bucket };
}
const seed = (bucket: ReturnType<typeof memoryBucket>, ...keys: string[]) => { for (const key of keys) bucket.objects.set(key, { bytes: new Uint8Array(1), uploaded: new Date(0) }); };
const candidates = (deployments = [claim], cycleComplete = true) => Response.json({ deployments, cycleComplete });
const finalizedBody = (call: number) => JSON.parse(fetchMock.mock.calls[call]![1]?.body as string) as Record<string, unknown>;

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("scheduled deployment purge", () => {
  it("deletes only the claimed deployment's objects across pages, then confirms with the claim token", async () => {
    const { purgeExpiredDeployments, bucket } = await load();
    seed(bucket, ...Array.from({ length: 1500 }, (_, i) => `${prefix}files/${i}`), `${prefix.replace("deployment/", "deployment-2/")}keep`, "tenants/org/projects/project/deployments/other/x");
    fetchMock.mockResolvedValueOnce(candidates([], false)).mockResolvedValueOnce(candidates([claim], false))
      .mockResolvedValueOnce(Response.json({ purged: true })).mockResolvedValueOnce(candidates([], true));
    const list = vi.spyOn(bucket, "list");
    await expect(purgeExpiredDeployments()).resolves.toEqual({ purged: 1, failures: 0 });
    expect([...bucket.objects.keys()].sort()).toEqual([`${prefix.replace("deployment/", "deployment-2/")}keep`, "tenants/org/projects/project/deployments/other/x"]);
    expect(list.mock.calls.map(call => call[0])).toEqual([{ prefix, limit: 1000 }, { prefix, limit: 1000 }, { prefix, limit: 1000 }]);
    expect(finalizedBody(2)).toEqual({ deploymentId: "deployment", purgeToken: "token", objectCount: 1500 });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://retention.invalid/api/rendro/retention/candidates");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "GET", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(fetchMock.mock.calls[2]![0]).toBe("https://retention.invalid/api/rendro/retention/purged");
    expect(log.info).toHaveBeenCalledWith({ deploymentId: "deployment", objectCount: 1500 }, "Retention purged deployment");
  });

  it("finalizes an already-empty prefix with a zero count", async () => {
    const { purgeExpiredDeployments } = await load();
    fetchMock.mockResolvedValueOnce(candidates()).mockResolvedValueOnce(Response.json({ purged: true }));
    await purgeExpiredDeployments();
    expect(finalizedBody(1)).toMatchObject({ objectCount: 0 });
  });

  it("does not finalize a failed deletion, continues the other claims and reports the retry", async () => {
    const { purgeExpiredDeployments, bucket } = await load();
    const second = { ...claim, _id: "second" };
    seed(bucket, `${prefix}a`);
    vi.spyOn(bucket, "delete").mockRejectedValueOnce(r2Error(10003, "delete"));
    fetchMock.mockResolvedValueOnce(candidates([claim, second])).mockResolvedValueOnce(Response.json({ purged: true }));
    await expect(purgeExpiredDeployments()).rejects.toThrow("remain claimed for retry");
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(finalizedBody(1).deploymentId).toBe("second");
    expect(bucket.objects.size).toBe(1);
    // The backend renews the claim; the retry deletes what is left.
    fetchMock.mockResolvedValueOnce(candidates([{ ...claim, purgeToken: "retry" }])).mockResolvedValueOnce(Response.json({ purged: true }));
    await purgeExpiredDeployments();
    expect(bucket.objects.size).toBe(0);
    expect(finalizedBody(3)).toMatchObject({ purgeToken: "retry", objectCount: 1 });
  });

  it.each([["http", "private details"], ["fenced", "private details"], ["truncated", "private details"]])("leaves a retryable claim after a %s failure, without logging details", async failure => {
    const { purgeExpiredDeployments, bucket } = await load();
    fetchMock.mockResolvedValueOnce(candidates());
    if (failure === "truncated") vi.spyOn(bucket, "list").mockResolvedValueOnce({ objects: [], delimitedPrefixes: [], truncated: true, cursor: "next" });
    else fetchMock.mockResolvedValueOnce(failure === "http" ? new Response("private details", { status: 500 }) : Response.json({ purged: false }));
    await expect(purgeExpiredDeployments()).rejects.toThrow("remain claimed for retry");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("private details");
    expect(log.error).toHaveBeenCalledWith({ category: "RetentionRetry", deploymentId: "deployment", errorType: "Error" }, "Retention retry required");
  });

  it("describes a thrown non-error by type only", async () => {
    const { purgeExpiredDeployments } = await load();
    fetchMock.mockResolvedValueOnce(candidates()).mockRejectedValueOnce("secret-in-a-string");
    await expect(purgeExpiredDeployments()).rejects.toThrow("remain claimed for retry");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret-in-a-string");
    expect(log.error).toHaveBeenCalledWith({ category: "RetentionRetry", deploymentId: "deployment", errorType: "string" }, "Retention retry required");
  });

  it("bounds candidate requests even if every scanned page is protected", async () => {
    const { purgeExpiredDeployments } = await load();
    fetchMock.mockImplementation(() => Promise.resolve(candidates([], false)));
    await expect(purgeExpiredDeployments()).resolves.toEqual({ purged: 0, failures: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("stops inside the invocation's subrequest allowance without finalizing partial progress", async () => {
    const { purgeExpiredDeployments, bucket } = await load();
    // Every key is re-created after each delete, so the prefix never drains.
    const realDelete = bucket.delete.bind(bucket);
    seed(bucket, `${prefix}a`);
    vi.spyOn(bucket, "delete").mockImplementation(async keys => { await realDelete(keys); seed(bucket, `${prefix}a`); });
    const list = vi.spyOn(bucket, "list");
    fetchMock.mockResolvedValueOnce(candidates([claim], false));
    await expect(purgeExpiredDeployments()).rejects.toThrow("remain claimed for retry");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(list.mock.calls.length * 2 + 1).toBeLessThanOrEqual(903);
    expect(list.mock.calls.length).toBeGreaterThan(400);
  });

  it.each([false, true])("respects the time budget with storage pending=%s", async pending => {
    const { purgeExpiredDeployments, bucket } = await load();
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const list = vi.spyOn(bucket, "list");
    fetchMock.mockImplementation(() => { now += 600_000; return Promise.resolve(candidates(pending ? [claim] : [], false)); });
    if (pending) await expect(purgeExpiredDeployments()).rejects.toThrow("remain claimed for retry");
    else await purgeExpiredDeployments();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it.each([["CONVEX_SITE_URL", { RETENTION_SECRET: SECRET }], ["RETENTION_SECRET", { CONVEX_URL: "https://x.convex.cloud" }]])("is disabled, loudly, without %s", async (_name, env) => {
    const { purgeExpiredDeployments } = await load({ CONVEX_SITE_URL: undefined, CONVEX_URL: undefined, RETENTION_SECRET: undefined, ...env });
    await expect(purgeExpiredDeployments()).rejects.toThrow("are required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith({ category: "RetentionDisabled" }, expect.any(String));
  });
});
