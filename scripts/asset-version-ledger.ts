export type AssetVersionLedger = Record<string, Record<string, string>>;

// Published versions are immutable. Recording a build may only add a new version.
export function recordAssetVersion(ledger: AssetVersionLedger, path: string, version: string, hash: string): void {
  const versions = ledger[path] ??= {};
  if (versions[version] !== undefined && versions[version] !== hash) {
    throw new Error(`${path} changed without a version bump (v${version}). Bump its version, rebuild, and run pnpm record:assets.`);
  }
  versions[version] = hash;
}

export function verifyAssetHistory(ledger: AssetVersionLedger, base: AssetVersionLedger): void {
  for (const [path, versions] of Object.entries(base)) {
    for (const [version, hash] of Object.entries(versions)) {
      if (ledger[path]?.[version] !== hash) {
        throw new Error(`${path} v${version}: recorded hashes are immutable; add a new version instead.`);
      }
    }
  }
}
