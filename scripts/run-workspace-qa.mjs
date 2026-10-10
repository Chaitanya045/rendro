import { execFile } from "node:child_process";
import { promisify } from "node:util";
const [action, organizationId, runId] = process.argv.slice(2);
if (!["seed", "cleanup"].includes(action) || !/^[a-z0-9]+$/.test(organizationId ?? "") || !/^[a-f0-9]{16}$/.test(runId ?? "")) throw new Error("Usage: run-workspace-qa.mjs seed|cleanup organizationId runId");
try {
  const { stdout } = await promisify(execFile)("pnpm", ["exec", "convex", "run", "--deployment", "deafening-beagle-38", `qaWorkspaceFixtures:${action}`, JSON.stringify({ confirmDeployment: "deafening-beagle-38", organizationId, runId })], { timeout: 240_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const safe = { action, runId, organizationId };
  for (const key of ["users", "projects", "teams", "deletedApplication", "deletedUsers", "remaining"]) if (typeof result[key] === "number") safe[key] = result[key];
  console.log(JSON.stringify(safe));
  if (result.remaining && result.remaining !== 0) process.exitCode = 1;
} catch {
  console.error("Workspace fixture action failed. Inspect the exact QA organization before retrying; raw diagnostics withheld.");
  process.exitCode = 1;
}
