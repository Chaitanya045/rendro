import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each(["timeout", "SIGINT", "SIGTERM", "SIGKILL"])("recovers resources when setup is interrupted by %s", async interruption => {
  const directory = await mkdtemp(join(tmpdir(), "rendro-interruption-"));
  directories.push(directory);
  // Catch accidental use of Playwright's shared default test-results directory.
  await mkdir(resolve("test-results"), { recursive: true });
  const siblingOutput = await mkdtemp(resolve("test-results", "interruption-sentinel-"));
  directories.push(siblingOutput);
  const root = join(directory, "runs");
  const state = join(directory, "state.json");
  const container = join(directory, "container");
  const bin = join(directory, "bin");
  await mkdir(bin);
  // Unit suite has no Docker prerequisite. This executable models persistent
  // daemon state across CLI calls; the child process and Playwright are real.
  await writeFile(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = create ]; then touch '${container}'; else rm -f '${container}'; fi\n`, { mode: 0o700 });
  const module = resolve("e2e/resource-journal.ts");
  const setup = join(directory, "setup.ts");
  await writeFile(setup, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { registerResources } from ${JSON.stringify(module)};
export default async function setup() {
  const resources = registerResources(${JSON.stringify(root)});
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  resources.child(child);
  resources.createContainer('interruption-fixture', []);
  writeFileSync(${JSON.stringify(state)}, JSON.stringify({ pid: child.pid, directory: resources.directory }));
  await new Promise(() => {});
}
`);
  const config = join(directory, "playwright.config.ts");
  await writeFile(config, `export default { testDir: ${JSON.stringify(directory)}, testMatch: '*.spec.ts', outputDir: ${JSON.stringify(join(directory, "results"))}, globalSetup: ${JSON.stringify(setup)}, globalTeardown: ${JSON.stringify(resolve("e2e/global-teardown.ts"))}, globalTimeout: ${interruption === "timeout" ? 2500 : 30000}, reporter: 'line' };`);
  // A file is needed for discovery; setup never returns to execute its test.
  await writeFile(join(directory, "never.spec.ts"), `import { test } from ${JSON.stringify(resolve("node_modules/@playwright/test/index.mjs"))}; test('unreachable', () => {});`);
  const child = spawn(process.execPath, [resolve("node_modules/playwright/cli.js"), "test", "--config", config], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const finished = once(child, "exit");
  const sweep = () => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { sweepResources } from ${JSON.stringify(module)}; sweepResources(${JSON.stringify(root)});`],
  { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  try {
    await expect.poll(() => existsSync(state), { timeout: 15000, message: "setup must acquire resources before interruption" }).toBe(true);
    const resources = JSON.parse(await readFile(state, "utf8")) as { pid: number; directory: string };
    expect(existsSync(container)).toBe(true);
    if (interruption !== "timeout") child.kill(interruption as NodeJS.Signals);
    await finished;
    if (interruption === "timeout") expect(output).toContain("Timed out waiting");
    if (interruption === "SIGKILL") {
      expect(existsSync(resources.directory)).toBe(true);
      // A new invocation consumes the same journal left by the killed runner.
      await sweep();
    }
    expect(existsSync(siblingOutput)).toBe(true);
    expect(existsSync(container)).toBe(false);
    expect(existsSync(resources.directory)).toBe(false);
    expect(await readdir(root)).toEqual([]);
    await expect.poll(async () => {
      // A killed orphan may briefly remain a zombie until the host reaps it.
      const result = await run("ps", ["-p", String(resources.pid), "-o", "stat="]).catch(() => ({ stdout: "" }));
      return result.stdout.trim() === "" || result.stdout.trim().startsWith("Z");
    }).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await finished;
    // Preserve the no-leak guarantee even when a regression assertion fails.
    await sweep();
  }
}, 30000);
