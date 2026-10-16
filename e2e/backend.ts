import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, open, writeFile } from "node:fs/promises";
import { cpSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifiedArchive } from "./verified-cache";
import type { ResourceJournal } from "./resource-journal";

export const run = promisify(execFile);
export const root = resolve(import.meta.dirname, "..");
export const backendVersion = "precompiled-2026-10-06-a3538c6";

export { assertLoopback, localEnvironment } from "./local-safety";
import { assertLoopback, localEnvironment } from "./local-safety";

export async function backendBinary(directory: string, resources?: ResourceJournal) {
  // Keep backend downloads separate from the CLI's mutable 'latest' cache.
  const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`;
  const checksums: Record<string, string> = {
    "x86_64-unknown-linux-gnu": "eba2eeab62632e0c153e83f9f1c5ada9e98834e2db3386e32f825a3a97f8c093",
    "aarch64-unknown-linux-gnu": "d3bf1d8799d91cecabe144ee2c96348c903ec3f5f88199f375004647b037cc35",
    "aarch64-apple-darwin": "f89a9dc8189148b0aa67b50dbcb202ce429b541df83e36cab4438c2b7955d5c2",
    "x86_64-apple-darwin": "a9465ddf5535392a3ae9bd5f9aab49e5067927f2b27e8fdb45fe1317d7b42f6d",
  };
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported E2E backend platform");
  const cache = join(homedir(), ".cache/rendro-e2e", backendVersion, target);
  const bytes = await verifiedArchive(join(cache, "backend.zip"), checksums[target], async zip => {
    resources?.assertActive();
    const downloading = run("curl", ["--fail", "--location", "--silent", "--show-error", "--output", zip,
      `https://github.com/get-convex/convex-backend/releases/download/${backendVersion}/convex-local-backend-${target}.zip`], { timeout: 120_000 });
    resources?.child(downloading.child);
    await downloading;
  }, temporary => resources?.temporary(temporary));
  // Extract the exact bytes we checked into a private run directory. Old cached
  // executables are never trusted, and concurrent runs cannot replace this file.
  const zip = join(directory, "backend.zip");
  await writeFile(zip, bytes, { mode: 0o600 });
  resources?.assertActive();
  const extracting = run("unzip", ["-q", zip, "-d", directory]);
  resources?.child(extracting.child);
  await extracting;
  const binary = join(directory, "convex-local-backend");
  await chmod(binary, 0o700);
  return binary;
}
export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

// Node HTTP bypasses Vitest's global fetch mock and Wrangler's outbound transport.
export function localHttp(url: string, body?: unknown, headers: Record<string, string> = {}) {
  assertLoopback(new URL(url).origin);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, timeout: 15_000 }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Local HTTP timeout")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export async function ready(probe: () => boolean | Promise<boolean>, label: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await probe()) return; } catch { /* Readiness may precede the listener. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} readiness timed out`);
}

export async function startBackend(directory: string, proxy?: { origin: string; certificate: string }, resources?: ResourceJournal) {
  const binary = await backendBinary(directory, resources);
  resources?.assertActive();
  const port = await freePort();
  let sitePort = await freePort();
  while (sitePort === port) sitePort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const site = `http://127.0.0.1:${sitePort}`;
  const secret = randomBytes(32).toString("hex");
  const instance = `e2e-${randomBytes(6).toString("hex")}`;
  const environment = { ...localEnvironment(), DISABLE_BEACON: "true", ...(proxy ? { SSL_CERT_FILE: proxy.certificate } : {}) };
  resources?.assertActive();
  const generating = run(binary, ["keygen", "admin-key", "--instance-name", instance, "--instance-secret", secret], { env: environment });
  resources?.child(generating.child);
  const { stdout } = await generating;
  const adminKey = stdout.trim();
  const log = await open(join(directory, "backend.log"), "w", 0o600);
  resources?.assertActive();
  const child = spawn(binary, ["--interface", "127.0.0.1", "--port", String(port), "--site-proxy-port", String(sitePort),
    "--instance-name", instance, "--instance-secret", secret, "--disable-beacon",
    "--local-storage", join(directory, "storage"), ...(proxy ? ["--convex-http-proxy", proxy.origin] : []), join(directory, "db.sqlite3")],
  { env: environment, stdio: ["ignore", log.fd, log.fd] });
  resources?.child(child);
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await stopped.finally(() => clearTimeout(timer));
    }
    await log.close();
  };
  try {
    await ready(async () => (await localHttp(`${origin}/version`)).status === 200, "Convex");
  } catch (error) { await close(); throw error; }
  return {
    origin, site, adminKey, close,
    async environment(values: Record<string, string>) {
      const response = await localHttp(`${origin}/api/update_environment_variables`, { changes: Object.entries(values).map(([name, value]) => ({ name, value })) }, { Authorization: `Convex ${adminKey}` });
      if (response.status !== 200) throw new Error(`Local environment update failed: ${response.status}`);
    },
    async push() {
      assertLoopback(origin);
      // A copied source tree prevents dotenv discovery, codegen/config writes, and
      // accidental changes to the working tree. Never copy deployment credentials.
      const cwd = join(directory, "app");
      resources?.assertActive();
      // Keep the source-copy phase synchronous: timeout teardown must not race
      // an in-flight recursive copy that could recreate the removed directory.
      mkdirSync(cwd);
      for (const name of ["convex", "shared", "src", "package.json", "convex.json", "tsconfig.json"]) {
        cpSync(join(root, name), join(cwd, name), { recursive: true });
      }
      symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
      if (readdirSync(cwd).includes(".env.local")) {
        throw new Error("Refusing a Convex push from a directory containing .env.local");
      }
      try {
        const pushing = run(join(root, "node_modules/.bin/convex"), ["dev", "--once", "--url", origin, "--admin-key", adminKey,
          "--typecheck", "disable", "--codegen", "disable", "--tail-logs", "disable"],
        { cwd, env: { ...localEnvironment(), CONVEX_AGENT_MODE: "anonymous" }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
        resources?.child(pushing.child);
        await pushing;
      } catch (error) {
        // execFile includes argv on Error.message; do not print the generated key.
        const stderr = (error as { stderr?: string }).stderr ?? "";
        // eslint-disable-next-line preserve-caught-error -- cause contains the generated admin key in argv
        throw new Error(`Disposable Convex push failed: ${stderr.replaceAll(adminKey, "[local key]")}`);
      }
    },
  };
}
