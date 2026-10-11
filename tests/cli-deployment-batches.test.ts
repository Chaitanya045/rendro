import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { build } from "esbuild";
import { MAX_REUSED_FILES_PER_REQUEST } from "../shared/deployment-limits";

it.each(["source", "bundle"])("%s pushes unchanged documents in bounded copy requests before committing", async (kind) => {
  const scratch = await mkdtemp(join(tmpdir(), "rendro-cli-batches-"));
  const source = join(scratch, "docs");
  await mkdir(source);
  const content = "<h1>CLI QA</h1>";
  const files = Array.from({ length: 40 }, (_, index) => ({ path: `file-${String(index).padStart(2, "0")}.html`, sha256: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content), contentType: "text/html" }));
  await Promise.all(files.map(file => writeFile(join(source, file.path), content)));
  const batches: string[][] = [];
  let commits = 0;
  const copyAttempts: number[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.headers.authorization !== "Bearer disposable-test-key") {
        response.writeHead(401).end("{}"); return;
      }
      if (request.url?.startsWith("/api/rendro/deployments/check?")) {
        response.end(JSON.stringify({ deployment: { deploymentId: "previous" }, manifest: { version: 1, files } }));
      } else if (request.url === "/api/rendro/deployments/start") {
        response.end(JSON.stringify({ deployment: { deploymentId: "next" } }));
      } else if (request.url?.includes("/next/copy?")) {
        copyAttempts.push(Date.now());
        if (copyAttempts.length === 1) {
          response.setHeader("Retry-After", "1");
          response.writeHead(429).end(JSON.stringify({ error: "Rate limit exceeded", code: "rate_limited" }));
          return;
        }
        const { paths } = JSON.parse(Buffer.concat(chunks).toString()) as { paths: string[] };
        batches.push(paths);
        if (paths.length > MAX_REUSED_FILES_PER_REQUEST) response.writeHead(400).end("{}");
        else response.end(JSON.stringify({ copied: paths.length }));
      } else if (request.url?.includes("/next/commit?")) {
        commits++; response.end("{}");
      } else response.writeHead(500).end("{}");
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const executable = kind === "source" ? resolve("node_modules/.bin/tsx") : process.execPath;
    const entry = kind === "source" ? "cli/src/index.ts" : join(scratch, "rendro.mjs");
    if (kind === "bundle") {
      await build({ entryPoints: ["cli/src/index.ts"], bundle: true, platform: "node", target: "node22", format: "esm", outfile: entry });
    }
    const { stdout, stderr } = await promisify(execFile)(executable, [entry, "push", "--source", source, "--organization", "org", "--project", "project", "--endpoint", endpoint], { env: { ...process.env, RENDRO_API_KEY: "disposable-test-key" } });
    expect(batches.map(batch => batch.length)).toEqual([16, 16, 8]);
    expect(batches.flat()).toEqual(files.map(file => file.path));
    expect(commits).toBe(1);
    expect(copyAttempts).toHaveLength(4);
    expect(copyAttempts[1] - copyAttempts[0]).toBeGreaterThanOrEqual(1_000);
    expect(stderr).toContain("Rate limited (429). Retrying");
    expect(stdout).toContain("0 uploaded, 40 reused, 40 total");
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    await rm(scratch, { recursive: true });
  }
});
