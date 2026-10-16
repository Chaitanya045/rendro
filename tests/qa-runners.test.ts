import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { subprocessEnv } from "./helpers/subprocess-coverage";

const DEV = "deafening-beagle-38";
const RUN_ID = "0123456789abcdef";
const ORG = "org1";
const fixtures: string[] = [];
afterEach(() => { for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/**
 * Runs a QA runner with a stand-in `pnpm` as the ONLY executable on PATH: it records
 * its arguments and prints a canned answer. No Convex deployment, network or real
 * pnpm can be reached, whatever the runner decides to do.
 */
async function runQa(script: string, args: string[], fake: { stdout?: string; stderr?: string; code?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rendro-qa-runner-"));
  fixtures.push(directory);
  const record = join(directory, "invocations.jsonl");
  const pnpm = join(directory, "pnpm");
  writeFileSync(pnpm, `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(${JSON.stringify(fake.stdout ?? "")});
process.stderr.write(${JSON.stringify(fake.stderr ?? "")});
process.exitCode = ${fake.code ?? 0};
`);
  chmodSync(pnpm, 0o755);
  const child = spawn(process.execPath, [resolve("scripts", script), ...args], { env: subprocessEnv({ PATH: directory }), cwd: directory });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(done => child.on("close", done));
  const invocations = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) : [];
  return { code, stdout, stderr, invocations };
}

const permissionResult = (override: object = {}) => JSON.stringify({
  runId: RUN_ID, checks: [{ name: "owner:read-project", expected: 200, actual: 200, passed: true }],
  passed: 1, total: 1, cleanupDeleted: 4, remaining: 0, cleanupFailed: false, executionError: null, phase: "complete", ...override,
});

it("pins the development deployment the Convex fixtures themselves accept", () => {
  expect(readFileSync("convex/qaPermissionFixtures.ts", "utf8")).toContain(`const DEV_DEPLOYMENT = "${DEV}";`);
  expect(readFileSync("convex/qaWorkspaceFixtures.ts", "utf8")).toContain(`confirmDeployment: v.literal("${DEV}")`);
});

describe("permission QA runner", () => {
  it("targets only the development deployment, repeating its name as the confirmation", async () => {
    const { code, invocations } = await runQa("run-permission-qa.mjs", [], { stdout: permissionResult() });
    expect(code).toBe(0);
    expect(invocations).toEqual([["exec", "convex", "run", "--deployment", DEV, "qaPermissionFixtures:run", JSON.stringify({ confirmDeployment: DEV })]]);
  });

  it("prints only the sanitized fields, ignoring text around the JSON and unknown fields", async () => {
    const { code, stdout, stderr } = await runQa("run-permission-qa.mjs", [], {
      stdout: `Convex noise\n${permissionResult({ sessionToken: "synthetic-session-secret", extra: { nested: true } })}`,
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      runId: RUN_ID, checks: [{ name: "owner:read-project", expected: 200, actual: 200, passed: true }],
      passed: 1, total: 1, cleanupDeleted: 4, remaining: 0, cleanupFailed: false, executionError: null, phase: "complete",
    });
    expect(stdout).not.toContain("synthetic-session-secret");
  });

  it("redacts malformed identifiers, names and phases and replaces execution errors with a fixed message", async () => {
    const { code, stdout } = await runQa("run-permission-qa.mjs", [], { stdout: permissionResult({
      runId: "not-a-run-id", checks: [{ name: "Secret Name With Spaces", expected: "7", actual: "oops", passed: "yes" }],
      executionError: "raw adapter error with session material", phase: "Bad Phase!", passed: 1, total: 1,
    }) });
    const safe = JSON.parse(stdout);
    expect(safe).toMatchObject({
      runId: null, phase: "unknown", executionError: "Fixture execution failed",
      checks: [{ name: "redacted-check-name", expected: 7, actual: null, passed: false }],
    });
    expect(stdout).not.toMatch(/raw adapter error|session material|Secret Name/);
    expect(code).toBe(1);
  });

  it("reports no checks when the result has none", async () => {
    const { code, stdout } = await runQa("run-permission-qa.mjs", [], { stdout: permissionResult({ checks: "none" }) });
    expect(JSON.parse(stdout).checks).toEqual([]);
    expect(code).toBe(0);
  });

  it.each([
    ["a failed check", { passed: 0, total: 1 }],
    ["failed cleanup", { cleanupFailed: true }],
    ["leftover fixtures", { remaining: 3 }],
  ])("exits 1 for %s", async (_name, override) => {
    expect((await runQa("run-permission-qa.mjs", [], { stdout: permissionResult(override) })).code).toBe(1);
  });

  it.each([
    ["a failing pnpm", { stdout: "", stderr: "SECRET-DIAGNOSTIC", code: 1 }],
    ["unparseable output", { stdout: "{not json SECRET-DIAGNOSTIC" }],
  ])("withholds raw diagnostics after %s", async (_name, fake) => {
    const { code, stdout, stderr } = await runQa("run-permission-qa.mjs", [], fake);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Permission QA could not produce a safe result");
    expect(stderr).not.toContain("SECRET-DIAGNOSTIC");
  });
});

describe("workspace QA runner", () => {
  it.each(["seed", "cleanup"])("targets only the development deployment to %s the named run", async (action) => {
    const { code, stdout, invocations } = await runQa("run-workspace-qa.mjs", [action, ORG, RUN_ID], {
      stdout: `noise\n${JSON.stringify({ users: 3, projects: 2, teams: 1, deletedApplication: 9, deletedUsers: 3, remaining: 0, secret: "synthetic-secret" })}`,
    });
    expect(code).toBe(0);
    expect(invocations).toEqual([["exec", "convex", "run", "--deployment", DEV, `qaWorkspaceFixtures:${action}`,
      JSON.stringify({ confirmDeployment: DEV, organizationId: ORG, runId: RUN_ID })]]);
    expect(JSON.parse(stdout)).toEqual({ action, runId: RUN_ID, organizationId: ORG, users: 3, projects: 2, teams: 1, deletedApplication: 9, deletedUsers: 3, remaining: 0 });
    expect(stdout).not.toContain("synthetic-secret");
  });

  it("copies only numeric counters", async () => {
    const { code, stdout } = await runQa("run-workspace-qa.mjs", ["seed", ORG, RUN_ID], { stdout: JSON.stringify({ users: "3", projects: 2 }) });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ action: "seed", runId: RUN_ID, organizationId: ORG, projects: 2 });
  });

  it("exits 1 when fixtures remain", async () => {
    const { code, stdout } = await runQa("run-workspace-qa.mjs", ["cleanup", ORG, RUN_ID], { stdout: JSON.stringify({ remaining: 2 }) });
    expect(code).toBe(1);
    expect(JSON.parse(stdout).remaining).toBe(2);
  });

  it.each([
    ["an unknown action", ["drop", ORG, RUN_ID]],
    ["no action", []],
    ["an organization id with unsafe characters", ["seed", "ORG; rm", RUN_ID]],
    ["a missing organization id", ["seed"]],
    ["a malformed run id", ["seed", ORG, "NOT-A-RUN"]],
    ["a missing run id", ["seed", ORG]],
  ])("refuses %s before touching pnpm", async (_name, args) => {
    const { code, stderr, invocations } = await runQa("run-workspace-qa.mjs", args, { stdout: "{}" });
    expect(code).not.toBe(0);
    expect(stderr).toContain("Usage: run-workspace-qa.mjs seed|cleanup organizationId runId");
    expect(invocations).toEqual([]);
  });

  it.each([
    ["a failing pnpm", { stderr: "SECRET-DIAGNOSTIC", code: 1 }],
    ["unparseable output", { stdout: "nope SECRET-DIAGNOSTIC" }],
  ])("withholds raw diagnostics after %s", async (_name, fake) => {
    const { code, stdout, stderr } = await runQa("run-workspace-qa.mjs", ["seed", ORG, RUN_ID], fake);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Workspace fixture action failed");
    expect(stderr).not.toContain("SECRET-DIAGNOSTIC");
  });
});
