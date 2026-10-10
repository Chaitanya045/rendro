import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Deliberately selects development. Do not forward raw CLI diagnostics: adapter
// validation errors can contain synthetic session material.
const execute = promisify(execFile);
try {
  const { stdout } = await execute("pnpm", [
    "exec", "convex", "run", "--deployment", "deafening-beagle-38",
    "qaPermissionFixtures:run", JSON.stringify({ confirmDeployment: "deafening-beagle-38" }),
  ], { timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  const start = stdout.indexOf("{");
  const result = JSON.parse(stdout.slice(start));
  const safe = {
    runId: /^[a-f0-9]{16}$/.test(result.runId) ? result.runId : null,
    checks: Array.isArray(result.checks) ? result.checks.map((check) => ({
      name: /^[a-z0-9:-]+$/.test(check.name) ? check.name : "redacted-check-name",
      expected: Number(check.expected), actual: Number(check.actual), passed: check.passed === true,
    })) : [],
    passed: Number(result.passed), total: Number(result.total),
    cleanupDeleted: Number(result.cleanupDeleted), remaining: Number(result.remaining),
    cleanupFailed: result.cleanupFailed === true,
    executionError: result.executionError ? "Fixture execution failed" : null,
    phase: /^[a-z-]+$/.test(result.phase) ? result.phase : "unknown",
  };
  console.log(JSON.stringify(safe, null, 2));
  if (safe.executionError || safe.cleanupFailed || safe.remaining !== 0 || safe.passed !== safe.total) process.exitCode = 1;
} catch {
  console.error("Permission QA could not produce a safe result. Inspect fixture counts before retrying; raw CLI diagnostics were withheld.");
  process.exitCode = 1;
}
