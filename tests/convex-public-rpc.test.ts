import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { request } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publicErrorMessages } from "../src/shared/public-errors";

// Verified with backend release precompiled-2026-10-06-a3538c6 and SDK 1.42.0.
// Opt in with CONVEX_TEST_BACKEND=/absolute/path/to/convex-local-backend.
// Starts its own loopback-only backend and temporary DB inside this worktree;
// never reads deployment credentials or connects to an existing deployment.
const binary = process.env.CONVEX_TEST_BACKEND;
describe.skipIf(!binary)("isolated Convex RPC envelopes", () => {
  let server: ChildProcess | undefined;
  let directory: string;
  let url: string;
  let log: Awaited<ReturnType<typeof open>> | undefined;

  async function freePort() {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    return port;
  }
  function localRequest(path: string, body?: unknown): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(`${url}${path}`, {
        method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        response.on("error", reject);
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return JSON.parse((await localRequest(`/api/${path}`, body)).body) as Record<string, unknown>;
  }
  const rpc = (kind: string, name: string, args: unknown) => post(kind, { path: `probe:${name}`, args, format: "json" });
  const normalized = (envelope: unknown) => JSON.stringify(envelope).replace(/\[Request ID: [a-f0-9]+\]/g, "[Request ID: omitted]");
  function safeFailure(envelope: Record<string, unknown>, code: keyof typeof publicErrorMessages) {
    expect(envelope).toMatchObject({ status: "error", errorData: { code, message: publicErrorMessages[code] } });
    expect(envelope.errorMessage).toBe(`[Request ID: ${(envelope.errorMessage as string).match(/Request ID: ([a-f0-9]+)/)?.[1]}] Server Error\nUncaught ConvexError: ${publicErrorMessages[code]}\n`);
    expect(normalized(envelope)).not.toMatch(/\.ts:\d|\.js:\d| at |__frameData|stack|trace/);
  }

  beforeAll(async () => {
    await mkdir("tmp", { recursive: true });
    directory = await mkdtemp(resolve("tmp/public-rpc-"));
    const secret = randomBytes(32).toString("hex");
    const instance = "public-rpc-test";
    const adminKey = execFileSync(binary!, ["keygen", "admin-key", "--instance-name", instance, "--instance-secret", secret], { encoding: "utf8" }).trim();
    const port = await freePort();
    const sitePort = await freePort();
    url = `http://127.0.0.1:${port}`;
    log = await open(`${directory}/runtime.log`, "w");
    server = spawn(binary!, [
      "--interface", "127.0.0.1", "--port", String(port), "--site-proxy-port", String(sitePort),
      "--instance-name", instance, "--instance-secret", secret,
      "--local-storage", `${directory}/storage`, `${directory}/db.sqlite3`,
    ], { stdio: ["ignore", log.fd, log.fd], env: { ...process.env, DO_NOT_SEND_BEACON: "true" } });
    await vi.waitFor(async () => {
      expect((await localRequest("/version")).status).toBe(200);
    }, { timeout: 20_000, interval: 100 });
    const bundle = await build({
      entryPoints: ["tests/helpers/public-rpc-fixture.ts"], bundle: true, format: "esm", platform: "browser",
      write: false, outfile: "probe.js", sourcemap: "external",
    });
    // Load only this fixture into the disposable backend, with no app schema/data.
    const pushed = await post("push_config", {
      adminKey, udfServerVersion: "1.42.0", config: { functions: "convex/", authInfo: [] },
      modules: [{ path: "probe.js", environment: "isolate",
        source: bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text,
        sourceMap: bundle.outputFiles.find(file => file.path.endsWith(".map"))!.text }],
    });
    expect(pushed).toEqual({});
    expect(await rpc("mutation", "seed", {})).toMatchObject({ status: "success" });
  }, 30_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
    await log?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(["query", "mutation"])("%s envelopes are identical across reasons and call stacks for every expected code", async kind => {
    for (const code of Object.keys(publicErrorMessages) as (keyof typeof publicErrorMessages)[]) {
      const missing = await rpc(kind, `${kind}Failure`, { missing: true, code });
      const inaccessible = await rpc(kind, `${kind}Failure`, { missing: false, code });
      safeFailure(missing, code);
      safeFailure(inaccessible, code);
      expect(normalized(missing)).toBe(normalized(inaccessible));
    }
  });

  it("retains diagnostic frames for unexpected errors after an expected error", async () => {
    const result = await rpc("query", "diagnostics", {});
    expect(result.errorMessage).toContain("Unexpected failure still has frames");
    expect(result.errorMessage).toMatch(/at handler .*public-rpc-fixture\.ts:\d/);
    expect(result).not.toHaveProperty("errorData");
  });

  it.each(["documentThreads", "documentReplies"])("%s rejects malformed and foreign cursor/endCursor values", async table => {
    const foreign = table === "documentThreads" ? "documentReplies" : "documentThreads";
    const first = await rpc("query", "page", { table, cursor: null });
    const other = await rpc("query", "page", { table: foreign, cursor: null });
    const validCursor = (first.value as { continueCursor: string }).continueCursor;
    expect(await rpc("query", "page", { table, cursor: validCursor })).toMatchObject({ status: "success" });
    for (const field of ["cursor", "endCursor"]) {
      for (const cursor of ["", " ", "malformed-cursor", "00", (other.value as { continueCursor: string }).continueCursor]) {
        const result = await rpc("query", "page", { table, cursor: null, [field]: cursor });
        safeFailure(result, "invalid_input");
      }
    }
  });
});
