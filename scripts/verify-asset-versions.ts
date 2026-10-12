import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { MANAGEMENT_SHELL_VERSION } from "../src/routes/management-navigation";
import { MANAGEMENT_QUERY_VERSION, SELECT_VERSION } from "../src/routes/management-asset-versions";
import { COMMENTOR_PARENT_VERSION, LAZY_TREE_VERSION, PRIVATE_VIEWER_VERSION } from "../src/viewer/asset-versions";
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
for (const [path, version] of Object.entries({
  "public/management-pages.js": MANAGEMENT_SHELL_VERSION,
  "public/management-query.js": MANAGEMENT_QUERY_VERSION,
  "public/select.js": SELECT_VERSION,
  "public/lazy-tree.js": LAZY_TREE_VERSION,
  "public/private-viewer.js": PRIVATE_VIEWER_VERSION,
  "public/commentor-parent.js": COMMENTOR_PARENT_VERSION,
})) {
  if (!record && !ledger[path]?.[version]) {
    throw new Error(`${path} v${version} is unrecorded. Rebuild and run pnpm record:assets.`);
  }
  recordAssetVersion(ledger, path, version, createHash("sha256").update(readFileSync(path)).digest("hex"));
}
if (record) writeFileSync(manifest, JSON.stringify(ledger, null, 2) + "\n");
console.log("Asset version hashes verified.");
