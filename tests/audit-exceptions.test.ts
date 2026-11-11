import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXED_VERSION, isBeforeFix, parseIgnoredAdvisories, readAuditIgnores, readInstalledBetterAuth } from "../scripts/better-auth-exceptions";

/**
 * The guard behind the audit having no exception (#347, #349): Better Auth must be at least the release that fixes the
 * four advisories once ignored, and neither `pnpm-workspace.yaml` nor `package.json` may ignore any advisory.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const ignored = readAuditIgnores();
const installed = readInstalledBetterAuth();

describe("the audit has no exception (#347, #349)", () => {
  it("ignores no advisory", () => {
    expect(ignored, "remove auditConfig from pnpm-workspace.yaml").toEqual([]);
    expect(readFileSync(join(root, "package.json"), "utf8")).not.toMatch(/"auditConfig"/);
    expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).not.toMatch(/auditConfig|ignoreGhsas/);
  });

  it("installs a Better Auth that fixes the advisories", () => {
    expect(installed, "better-auth is installed").not.toBeNull();
    expect(isBeforeFix(installed), `Better Auth ${installed} predates ${FIXED_VERSION}`).toBe(false);
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
