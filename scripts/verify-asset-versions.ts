import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { versionedBundles } from "../src/routes/versioned-bundles";
import { recordAssetVersion, verifyAssetHistory, type AssetVersionLedger } from "./asset-version-ledger";

const manifest = "scripts/asset-versions.json";
const ledger = JSON.parse(readFileSync(manifest, "utf8")) as AssetVersionLedger;
const record = process.argv.includes("--record");
// CI compares with the PR base / previous push so editing an old hash cannot
// bypass the guard. No git history or network is needed for local hash checks.
const base = process.env.ASSET_VERSION_BASE;
if (base && !/^0+$/.test(base)) {
  const exists = execFileSync("git", ["ls-tree", "--name-only", base, "--", manifest], { encoding: "utf8" }).trim();
  if (exists) {
    const previous = JSON.parse(execFileSync("git", ["show", `${base}:${manifest}`], { encoding: "utf8" })) as AssetVersionLedger;
    verifyAssetHistory(ledger, previous);
  }
}
// The Worker serves a bundle as immutable only for the version listed here, so the ledger and the
// routes share one registry.
for (const [route, version] of Object.entries(versionedBundles)) {
  const path = `public${route}`;
  if (!record && !ledger[path]?.[version]) {
    throw new Error(`${path} v${version} is unrecorded. Rebuild and run pnpm record:assets.`);
  }
  recordAssetVersion(ledger, path, version, createHash("sha256").update(readFileSync(path)).digest("hex"));
}
if (record) writeFileSync(manifest, JSON.stringify(ledger, null, 2) + "\n");
console.log("Asset version hashes verified.");
