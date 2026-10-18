import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bodyAdmission } from "../src/middleware/body-admission";
import { MAX_DEPLOYMENT_FILES, MAX_DEPLOYMENT_BYTES, MAX_FILE_BYTES, MAX_DEPLOYMENT_PATH_LENGTH, MAX_MIME_LENGTH, MAX_COMMIT_LIST_PAGES, validDeploymentCounts, deploymentFileLimitError } from "../shared/deployment-limits";
const storage = vi.hoisted(() => ({ putObject: vi.fn(), getObjectText: vi.fn(), listAllKeys: vi.fn() }));
vi.mock("../src/storage", () => storage);
import deployments from "../src/routes/deployments";
const app = new Hono();
app.use("*", bodyAdmission);
app.route("/", deployments);
const base = { path: "index.html", sha256: "a".repeat(64), size: 1, contentType: "text/html" };
const files = (count: number, size = 0) => Array.from({ length: count }, (_, i) => ({ ...base, path: `${String(i).padStart(4, "0")}.html`, size }));
const identity = { organizationId: "org", projectId: "project" };
const post = (entries: typeof base[]) => {
  const manifest = { version: 1, files: entries };
  return app.request("/api/rendro/deployments/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...identity, manifest, manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") }) });
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ deployment: { deploymentId: "id", manifestKey: "manifest", treeIndexKey: "tree", stagingExpiresAt: Date.now() + 3_600_000 } }))));
});
afterEach(() => vi.unstubAllGlobals());

it("accepts exact and just-below manifest count, file, aggregate, path and MIME boundaries", async () => {
  for (const count of [MAX_DEPLOYMENT_FILES - 1, MAX_DEPLOYMENT_FILES]) expect((await post(files(count))).status).toBe(201);
  for (const size of [MAX_FILE_BYTES - 1, MAX_FILE_BYTES]) expect((await post([{ ...base, size }])).status).toBe(201);
  for (const total of [MAX_DEPLOYMENT_BYTES - 1, MAX_DEPLOYMENT_BYTES]) {
    const entries = files(16, MAX_FILE_BYTES); entries[0].size -= MAX_DEPLOYMENT_BYTES - total;
    expect((await post(entries)).status).toBe(201);
  }
  for (const length of [MAX_DEPLOYMENT_PATH_LENGTH - 1, MAX_DEPLOYMENT_PATH_LENGTH]) expect((await post([{ ...base, path: "p".repeat(length) }])).status).toBe(201);
  for (const length of [MAX_MIME_LENGTH - 1, MAX_MIME_LENGTH]) expect((await post([{ ...base, contentType: "a".repeat(length) }])).status).toBe(201);
});
it("rejects each excessive or unsafe manifest before backend/storage/hash-dependent writes", async () => {
  for (const entries of [files(MAX_DEPLOYMENT_FILES + 1), files(17, MAX_FILE_BYTES), [...files(16, MAX_FILE_BYTES), { ...base, path: "z" }],
    [{ ...base, path: "p".repeat(MAX_DEPLOYMENT_PATH_LENGTH + 1) }], [{ ...base, contentType: "a".repeat(MAX_MIME_LENGTH + 1) }],
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, MAX_FILE_BYTES + 1].map(size => [{ ...base, size }]),
  ]) expect((await post(entries)).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  expect(storage.putObject).not.toHaveBeenCalled();
});
it("validates safe aggregate integers independently of manifest parsing", () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(validDeploymentCounts(value, 1)).toBe(false);
    expect(validDeploymentCounts(1, value)).toBe(false);
  }
  expect(deploymentFileLimitError("a", NaN, "text/html")).toContain("8 MiB");
  expect(validDeploymentCounts(0, 0)).toBe(true);
});
it("passes bounded list budgets at the maximum commit and never activates incomplete storage", async () => {
  const entries = files(MAX_DEPLOYMENT_FILES);
  storage.getObjectText.mockResolvedValue(JSON.stringify({ version: 1, files: entries }));
  const prefix = "tenants/org/projects/project/deployments/id/files/";
  storage.listAllKeys.mockResolvedValue(entries.map(f => prefix + f.path));
  const url = "/api/rendro/deployments/id/commit?" + new URLSearchParams(identity).toString();
  expect((await app.request(url, { method: "POST" })).status).toBe(200);
  expect(storage.listAllKeys).toHaveBeenCalledWith(prefix, { maxKeys: MAX_DEPLOYMENT_FILES, maxPages: MAX_COMMIT_LIST_PAGES });
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.mocked(fetch).mockClear();
  storage.listAllKeys.mockResolvedValue(entries.slice(1).map(f => prefix + f.path));
  expect((await app.request(url, { method: "POST" })).status).toBe(409);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects chunked upload overflow with 413 and never sends a storage write", async () => {
  storage.getObjectText.mockResolvedValue(JSON.stringify({ version: 1, files: [base] }));
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.enqueue(new Uint8Array([2])); c.close(); } });
  expect((await app.request("/api/rendro/deployments/id/files/index.html?" + new URLSearchParams(identity).toString(), { method: "PUT", headers: { "content-length": "1" }, body: stream, duplex: "half" } as RequestInit)).status).toBe(413);
  expect(storage.putObject).not.toHaveBeenCalled();
});
