import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_REUSED_FILES_PER_REQUEST } from "../shared/deployment-limits";

const storage = vi.hoisted(() => ({ copyObject: vi.fn(), headObject: vi.fn(), getObjectText: vi.fn(), listAllKeys: vi.fn(), putObject: vi.fn() }));
vi.mock("../src/minio", () => storage);
import app from "../src/routes/deployments";

describe("deployment HTTP regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ deployment: { manifestKey: "manifest", previousDeploymentId: "previous" } }))));
    storage.getObjectText.mockResolvedValue(JSON.stringify({ version: 1, files: Array.from({ length: 200 }, (_, index) => ({ path: `${String(index).padStart(3, "0")}.html`, size: 1, sha256: "a".repeat(64) })) }));
    storage.headObject.mockResolvedValue({ size: 1, metadata: { sha256: "a".repeat(64) } });
  });

  it("bounds copy work before storage calls rather than exhausting Worker subrequests", async () => {
    const response = await app.request("/api/rendro/deployments/staging/copy?organizationId=org&projectId=project", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: Array.from({ length: 200 }, (_, index) => `${index}.html`) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `Copy at most ${MAX_REUSED_FILES_PER_REQUEST} files per request; update the Rendro CLI` });
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(storage.copyObject).not.toHaveBeenCalled();
  });

  it("copies a bounded batch with checksum validation and request budget headroom", async () => {
    const response = await app.request("/api/rendro/deployments/staging/copy?organizationId=org&projectId=project", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: Array.from({ length: MAX_REUSED_FILES_PER_REQUEST }, (_, index) => `${String(index).padStart(3, "0")}.html`) }),
    });
    expect(response.status).toBe(200);
    expect(storage.headObject).toHaveBeenCalledTimes(MAX_REUSED_FILES_PER_REQUEST);
    expect(storage.copyObject).toHaveBeenCalledTimes(MAX_REUSED_FILES_PER_REQUEST);
    expect(MAX_REUSED_FILES_PER_REQUEST * 2 + 2).toBeLessThan(50);
  });

  it("forwards the scoped CLI credential and exact failure identity to Convex", async () => {
    const body = JSON.stringify({ organizationId: "org", projectId: "project", deploymentId: "staging", reason: "Upload interrupted" });
    const response = await app.request("/api/rendro/deployments/fail", { method: "POST", headers: { Authorization: "Bearer disposable-test-key", "Content-Type": "application/json", origin: "https://rendro.test", "sec-fetch-site": "same-origin" }, body });
    expect(response.status).toBe(200);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3211/api/rendro/deployments/fail");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer disposable-test-key");
    expect(new Headers(init?.headers).get("origin")).toBe("https://rendro.test");
    expect(new Headers(init?.headers).get("sec-fetch-site")).toBe("same-origin");
    expect(init?.body).toBe(body);
    expect(init?.redirect).toBe("manual");
  });

  it("preserves backend rejection of an invalid CLI failure credential", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Invalid or insufficient API key" }, { status: 401 }));
    const response = await app.request("/api/rendro/deployments/fail", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has("authorization")).toBe(false);
  });
});
