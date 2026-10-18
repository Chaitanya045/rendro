import { inspect } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ copyObject: vi.fn(), headObject: vi.fn(), getObjectText: vi.fn(), listAllKeys: vi.fn(), putObject: vi.fn() }));
const log = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../src/minio", () => storage);
vi.mock("../src/logger", () => ({ logger: log }));
import deployments from "../src/routes/deployments";

const marker = "private-storage-diagnostic";
const hash = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
const fault = (httpStatusCode: number) => Object.assign(new Error(marker), { name: "InternalError", $metadata: { httpStatusCode } });
const query = "organizationId=org&projectId=project";
const put = (body = "x") => deployments.request(`/api/rendro/deployments/staging/files/index.html?${query}`, { method: "PUT", body });
const copy = () => deployments.request(`/api/rendro/deployments/staging/copy?${query}`, { method: "POST", body: JSON.stringify({ paths: ["index.html"] }) });

async function expectRetryable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error: "Storage temporarily unavailable", retryable: true });
}

beforeEach(async () => {
  vi.clearAllMocks();
  storage.putObject.mockReset();
  storage.getObjectText.mockReset().mockResolvedValue(JSON.stringify({ version: 1, files: [{ path: "index.html", size: 1, sha256: await hash("x"), contentType: "text/html" }] }));
  storage.headObject.mockReset().mockResolvedValue({ size: 1, metadata: { sha256: await hash("x") } });
  storage.copyObject.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ deployment: { manifestKey: "tenants/org/projects/project/deployments/staging/manifest.json", stagingExpiresAt: Date.now() + 3_600_000, previousDeploymentId: "previous" } }))));
});

describe("transient storage faults on deployment writes", () => {
  it("answers a failed storage write with a marked 503, and the replay stores the same object once more", async () => {
    storage.putObject.mockRejectedValueOnce(fault(500)).mockResolvedValue(undefined);
    await expectRetryable(await put());
    const replay = await put();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ uploaded: "index.html" });
    expect(storage.putObject).toHaveBeenCalledTimes(2);
    const [first, second] = storage.putObject.mock.calls;
    expect(second.slice(0, 4)).toEqual(first.slice(0, 4));
    expect(first.slice(0, 4)).toEqual(["tenants/org/projects/project/deployments/staging/files/index.html", new TextEncoder().encode("x"), "text/html", { sha256: await hash("x") }]);
  });

  it.each([
    ["a throttled write", fault(503)],
    ["a dropped connection", new TypeError("Network connection lost.")],
    ["an aborted request", new DOMException("The operation timed out.", "TimeoutError")],
  ])("maps %s to 503", async (_name, error) => {
    storage.putObject.mockRejectedValueOnce(error);
    await expectRetryable(await put());
  });

  it("maps a failed index read to 503 before anything is stored", async () => {
    storage.getObjectText.mockRejectedValueOnce(fault(503));
    await expectRetryable(await put());
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("maps a failed reuse copy to 503 and the replay copies the same object", async () => {
    storage.copyObject.mockRejectedValueOnce(fault(500)).mockResolvedValue(undefined);
    await expectRetryable(await copy());
    expect((await copy()).status).toBe(200);
    expect(storage.copyObject).toHaveBeenCalledTimes(2);
    expect(storage.copyObject.mock.calls[1].slice(0, 2)).toEqual(storage.copyObject.mock.calls[0].slice(0, 2));
  });

  it("logs only fixed fields for the fault", async () => {
    storage.putObject.mockRejectedValueOnce(fault(503));
    await put();
    expect(log.error).toHaveBeenCalledWith({ category: "StorageError", kind: "service", status: 503 }, "Deployment storage unavailable");
    expect(inspect(log.error.mock.calls, { depth: null })).not.toContain(marker);
  });

  it.each([
    ["a storage denial", fault(403)],
    ["an unrecognised failure", new Error(marker)],
  ])("keeps %s an internal error", async (_name, error) => {
    storage.putObject.mockRejectedValueOnce(error);
    const response = await put();
    expect(response.status).toBe(500);
    expect(response.headers.has("retry-after")).toBe(false);
    expect(await response.json()).toEqual({ error: "Internal server error" });
    expect(log.error).toHaveBeenCalledWith({ errorType: expect.any(String) }, "Deployment request failed");
    expect(inspect(log.error.mock.calls, { depth: null })).not.toContain(marker);
  });
});
