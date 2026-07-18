import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

type PromiseWithResolvers = <T>() => {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const promiseConstructor = Promise as PromiseConstructor & {
  withResolvers: PromiseWithResolvers;
};

function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = promiseConstructor.withResolvers<string>();
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => resolve(body));
  req.on("error", reject);
  return promise;
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

describe("rendro CLI multi-repo sync", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("scopes same-org deletes to --repo while preserving sibling repo files with the same names", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rendro-cli-multirepo-"));
    const source = join(tempDir, "rendro-test-docs");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "index.html"), "<h1>rendro test</h1>");

    const uploaded: string[] = [];
    const deleted: string[] = [];
    const listPrefixes: string[] = [];
    const serverKeys = [
      "gmail/rendro-test/index.html",
      "gmail/rendro-test/old.html",
      "gmail/rendro-api/index.html",
      "gmail/rendro-api/old.html",
    ];

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/sync/check") {
        sendJson(res, { exists: false, match: false });
        return;
      }
      if (url.pathname === "/api/sync/upload" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { key: string };
        uploaded.push(body.key);
        sendJson(res, { ok: true, key: body.key });
        return;
      }
      if (url.pathname === "/api/sync/list") {
        const prefix = url.searchParams.get("prefix") || "gmail/";
        listPrefixes.push(prefix);
        sendJson(res, { keys: serverKeys.filter((key) => key.startsWith(prefix)) });
        return;
      }
      if (url.pathname === "/api/sync/delete" && req.method === "DELETE") {
        const key = url.searchParams.get("key") || "";
        deleted.push(key);
        sendJson(res, { deleted: true, key });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");

    try {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "cli/src/index.ts",
        "push",
        "--source",
        source,
        "--org",
        "gmail",
        "--repo",
        "rendro-test",
        "--endpoint",
        `http://127.0.0.1:${address.port}`,
        "--token",
        "test-token",
        "--concurrency",
        "1",
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });

      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
      const [code] = await once(child, "exit") as [number];
      expect(Buffer.concat(errorChunks).toString()).toBe("");
      expect(Buffer.concat(chunks).toString()).toContain("gmail/rendro-test/index.html");
      expect(code).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }

    expect(uploaded).toEqual(["gmail/rendro-test/index.html"]);
    expect(listPrefixes).toEqual(["gmail/rendro-test/"]);
    expect(deleted).toEqual(["gmail/rendro-test/old.html"]);
    expect(deleted).not.toContain("gmail/rendro-api/old.html");
    expect(deleted).not.toContain("gmail/rendro-api/index.html");
  });
});
