import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

export interface CliManifestFile { path: string; sha256: string; size: number; contentType: string }
export interface CliManifest { version: number; files: CliManifestFile[] }

/** Real CLI subprocess and HTTP, with a loopback deployment API capture. */
export async function captureCliPush(source: string, options: {
  flags?: string[];
  bundle?: boolean;
  previous?: CliManifestFile[];
} = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "rendro-cli-capture-"));
  let manifest: CliManifest | undefined;
  let manifestSha256: string | undefined;
  let commits = 0;
  const copied: string[] = [];
  const uploads = new Map<string, { bytes: Buffer; contentType: string | undefined }>();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url!, "http://localhost");
      const body = Buffer.concat(chunks);
      requests.push(url.pathname);
      response.setHeader("Content-Type", "application/json");
      if (url.pathname.endsWith("/check")) {
        response.end(JSON.stringify({ deployment: options.previous ? { _id: "old" } : null,
          manifest: options.previous ? { version: 1, files: options.previous } : null }));
      } else if (url.pathname.endsWith("/start")) {
        ({ manifest, manifestSha256 } = JSON.parse(body.toString()) as { manifest: CliManifest; manifestSha256: string });
        response.end(JSON.stringify({ deployment: { deploymentId: "next" } }));
      } else if (request.method === "PUT") {
        uploads.set(decodeURIComponent(url.pathname.split("/files/")[1]), { bytes: body, contentType: request.headers["content-type"] });
        response.end("{}");
      } else if (url.pathname.endsWith("/copy")) {
        copied.push(...(JSON.parse(body.toString()) as { paths: string[] }).paths);
        response.end("{}");
      } else if (url.pathname.endsWith("/commit")) {
        commits++; response.end("{}");
      } else response.writeHead(500).end("{}");
    });
  });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const entry = options.bundle ? join(scratch, "rendro.mjs") : "cli/src/index.ts";
    if (options.bundle) await build({ entryPoints: ["cli/src/index.ts"], bundle: true, platform: "node", target: "node22", format: "esm", outfile: entry });
    const result = await promisify(execFile)(options.bundle ? process.execPath : resolve("node_modules/.bin/tsx"), [entry,
      "push", "--source", source, "--organization", "org", "--project", "project", "--endpoint", endpoint, ...options.flags ?? [],
    ], { env: { ...process.env, RENDRO_API_KEY: "synthetic-key" }, timeout: 15_000 });
    if (!manifest) throw new Error("CLI did not start a deployment");
    return { ...result, manifest, manifestSha256, copied, uploads, commits, requests };
  } catch (error) {
    throw Object.assign(error as Error, { requests });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await rm(scratch, { recursive: true, force: true });
  }
}
