import { afterEach, describe, expect, it, vi } from "vitest";

const retention = vi.hoisted(() => ({ purgeExpiredDeployments: vi.fn() }));
vi.mock("../src/retention", () => retention);
import worker from "../src/worker";
import { bindStorage, getObjectText, putObject } from "../src/storage";
import { memoryBucket } from "./helpers/memory-bucket";

afterEach(() => { bindStorage(undefined); vi.clearAllMocks(); });

describe("Worker storage binding", () => {
  it("selects the STORAGE binding of the request's environment, and fails closed without one", async () => {
    const bucket = memoryBucket();
    expect((await worker.request("/health", {}, { STORAGE: bucket })).status).toBe(200);
    await putObject("k", "v");
    expect(await getObjectText("k")).toBe("v");
    expect(bucket.objects.has("k")).toBe(true);
    for (const env of [{}, { STORAGE: "https://r2.example/bucket" }, undefined]) {
      expect((await worker.request("/health", {}, env)).status).toBe(200);
      await expect(getObjectText("k")).rejects.toThrow("Storage binding STORAGE is not configured");
    }
  });

  it("runs the retention purge from the cron trigger with the scheduled environment's bucket", async () => {
    const bucket = memoryBucket();
    bucket.objects.set("seen", { bytes: new TextEncoder().encode("by purge"), uploaded: new Date(0) });
    retention.purgeExpiredDeployments.mockImplementationOnce(async () => ({ purged: 0, failures: await getObjectText("seen") === "by purge" ? 0 : 1 }));
    await worker.scheduled({ cron: "23 3 * * *" }, { STORAGE: bucket });
    expect(retention.purgeExpiredDeployments).toHaveBeenCalledOnce();
    await expect(retention.purgeExpiredDeployments.mock.results[0]!.value).resolves.toEqual({ purged: 0, failures: 0 });
  });

  it("surfaces a failed purge to the scheduler", async () => {
    retention.purgeExpiredDeployments.mockRejectedValueOnce(new Error("Some deployments remain claimed for retry"));
    await expect(worker.scheduled({}, {})).rejects.toThrow("remain claimed");
  });
});
