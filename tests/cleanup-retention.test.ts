import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";

const mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn(), options: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { constructor(options: unknown) { mocks.options(options); } send = mocks.send; destroy = mocks.destroy; },
  ListObjectsV2Command: class { constructor(public input: unknown) {} },
  DeleteObjectsCommand: class { constructor(public input: unknown) {} },
}));
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { main } from "../scripts/cleanup-retention";

const claim = { _id: "deployment", organizationId: "org", projectId: "project", purgeToken: "token" };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CONVEX_SITE_URL", "https://retention.invalid");
  vi.stubEnv("RETENTION_SECRET", "test-secret");
  for (const key of ["MINIO_BUCKET", "MINIO_REGION", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_FORCE_PATH_STYLE"]) vi.stubEnv(key, undefined);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function response(deployments = [claim], cycleComplete = true) { return Response.json({ deployments, cycleComplete }); }

describe("retention storage runner", () => {
  it("drains empty candidate pages and multiple object pages, verifies emptiness and finalizes with its token", async () => {
    fetchMock.mockResolvedValueOnce(response([], false)).mockResolvedValueOnce(response([claim], false))
      .mockResolvedValueOnce(Response.json({ purged: true })).mockResolvedValueOnce(response([], true));
    mocks.send.mockResolvedValueOnce({ Contents: [{ Key: "a" }, {}], IsTruncated: true }).mockResolvedValueOnce({ Errors: [] })
      .mockResolvedValueOnce({ Contents: [{ Key: "b" }] }).mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await main();
    expect(mocks.send.mock.calls.filter(c => c[0] instanceof ListObjectsV2Command)).toHaveLength(3);
    expect(mocks.send.mock.calls[0][0].input).toEqual({ Bucket: "docs", Prefix: "tenants/org/projects/project/deployments/deployment/", MaxKeys: 1000 });
    expect(mocks.send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectsCommand);
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string)).toEqual({ deploymentId: "deployment", purgeToken: "token", objectCount: 2 });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.options.mock.calls[0][0]).toMatchObject({ region: "us-east-1", forcePathStyle: true, credentials: undefined });
  });

  it("does not finalize per-object errors, continues other claims, and retries idempotently", async () => {
    const second = { ...claim, _id: "second" };
    fetchMock.mockResolvedValueOnce(response([claim, second])).mockResolvedValueOnce(Response.json({ purged: true }));
    mocks.send.mockResolvedValueOnce({ Contents: [{ Key: "remaining" }] }).mockResolvedValueOnce({ Errors: [{ Key: "remaining", Code: "InternalError" }] })
      .mockResolvedValueOnce({ Contents: [] });
    await expect(main()).rejects.toThrow("remain claimed for retry");
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).deploymentId).toBe("second");
    // Retry after the backend renews the claim. Previously deleted keys are absent.
    fetchMock.mockResolvedValueOnce(response([{ ...claim, purgeToken: "retry" }])).mockResolvedValueOnce(Response.json({ purged: true }));
    mocks.send.mockResolvedValueOnce({ Contents: [{ Key: "remaining" }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await main();
    expect(JSON.parse(fetchMock.mock.calls[3][1]?.body as string).purgeToken).toBe("retry");
  });

  it.each(["storage", "http", "fenced", "truncated"])("leaves a retryable claim after %s failure", async failure => {
    fetchMock.mockResolvedValueOnce(response());
    if (failure === "storage") mocks.send.mockRejectedValueOnce(new Error("storage failed"));
    else if (failure === "truncated") mocks.send.mockResolvedValueOnce({ IsTruncated: true });
    else {
      mocks.send.mockResolvedValueOnce({});
      fetchMock.mockResolvedValueOnce(failure === "http" ? new Response("private details", { status: 500 }) : Response.json({ purged: false }));
    }
    await expect(main()).rejects.toThrow("remain claimed for retry");
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private details");
  });

  it("bounds candidate requests even if every scanned page is protected", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response([], false)));
    await main();
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("bounds a huge prefix without finalizing partial progress", async () => {
    fetchMock.mockResolvedValueOnce(response([claim], false));
    mocks.send.mockImplementation(command => Promise.resolve(command instanceof ListObjectsV2Command ? { Contents: [{ Key: "a" }] } : {}));
    await expect(main()).rejects.toThrow("remain claimed for retry");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledTimes(2000);
  });

  it.each([false, true])("respects the time budget with storage pending=%s", async pending => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetchMock.mockImplementation(() => { now += 600_000; return Promise.resolve(response(pending ? [claim] : [], false)); });
    if (pending) await expect(main()).rejects.toThrow("remain claimed for retry");
    else await main();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("uses configured storage credentials and always releases the client after a candidate failure", async () => {
    for (const [key, value] of Object.entries({ MINIO_BUCKET: "bucket", MINIO_REGION: "auto", MINIO_ACCESS_KEY: "access", MINIO_SECRET_KEY: "secret", MINIO_FORCE_PATH_STYLE: "false" })) vi.stubEnv(key, value);
    fetchMock.mockResolvedValueOnce(new Response("private details", { status: 503 }));
    await expect(main()).rejects.toThrow("Retention HTTP 503");
    expect(mocks.options.mock.calls[0][0]).toMatchObject({ region: "auto", forcePathStyle: false, credentials: { accessKeyId: "access", secretAccessKey: "secret" } });
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it.each(["CONVEX_SITE_URL", "RETENTION_SECRET"])("requires %s", async key => {
    vi.stubEnv(key, undefined);
    await expect(main()).rejects.toThrow("are required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not invent partial credentials", async () => {
    vi.stubEnv("MINIO_ACCESS_KEY", "only-access");
    fetchMock.mockResolvedValueOnce(response([]));
    await main();
    expect(mocks.options.mock.calls[0][0].credentials).toBeUndefined();
  });

  it.each([new Error("cli failure"), "cli failure"])("reports executable errors", async failure => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    process.argv = [argv[0], new URL("../scripts/cleanup-retention.ts", import.meta.url).pathname];
    // Vitest's transformed import URL still matches the file URL used by the CLI.
    expect(pathToFileURL(process.argv[1]).href).toContain("cleanup-retention.ts");
    fetchMock.mockRejectedValueOnce(failure);
    try {
      vi.resetModules();
      await import("../scripts/cleanup-retention");
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
    } finally { process.argv = argv; process.exitCode = exitCode; }
  });

  it("is importable without an executable path", async () => {
    const argv = process.argv;
    process.argv = [argv[0]];
    try { vi.resetModules(); await import("../scripts/cleanup-retention"); }
    finally { process.argv = argv; }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
