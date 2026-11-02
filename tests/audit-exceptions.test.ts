import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAuthOptions } from "../convex/auth";
import { AUDIT_EXCEPTIONS, FIXED_VERSION, isBeforeFix, parseIgnoredAdvisories, readAuditIgnores, readInstalledBetterAuth } from "../scripts/better-auth-exceptions";

/**
 * The guard behind the narrow `pnpm audit` exception for Better Auth (#347, #349): it fails if the exception
 * could ever cover a feature that is enabled, grow beyond its four IDs, or outlive the upgrade.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const ids = Object.keys(AUDIT_EXCEPTIONS);
const ignored = readAuditIgnores();
const installed = readInstalledBetterAuth();

/** Every authored TypeScript file under a directory, without the generated trees. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "_generated" || name.endsWith(".generated.ts")) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("the Better Auth audit exception (#347, #349)", () => {
  it("lists exactly the four recognised advisories, and nothing else", () => {
    expect(ids).toEqual(["GHSA-965c-763c-88jm", "GHSA-r4xp-prcw-77qf", "GHSA-q84f-53jg-9ppm", "GHSA-44jh-23m7-hpcf"]);
    // Anything else, in pnpm-workspace.yaml or in package.json, widens the exception.
    expect(ignored.filter((id) => !ids.includes(id))).toEqual([]);
    expect(new Set(ignored).size).toBe(ignored.length);
    expect(readFileSync(join(root, "package.json"), "utf8")).not.toMatch(/"auditConfig"/);
  });

  it("is dropped when Better Auth 1.7.7 or later is installed", () => {
    expect(installed, "better-auth is installed").not.toBeNull();
    if (!isBeforeFix(installed)) expect(ignored, `Better Auth ${installed} fixes these advisories: remove auditConfig.ignoreGhsas from pnpm-workspace.yaml`).toEqual([]);
  });

  it("does not stand while the Magic Link, OAuth Proxy or device authorization plugin is enabled", () => {
    if (!ignored.length) return;
    // The running configuration: no such plugin instance is registered.
    const plugins = createAuthOptions({ runQuery: () => undefined, runMutation: () => undefined } as never).plugins.map((plugin) => plugin.id);
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins).not.toContain("magic-link");
    expect(plugins).not.toContain("oauth-proxy");
    expect(plugins).not.toContain("device-authorization");
    // The sources: none of the plugins is even imported or named in the Convex code.
    const named = /magic-?link|oauth-?proxy|device-?authori[sz]ation|better-auth\/plugins\/(?:magic|oauth-proxy|device)|@better-auth\/oauth-proxy/i;
    const files = sources(join(root, "convex"));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((file) => named.test(readFileSync(file, "utf8"))).map((file) => file.slice(root.length))).toEqual([]);
  });

  it("reads the version and the exception list correctly", () => {
    expect(installed).toMatch(/^\d+\.\d+\.\d+/);
    expect(parseIgnoredAdvisories("onlyBuiltDependencies:\n  - esbuild\nauditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc # why\n    - \"GHSA-dddd-eeee-ffff\"\n\n  # note\n    - 'GHSA-gggg-hhhh-iiii'\noverrides:\n  - not-an-advisory\n")).toEqual(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff", "GHSA-gggg-hhhh-iiii"]);
    expect(parseIgnoredAdvisories("auditConfig:\n  ignoreGhsas:\n")).toEqual([]);
    expect(readAuditIgnores("auditConfig:\n  ignoreGhsas:\n    - GHSA-a\n", JSON.stringify({ pnpm: { auditConfig: { ignoreGhsas: ["GHSA-b"], ignoreCves: ["CVE-1"] } } }))).toEqual(["GHSA-a", "GHSA-b", "CVE-1"]);
    expect(readAuditIgnores("", "{}")).toEqual([]);
    expect(readAuditIgnores("", JSON.stringify({ pnpm: { auditConfig: {} } }))).toEqual([]);
  });

  it("compares versions against the fixed release", () => {
    expect(FIXED_VERSION).toBe("1.7.7");
    for (const older of ["1.6.23", "1.7.6", "0.9.9", "1.7.7-beta.1", "1.7.7-rc.2", "garbage", null]) expect(isBeforeFix(older), String(older)).toBe(true);
    for (const fixed of ["1.7.7", "1.7.15", "1.8.0", "2.0.0", " 1.7.7 "]) expect(isBeforeFix(fixed), fixed).toBe(false);
  });

  it("reads the installed version from a package manifest, and nothing when it is unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-exceptions-"));
    const write = (name: string, content: string) => { const path = join(dir, name); writeFileSync(path, content); return path; };
    expect(readInstalledBetterAuth(write("ok.json", '{"version":"1.7.9"}'))).toBe("1.7.9");
    expect(readInstalledBetterAuth(write("none.json", "{}"))).toBeNull();
    expect(readInstalledBetterAuth(write("bad.json", "{"))).toBeNull();
    expect(readInstalledBetterAuth(join(dir, "missing.json"))).toBeNull();
  });
});
