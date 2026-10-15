import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createTestHarness } from "wrangler";
import { startConvexStub, startStorageStub } from "./services";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

export default async function globalSetup() {
  const directory = await mkdtemp(join(tmpdir(), "rendro-e2e-"));
  const closers: Array<() => Promise<void>> = [];
  const originalFetch = globalThis.fetch;
  const blockedOrigins = new Set<string>();
  const environmentKeys = ["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "WRANGLER_SEND_METRICS", "RENDRO_E2E_ORIGIN"];
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  async function cleanup() {
    const errors: unknown[] = [];
    for (const close of closers.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    globalThis.fetch = originalFetch;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
    if (blockedOrigins.size) errors.push(new Error(`Blocked external Worker origins: ${[...blockedOrigins].join(", ")}`));
    if (errors.length) throw new AggregateError(errors, "E2E teardown failed");
  }

  try {
    const convex = await startConvexStub();
    closers.push(() => convex.close());
    const accessKey = randomBytes(24).toString("hex");
    const storage = await startStorageStub(accessKey);
    closers.push(() => storage.close());
    const vars = {
      NODE_ENV: "production",
      LOG_LEVEL: "error",
      CONVEX_URL: convex.origin,
      CONVEX_SITE_URL: convex.origin,
      CONVEX_INTERNAL_SECRET: randomBytes(32).toString("hex"),
      AUTH_SECRET: randomBytes(32).toString("hex"),
      MINIO_ENDPOINT: storage.origin,
      MINIO_ACCESS_KEY: accessKey,
      MINIO_SECRET_KEY: randomBytes(32).toString("hex"),
      MINIO_BUCKET: "docs",
      MINIO_REGION: "us-east-1",
      MINIO_FORCE_PATH_STYLE: "true",
    };
    // Always rebuild: existence alone cannot detect stale ignored browser bundles.
    await run("pnpm", ["build:assets"], {
      cwd: root, env: { ...process.env, ...vars, VITEST_MAX_WORKERS: "2" }, timeout: 120_000,
    });

    // Relocate only paths. Flags, compatibility date and asset routing come from production.
    const productionConfig = await readFile(join(root, "wrangler.toml"), "utf8");
    const configPath = join(directory, "wrangler.toml");
    await writeFile(configPath, productionConfig
      .replace('main = "src/worker.ts"', `main = ${JSON.stringify(join(root, "src/worker.ts"))}`)
      .replace('directory = "./public"', `directory = ${JSON.stringify(join(root, "public"))}`));
    // The empty file also prevents loading shell credentials through required secrets.
    await writeFile(join(directory, ".dev.vars"), "# Only explicit synthetic bindings are used.\n");
    process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
    process.env.WRANGLER_SEND_METRICS = "false";

    const allowedOrigins = new Set([convex.origin, storage.origin]);
    // Wrangler 4.149.0's harness outboundService delegates to globalThis.fetch.
    // Keep real HTTP to our fixtures; reject redirects before following off-origin.
    globalThis.fetch = async (input, init) => {
      // Request fields can be prototype getters (Wrangler passes a Request as init).
      // Normalize before applying overrides, rather than losing headers via spread.
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!allowedOrigins.has(url.origin)) {
        blockedOrigins.add(url.origin);
        throw new Error(`Blocked external Worker origin: ${url.origin}`);
      }
      return originalFetch(request, { redirect: "error" });
    };
    const server = createTestHarness({
      root,
      workers: [{ configPath, vars, secrets: vars }],
    });
    closers.push(() => server.close());
    const { url } = await server.listen();
    allowedOrigins.add(url.origin);
    const health = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(10_000) });
    if (health.status !== 200 || await health.text() !== "ok") throw new Error("Worker HTTP health check failed");
    process.env.RENDRO_E2E_ORIGIN = url.origin;
    console.log("E2E: real workerd ready; isolated local Convex/S3 fixtures, external fetch blocked.");
    return cleanup;
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "E2E startup and cleanup failed", { cause: cleanupError });
    }
    throw error;
  }
}
