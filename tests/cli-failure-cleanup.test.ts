import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { buildCliBundle, subprocessEnv } from "./helpers/subprocess-coverage";

it.each([
  ["source", false], ["source", true], ["bundle", false], ["bundle", true],
] as const)("%s reports an exhausted upload budget and cleanup outcome (cleanup exhausted: %s)", async (kind, exhausted) => {
  await mkdir("tmp", { recursive: true });
  const scratch = await mkdtemp(resolve("tmp/cli-cleanup-"));
  const source = join(scratch, "docs");
  await mkdir(source);
  await writeFile(join(source, "index.html"), "<h1>Test</h1>");
  const failures: Array<{ at: number; body: unknown }> = [];
  let commits = 0;
  let deploymentStatus = "staging";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.startsWith("/api/rendro/deployments/check?")) {
        response.end(JSON.stringify({ deployment: null, manifest: null }));
      } else if (request.url === "/api/rendro/deployments/start") {
        response.end(JSON.stringify({ deployment: { deploymentId: "staging" } }));
      } else if (request.url?.includes("/files/")) {
        // Exhausted upload budget: the server asks for longer than the CLI's
        // bounded wait, so the CLI must attempt failure cleanup immediately.
        response.setHeader("Retry-After", "3600");
        response.writeHead(429).end('{"code":"rate_limited"}');
      } else if (request.url === "/api/rendro/deployments/fail") {
        failures.push({ at: Date.now(), body: JSON.parse(Buffer.concat(chunks).toString()) as unknown });
        if (exhausted || failures.length === 1) {
          response.setHeader("Retry-After", "1");
          response.writeHead(429).end('{"code":"rate_limited"}');
        } else {
          deploymentStatus = "failed";
          response.end('{"status":true}');
        }
      } else if (request.url?.includes("/commit?")) {
        commits++;
        response.end("{}");
      } else response.writeHead(404).end("{}");
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const executable = kind === "source" ? resolve("node_modules/.bin/tsx") : process.execPath;
    const entry = kind === "source" ? "cli/src/index.ts" : join(scratch, "rendro.mjs");
    if (kind === "bundle") {
      await buildCliBundle(entry);
    }
    const result = await promisify(execFile)(executable, [entry, "push", "--source", source, "--organization", "org", "--project", "project", "--endpoint", endpoint], {
      env: subprocessEnv({ ...process.env, RENDRO_API_KEY: "disposable-test-key" }), timeout: 15_000,
    }).then(output => ({ ...output, code: 0 }), (error: { code: number; stdout: string; stderr: string }) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Upload failed for index.html: 429 Rate limited");
    expect(result.stderr).toContain("Rate limited (429). Retrying");
    expect(result.stdout).not.toContain("Deployment active");
    expect(commits).toBe(0);
    expect(failures).toHaveLength(exhausted ? 4 : 2);
    for (let i = 1; i < failures.length; i++) {
      expect(failures[i].body).toEqual(failures[0].body);
      expect(failures[i].at - failures[i - 1].at).toBeGreaterThanOrEqual(1000 * 2 ** (i - 1));
    }
    expect(failures[0].body).toMatchObject({ organizationId: "org", projectId: "project", deploymentId: "staging" });
    if (exhausted) {
      expect(result.stderr).toContain("Failed to mark deployment staging as failed: 429 Rate limited");
      expect(result.stderr).toContain("It may remain staging; retry deployment cleanup.");
      expect(deploymentStatus).toBe("staging");
    } else {
      expect(result.stderr).not.toContain("Failed to mark deployment");
      expect(deploymentStatus).toBe("failed");
    }
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    await rm(scratch, { recursive: true });
  }
}, 20_000);
