import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { buildCliBundle, subprocessEnv } from "./helpers/subprocess-coverage";

// Real CLI against a loopback Worker whose first file write fails the way a transient storage fault does: a marked 503, an
// unmarked text/plain 500 as the local runtime produces when it loses a connection, or (persistent) every attempt.
it.each([
  ["source", "marked"], ["bundle", "marked"], ["source", "harness"], ["source", "persistent"],
] as const)("%s: a %s transient failure on a file upload", async (kind, marking) => {
  await mkdir("tmp", { recursive: true });
  const scratch = await mkdtemp(resolve("tmp/cli-transient-"));
  const source = join(scratch, "docs");
  await mkdir(source);
  await writeFile(join(source, "index.html"), "<h1>Test</h1>");
  const uploads: string[] = [];
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      calls.push(`${request.method} ${request.url?.split("?")[0]}`);
      if (request.url?.startsWith("/api/rendro/deployments/check?")) response.end(JSON.stringify({ deployment: null, manifest: null }));
      else if (request.url === "/api/rendro/deployments/start") response.end(JSON.stringify({ deployment: { deploymentId: "staging" } }));
      else if (request.url?.includes("/files/")) {
        uploads.push(Buffer.concat(chunks).toString());
        if (uploads.length === 1 || marking === "persistent") {
          if (marking === "harness") response.writeHead(500, { "Content-Type": "text/plain" }).end("Error: Network connection lost.");
          else {
            response.setHeader("Retry-After", "1");
            response.writeHead(503).end(JSON.stringify({ error: "Storage temporarily unavailable", retryable: true }));
          }
        } else response.end('{"uploaded":"index.html"}');
      } else if (request.url === "/api/rendro/deployments/fail") response.end('{"status":true}');
      else if (request.url?.includes("/commit?")) response.end('{"deploymentId":"staging"}');
      else response.writeHead(404).end("{}");
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const executable = kind === "source" ? resolve("node_modules/.bin/tsx") : process.execPath;
    const entry = kind === "source" ? "cli/src/index.ts" : join(scratch, "rendro.mjs");
    if (kind === "bundle") await buildCliBundle(entry);
    const result = await promisify(execFile)(executable, [entry, "push", "--source", source, "--organization", "org", "--project", "project", "--endpoint", endpoint], {
      env: subprocessEnv({ ...process.env, RENDRO_API_KEY: "disposable-test-key" }), timeout: 30_000,
    }).then(output => ({ ...output, code: 0 }), (error: { code: number; stdout: string; stderr: string }) => error);
    if (marking !== "persistent") {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(marking === "marked" ? "Server error (503). Retrying" : "Server error (500). Retrying");
      expect(uploads).toEqual(["<h1>Test</h1>", "<h1>Test</h1>"]);
      expect(calls.filter(call => call.endsWith("/commit"))).toHaveLength(1);
      expect(calls).not.toContain("POST /api/rendro/deployments/fail");
    } else {
      // Bounded: the original attempt plus three retries, then the deployment is marked failed.
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Upload failed for index.html: 503 Backend unavailable");
      expect(uploads).toHaveLength(4);
      expect(calls).toContain("POST /api/rendro/deployments/fail");
      expect(calls.filter(call => call.endsWith("/commit"))).toHaveLength(0);
    }
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    await rm(scratch, { recursive: true });
  }
}, 40_000);
