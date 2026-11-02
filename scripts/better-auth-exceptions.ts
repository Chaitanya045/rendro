/**
 * The narrow `pnpm audit` exception for Better Auth (#347, #349) and what keeps it honest.
 *
 * Better Auth < 1.7.7 carries four advisories about features Rendro does not enable. They are listed in
 * `pnpm-workspace.yaml` (`auditConfig.ignoreGhsas`) until `@convex-dev/better-auth` supports Better Auth >= 1.7.7.
 * `tests/audit-exceptions.test.ts` and `pnpm preflight:prod` both read this module, so the exception cannot be
 * widened, cannot cover an enabled feature, and cannot outlive the upgrade.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The first Better Auth release that fixes every advisory below. */
export const FIXED_VERSION = "1.7.7";
/** Why each exception does not apply. The only IDs the audit may ignore. */
export const AUDIT_EXCEPTIONS: Record<string, string> = {
  "GHSA-965c-763c-88jm": "concerns the Magic Link plugin, which is not enabled",
  "GHSA-r4xp-prcw-77qf": "concerns the OAuth Proxy plugin, which is not enabled",
  "GHSA-q84f-53jg-9ppm": "concerns the device authorization plugin, which is not enabled",
  "GHSA-44jh-23m7-hpcf": "concerns the drizzle and kysely adapters' PostgreSQL rate limits; Rendro uses the Convex adapter",
};

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
