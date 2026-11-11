/**
 * What keeps `pnpm audit` free of exceptions (#347, #349).
 *
 * Better Auth < 1.7.7 carries four advisories (Magic Link, OAuth Proxy, device authorization, the PostgreSQL rate
 * limits). They were ignored, as narrow exceptions in `pnpm-workspace.yaml`, until `@convex-dev/better-auth` 0.13
 * supported Better Auth 1.7. Since the upgrade there is none: `tests/audit-exceptions.test.ts` and
 * `pnpm preflight:prod` both read this module, so a Better Auth older than the fix, or any ignored advisory, fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The first Better Auth release that fixes the four advisories above. */
export const FIXED_VERSION = "1.7.7";
const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** `major.minor.patch` of a version, ignoring any pre-release suffix; null when it is not one. */
function core(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `version` is older than `FIXED_VERSION`. A pre-release of the fixed version counts as older. An unreadable version counts as older. */
export function isBeforeFix(version: string | null): boolean {
  const parsed = version === null ? null : core(version);
  if (!parsed) return true;
  const fixed = core(FIXED_VERSION)!;
  for (let i = 0; i < 3; i++) if (parsed[i] !== fixed[i]) return parsed[i]! < fixed[i]!;
  return /^\d+\.\d+\.\d+-/.test((version as string).trim());
}

/** The IDs under `auditConfig.ignoreGhsas` in a `pnpm-workspace.yaml`. */
export function parseIgnoredAdvisories(yaml: string): string[] {
  const ids: string[] = [];
  let inList = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+["']?([^"'\s]+)["']?$/.exec(line);
    if (inList && item) ids.push(item[1]!);
    else inList = /^\s+ignoreGhsas:\s*$/.test(line);
  }
  return ids;
}

/** Every advisory the repository's audit ignores: `pnpm-workspace.yaml`, and `package.json`'s `pnpm.auditConfig` (which must stay empty). */
export function readAuditIgnores(workspace = readFileSync(root("pnpm-workspace.yaml"), "utf8"), manifest = readFileSync(root("package.json"), "utf8")): string[] {
  const audit = (JSON.parse(manifest) as { pnpm?: { auditConfig?: { ignoreGhsas?: string[]; ignoreCves?: string[] } } }).pnpm?.auditConfig;
  return [...parseIgnoredAdvisories(workspace), ...(audit?.ignoreGhsas ?? []), ...(audit?.ignoreCves ?? [])];
}

/** The installed Better Auth version, or null when it is not installed. */
export function readInstalledBetterAuth(manifest = root("node_modules/better-auth/package.json")): string | null {
  try {
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}
