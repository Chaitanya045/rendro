import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createTestHarness } from "wrangler";
import { startIdentityFixtures, startStorage } from "./services";
import { localEnvironment, startBackend } from "./backend";
import { seedWorkspace } from "./seed";
import { registerResources } from "./resource-journal";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

export default async function globalSetup() {
  const resources = registerResources();
  const directory = resources.directory;
  const closers: Array<() => Promise<void>> = [];
  const originalFetch = globalThis.fetch;
  const blockedOrigins = new Set<string>();
  const environmentKeys = ["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "WRANGLER_SEND_METRICS", "RENDRO_E2E_ORIGIN", "RENDRO_E2E_CONVEX", "RENDRO_E2E_MAIL", "RENDRO_E2E_SEED", "RENDRO_E2E_DIRECTORY"];
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
    resources.close();
    if (blockedOrigins.size) errors.push(new Error(`Blocked external Worker origins: ${[...blockedOrigins].join(", ")}`));
    if (errors.length) throw new AggregateError(errors, "E2E teardown failed");
  }

  try {
    const identity = await startIdentityFixtures(directory);
    closers.push(() => identity.close());
    const convex = await startBackend(directory, identity, resources);
    identity.allowedOrigins.add(convex.site);
    identity.allowedOrigins.add(convex.origin);
    closers.push(() => convex.close());
    const storage = await startStorage(directory, resources);
    closers.push(() => storage.close());
    const vars = {
      NODE_ENV: "production",
      LOG_LEVEL: "error",
      CONVEX_URL: convex.origin,
      CONVEX_SITE_URL: convex.site,
      CONVEX_INTERNAL_SECRET: randomBytes(32).toString("hex"),
      AUTH_SECRET: randomBytes(32).toString("hex"),
      MINIO_ENDPOINT: storage.origin,
      MINIO_ACCESS_KEY: storage.accessKeyId,
      MINIO_SECRET_KEY: storage.secretAccessKey,
      MINIO_BUCKET: "docs",
      MINIO_REGION: "us-east-1",
      MINIO_FORCE_PATH_STYLE: "true",
    };
    // Always rebuild: existence alone cannot detect stale ignored browser bundles.
    await run("pnpm", ["build:assets"], {
      cwd: root, env: { ...localEnvironment(), ...vars, VITEST_MAX_WORKERS: "2" }, timeout: 120_000,
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

    await run("pnpm", ["cli:build"], { cwd: root, env: localEnvironment(), timeout: 120_000 });
    const allowedOrigins = new Set([convex.origin, convex.site, storage.origin]);
    // Wrangler 4.149.0's harness outboundService delegates to globalThis.fetch.
    // Keep real HTTP to our fixtures; return redirects without following them (auth redirects belong to the browser).
    globalThis.fetch = async (input, init) => {
      // Request fields can be prototype getters (Wrangler passes a Request as init).
      // Normalize before applying overrides, rather than losing headers via spread.
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!allowedOrigins.has(url.origin)) {
        blockedOrigins.add(url.origin);
        throw new Error(`Blocked external Worker origin: ${url.origin}`);
      }
      return originalFetch(request, { redirect: "manual" });
    };
    resources.assertActive();
    const server = createTestHarness({
      root,
      workers: [{ configPath, vars, secrets: vars }],
    });
    closers.push(() => server.close());
    const { url } = await server.listen();
    allowedOrigins.add(url.origin);
    const health = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(10_000) });
    if (health.status !== 200 || await health.text() !== "ok") throw new Error("Worker HTTP health check failed");
    identity.allowedOrigins.add(url.origin);
    await convex.environment({ SITE_URL: url.origin, AUTH_SECRET: vars.AUTH_SECRET, CONVEX_INTERNAL_SECRET: vars.CONVEX_INTERNAL_SECRET,
      GOOGLE_CLIENT_ID: "e2e-google", GOOGLE_CLIENT_SECRET: randomBytes(32).toString("hex"),
      RESEND_API_KEY: randomBytes(32).toString("hex"), AUTH_EMAIL_FROM: "Rendro <fixture@example.test>" });
    await convex.push();
    const seed = await seedWorkspace({ site: convex.site, worker: url.origin, secret: vars.CONVEX_INTERNAL_SECRET, mail: identity.mail, directory, fetch: originalFetch });
    await storage.removeSmokeAsset(seed.organizationId, seed.projectId);
    const seedPath = join(directory, "seed.json");
    await writeFile(seedPath, JSON.stringify(seed), { mode: 0o600 });
    process.env.RENDRO_E2E_ORIGIN = url.origin;
    process.env.RENDRO_E2E_CONVEX = convex.origin;
    process.env.RENDRO_E2E_MAIL = identity.control;
    process.env.RENDRO_E2E_SEED = seedPath;
    process.env.RENDRO_E2E_DIRECTORY = directory;
    console.log("E2E: real workerd ready; real local Convex/S3Proxy, captured mail and OAuth, external fetch blocked.");
    return cleanup;
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "E2E startup and cleanup failed", { cause: cleanupError });
    }
    throw error;
  }
}
