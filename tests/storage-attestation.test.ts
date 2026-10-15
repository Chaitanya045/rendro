import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { signStorageValidation, verifyStorageValidation, type StorageValidation } from "../shared/storage-attestation";

const secret = process.env.CONVEX_INTERNAL_SECRET!;
const commit: StorageValidation = { purpose: "deployment-commit", organizationId: "org", projectId: "project", deploymentId: "deployment", manifestKey: "manifest", manifestSha256: "hash", fileCount: 3 };
const publication: StorageValidation = { ...commit, purpose: "publication-entry", pathPrefix: "docs", entryFile: "index.html", trackingMode: "track_active" };

describe("storage validation proofs", () => {
  it("uses canonical fields, separate purposes and a domain-separated signing key", async () => {
    const token = await signStorageValidation(commit, secret, 100_000);
    expect(await verifyStorageValidation(commit, token, secret, 100_000)).toBe(true);
    expect(await verifyStorageValidation(commit, token, secret, 160_000)).toBe(true);
    expect(await verifyStorageValidation(publication, token, secret, 100_000)).toBe(false);
    const timestamp = "100000";
    const payload = JSON.stringify(["rendro-storage-validation-v1", commit.purpose, commit.organizationId, commit.projectId, commit.deploymentId, commit.manifestKey, commit.manifestSha256, commit.fileCount, timestamp]);
    const rootSigned = `${timestamp}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
    expect(await verifyStorageValidation(commit, rootSigned, secret, 100_000)).toBe(false);
    const derived = createHmac("sha256", secret).update("rendro-storage-validation-key-v1").digest();
    expect(token).toBe(`${timestamp}.${createHmac("sha256", derived).update(payload).digest("hex")}`);
  });
  it("binds every deployment and publication field", async () => {
    const token = await signStorageValidation(publication, secret);
    expect(await verifyStorageValidation(publication, token, secret)).toBe(true);
    for (const field of ["organizationId", "projectId", "deploymentId", "manifestKey", "manifestSha256", "fileCount", "pathPrefix", "entryFile", "trackingMode"] as const) {
      const input = { ...publication, [field]: field === "fileCount" ? 4 : "changed" } as StorageValidation;
      expect(await verifyStorageValidation(input, token, secret), field).toBe(false);
    }
    expect(await verifyStorageValidation(commit, token, secret)).toBe(false);
  });
  it("fails closed for missing configuration, malformed proofs and timestamps outside the validity window", async () => {
    await expect(signStorageValidation(commit, "short")).rejects.toThrow("not configured");
    const token = await signStorageValidation(commit, secret, 100_000);
    for (const bad of [undefined, "", "short"]) expect(await verifyStorageValidation(commit, token, bad, 100_000)).toBe(false);
    for (const bad of [undefined, "", "garbage", `NaN.${"a".repeat(64)}`, `${"1".repeat(17)}.${"a".repeat(64)}`, `100000.${"A".repeat(64)}`]) {
      expect(await verifyStorageValidation(commit, bad, secret, 100_000)).toBe(false);
    }
    for (const now of [99_999, 160_001]) expect(await verifyStorageValidation(commit, token, secret, now)).toBe(false);
    expect(await verifyStorageValidation(commit, token, "wrong-secret".repeat(4), 100_000)).toBe(false);
  });
});
