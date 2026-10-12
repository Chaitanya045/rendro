import { describe, expect, it } from "vitest";
import { recordAssetVersion, verifyAssetHistory, type AssetVersionLedger } from "../scripts/asset-version-ledger";

describe("versioned asset drift guard", () => {
  it("rejects changed bytes at the same version, including when recording", () => {
    const ledger = { "bundle.js": { "19": "old-hash" } };
    expect(() => recordAssetVersion(ledger, "bundle.js", "19", "new-hash")).toThrow("without a version bump");
    expect(ledger["bundle.js"]["19"]).toBe("old-hash");
  });

  it("accepts deterministic rebuilds and appends a bumped version", () => {
    const ledger: AssetVersionLedger = { "bundle.js": { "19": "old-hash" } };
    recordAssetVersion(ledger, "bundle.js", "19", "old-hash");
    recordAssetVersion(ledger, "bundle.js", "20", "new-hash");
    expect(ledger["bundle.js"]).toEqual({ "19": "old-hash", "20": "new-hash" });
    expect(() => verifyAssetHistory(ledger, { "bundle.js": { "19": "old-hash" } })).not.toThrow();
  });

  it.each<AssetVersionLedger>([
    { "bundle.js": { "19": "rewritten-hash" } },
    { "bundle.js": {} },
    {},
  ])("rejects rewriting or deleting previously recorded hashes", ledger => {
    expect(() => verifyAssetHistory(ledger, { "bundle.js": { "19": "old-hash" } })).toThrow("immutable");
  });
});
