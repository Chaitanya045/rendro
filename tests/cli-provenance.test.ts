import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { Provenance } from "../shared/provenance";
import { gitRemoteCases } from "./git-remote-fixtures";
const exec = promisify(execFile);

it.each([
  ...gitRemoteCases,
  ["https://git-user:synthetic-token@git.example/team/docs.git?token=synthetic-query#synthetic-fragment", "https://git.example/team/docs.git"],
  ["git@git.example:team/docs.git", "git.example:team/docs.git"],
])("captures credential-free provenance from a real git remote", async (remote, expected) => {
  const source = await mkdtemp(join(tmpdir(), "rendro-provenance-"));
  let captured: Provenance | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.includes("/check?")) response.end(JSON.stringify({ deployment: null, manifest: null }));
      else if (request.url?.endsWith("/start")) {
        captured = (JSON.parse(Buffer.concat(chunks).toString()) as { provenance: Provenance }).provenance;
        response.end(JSON.stringify({ deployment: { deploymentId: "test" } }));
      } else response.end("{}");
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    await exec("git", ["init", source]);
    await writeFile(join(source, "index.html"), "<h1>Docs</h1>");
    await exec("git", ["-C", source, "add", "index.html"]);
    await exec("git", ["-C", source, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    await exec("git", ["-C", source, "remote", "add", "origin", remote]);
    const env: NodeJS.ProcessEnv = { ...process.env, RENDRO_API_KEY: "synthetic-key" };
    for (const name of Object.keys(env)) if (name.startsWith("GITHUB_") || name === "CI") delete env[name];
    const result = await exec(resolve("node_modules/.bin/tsx"), ["cli/src/index.ts", "push", "--source", source, "--organization", "test-org", "--project", "test-project", "--endpoint", `http://127.0.0.1:${(server.address() as AddressInfo).port}`], { env });
    expect(captured?.source).toMatchObject({ kind: "git", dirty: false });
    expect(captured?.source.repository).toBe(expected);
    expect(captured?.source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(captured?.source.ref).toBeTruthy();
    expect(JSON.stringify(captured) + result.stdout + result.stderr).not.toMatch(/synthetic-token|synthetic-query|synthetic-fragment|git-user/);
    expect(result.stdout).toContain("Deployment active");
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(source, { recursive: true, force: true });
  }
});
