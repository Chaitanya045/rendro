import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildCliBundle, subprocessEnv } from "./helpers/subprocess-coverage";

// Real CLI subprocesses (TypeScript source and the esbuild bundle) against a loopback server that counts every request.
const execute = promisify(execFile);
let root: string, scratch: string;
const requests: string[] = [];
const server = createServer((request, response) => { requests.push(`${request.method} ${request.url}`); response.end("{}"); });
let endpoint: string, bundle: string, bundleDirectory: string;
beforeAll(async () => {
  bundleDirectory = await mkdtemp(join(tmpdir(), "rendro-safeguards-bundle-"));
  bundle = join(bundleDirectory, "rendro.mjs");
  await buildCliBundle(bundle);
});
afterAll(async () => { await rm(bundleDirectory, { recursive: true, force: true }); });
beforeEach(async () => {
  requests.length = 0;
  scratch = await mkdtemp(join(tmpdir(), "rendro-safeguards-"));
  root = join(scratch, "docs");
  await mkdir(root);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  await rm(scratch, { recursive: true, force: true });
});

async function cli(args: string[], options: { bundled?: boolean; key?: string } = {}) {
  const env = { ...process.env, RENDRO_API_KEY: options.key ?? "" };
  const command = options.bundled ? [process.execPath, bundle] : [resolve("node_modules/.bin/tsx"), "cli/src/index.ts"];
  try {
    const result = await execute(command[0], [...command.slice(1), ...args], { env: subprocessEnv(env), timeout: 20_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}
const write = async (path: string, content = "SYNTHETIC_FIXTURE_CONTENT") => {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
};

describe.each([false, true])("dry run (bundle=%s)", bundled => {
  it("lists exactly the selected files with sizes and a total, using no credentials and no network", async () => {
    await write("index.html", "<h1>Hi</h1>");
    await write("guide/page.html", "<p>x</p>");
    await write("style.css", "p{}");
    await write("keep.map", "{}");
    await write("drop.log", "log");
    await write(".env", "SYNTHETIC_ENV_CONTENT");
    await write("keys/server.pem", "SYNTHETIC_PEM_CONTENT");
    await write(".rendroignore", "*.log\n");
    const result = await cli(["push", "--source", root, "--dry-run", "--endpoint", endpoint], { bundled });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Dry run: 4 file(s) would be uploaded (nothing was sent):");
    expect(result.stdout.split("\n").filter(line => /^ {2}\S.* \d+ B$/.test(line))).toEqual([
      "  guide/page.html  8 B", "  index.html  11 B", "  keep.map  2 B", "  style.css  3 B",
    ]);
    expect(result.stdout).toContain("Total: 4 file(s), 24 B");
    expect(result.stdout).toContain('skipped ".env" (sensitive)');
    expect(result.stdout).toContain('skipped "drop.log" (.rendroignore)');
    expect(result.stdout + result.stderr).not.toMatch(/SYNTHETIC_/);
    expect(requests).toEqual([]);
  });

  it("includes opted-in sensitive files with a warning that names them, still without network", async () => {
    await write("index.html", "<h1>Hi</h1>");
    await write(".env", "SYNTHETIC_ENV_CONTENT");
    await write("nested/id_rsa", "SYNTHETIC_KEY_CONTENT");
    await write("nested/ignored.key", "SYNTHETIC_KEY_CONTENT");
    await write(".rendroignore", "ignored.key\n");
    const result = await cli(["push", "--source", root, "--dry-run", "--include-sensitive", "--endpoint", endpoint], { bundled });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("warning: --include-sensitive is uploading 2 sensitive file(s) that are skipped by default:");
    expect(result.stderr).toContain('! ".env"');
    expect(result.stderr).toContain('! "nested/id_rsa"');
    expect(result.stderr).not.toContain("ignored.key");
    expect(result.stdout).toContain("  .env  21 B");
    expect(result.stdout).toContain("Total: 3 file(s)");
    expect(result.stdout + result.stderr).not.toMatch(/SYNTHETIC_/);
    expect(requests).toEqual([]);
  });

  it("still fails closed on an unreadable ignore file and invalid deployment paths", async () => {
    await write("index.html");
    await mkdir(join(root, ".rendroignore"));
    const unreadable = await cli(["push", "--source", root, "--dry-run"], { bundled });
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain("EISDIR");
    await rm(join(root, ".rendroignore"), { recursive: true });
    await write("bad\\name.html");
    const invalid = await cli(["push", "--source", root, "--dry-run"], { bundled });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Invalid deployment path");
    expect(invalid.stdout).not.toContain("Dry run:");
    expect(requests).toEqual([]);
  });
});

describe.each([false, true])("plaintext endpoints (bundle=%s)", bundled => {
  const identity = ["--organization", "org", "--project", "project"];
  it.for([
    ["push"], ["publication", "list"], ["publication", "remove", "--id", "pub"], ["publication", "create", "--slug", "docs"],
  ])("rejects http:// for %j before reading files or sending the key", async command => {
    await write("index.html");
    const result = await cli([...command, ...identity, "--source", root, "--endpoint", "http://rendro.example.com"], { bundled, key: "synthetic-key" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing endpoint http://rendro.example.com: API keys must not be sent over plaintext");
    expect(result.stderr).toContain("http:// only for localhost, 127.0.0.1 or [::1]");
    expect(result.stdout).toBe("");
    expect(requests).toEqual([]);
  });

  it.each(["ftp://rendro.example.com", "rendro.example.com", "http://user:secret@evil.example"])("rejects the endpoint %s without echoing credentials", async value => {
    const result = await cli(["push", ...identity, "--source", root, "--endpoint", value], { bundled, key: "synthetic-key" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Refusing endpoint|Invalid --endpoint/);
    expect(result.stderr).not.toContain("secret@");
    expect(result.stdout).toBe("");
  });

  it("also rejects plaintext endpoints in a dry run", async () => {
    await write("index.html");
    const result = await cli(["push", "--source", root, "--dry-run", "--endpoint", "http://rendro.example.com"], { bundled });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing endpoint");
  });

  it.each(["http://localhost:1", "http://[::1]:1"])("allows loopback %s (the connection itself fails, the endpoint check does not)", async value => {
    const result = await cli(["publication", "list", ...identity, "--endpoint", value], { bundled, key: "synthetic-key" });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("Refusing endpoint");
  });

  it("allows http://127.0.0.1 and pushes", async () => {
    await write("index.html");
    const result = await cli(["push", ...identity, "--source", root, "--endpoint", endpoint], { bundled, key: "synthetic-key" });
    expect(result.code).toBe(1); // The stub API does not implement the deployment protocol.
    expect(result.stderr).not.toContain("Refusing endpoint");
    expect(requests[0]).toContain("/api/rendro/deployments/check");
  });
});

describe("default secret skipping through the real CLI", () => {
  it("keeps secrets out of the manifest unless explicitly opted in, and warns when they are included", async () => {
    await write("index.html");
    for (const path of [".env.production", ".npmrc", ".netrc", "deploy.pem", "tls.key", "id_rsa", "id_ed25519.pub", "credentials.json", "bundle.p12", ".htpasswd", ".git/config"]) await write(path);
    const skipped = await cli(["push", "--source", root, "--dry-run"]);
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain("Total: 1 file(s)");
    for (const path of [".env.production", ".npmrc", ".netrc", "deploy.pem", "tls.key", "id_rsa", "id_ed25519.pub", "credentials.json", "bundle.p12", ".htpasswd"]) {
      expect(skipped.stdout).toContain(`skipped ${JSON.stringify(path)} (sensitive)`);
    }
    expect(skipped.stdout).toContain('skipped ".git/" (excluded directory)');
    expect(skipped.stderr).toBe("");
    const included = await cli(["push", "--source", root, "--dry-run", "--include-sensitive"]);
    expect(included.stdout).toContain("Total: 11 file(s)");
    expect(included.stdout).not.toContain(".git/config");
    expect(included.stderr).toContain("uploading 10 sensitive file(s)");
  });

  it("uploads only the selected files in a real push and keeps the warning on stderr", async () => {
    await write("index.html");
    await write(".env");
    await write("omit.txt");
    await write(".rendroignore", "omit.txt\n");
    const result = await cli(["push", "--organization", "org", "--project", "project", "--source", root, "--endpoint", endpoint, "--include-sensitive"], { key: "synthetic-key" });
    expect(result.stderr).toContain("uploading 1 sensitive file(s)");
    expect(result.stdout).toContain('skipped "omit.txt" (.rendroignore)');
  });
});
