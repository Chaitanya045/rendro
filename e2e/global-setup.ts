import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createTestHarness } from "wrangler";
import { removeSmokeAsset, startFaults, startIdentityFixtures, startImageHost, storageProbeOrigin } from "./services";
import { localEnvironment, startBackend } from "./backend";
import { seedWorkspace } from "./seed";
import { registerResources } from "./resource-journal";
import { controlWorker, controlWorkerConfig, withRepoReadBindings } from "./repo-read-config";
import { repositoryWorld, seedRepositories } from "./repo-fixtures";
import type { R2BucketLike } from "../src/ingest/orchestrator/store";
import { d1SearchIndex, type SearchD1 } from "../src/search/d1";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

export default async function globalSetup() {
  const resources = registerResources();
  const directory = resources.directory;
  const closers: Array<() => Promise<void>> = [];
  const originalFetch = globalThis.fetch;
  const blockedOrigins = new Set<string>();
  const environmentKeys = ["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "WRANGLER_SEND_METRICS", "RENDRO_E2E_ORIGIN", "RENDRO_E2E_CONVEX", "RENDRO_E2E_CONVEX_SITE", "RENDRO_E2E_MAIL", "RENDRO_E2E_FAULTS", "RENDRO_E2E_IMAGES", "RENDRO_E2E_IMAGE_PROXY_SECRET", "RENDRO_E2E_SEED", "RENDRO_E2E_DIRECTORY", "RENDRO_E2E_REPOS"];
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
    if (errors.length) throw new AggregateError(errors, `E2E teardown failed: ${errors.map(error => error instanceof Error ? error.message : String(error)).join("; ")}`);
  }

  try {
    const identity = await startIdentityFixtures(directory);
    closers.push(() => identity.close());
    const convex = await startBackend(directory, identity, resources);
    identity.allowedOrigins.add(convex.site);
    identity.allowedOrigins.add(convex.origin);
    closers.push(() => convex.close());
    const vars = {
      NODE_ENV: "production",
      LOG_LEVEL: "error",
      CONVEX_URL: convex.origin,
      CONVEX_SITE_URL: convex.site,
      CONVEX_INTERNAL_SECRET: randomBytes(32).toString("hex"),
      AUTH_SECRET: randomBytes(32).toString("hex"),
      IMAGE_PROXY_SECRET: randomBytes(32).toString("hex"),
      REPO_CAPABILITY_SECRET: randomBytes(32).toString("hex"),
    };
    // Always rebuild: existence alone cannot detect stale ignored browser bundles.
    await run("pnpm", ["build:assets"], {
      cwd: root, env: { ...localEnvironment(), ...vars, VITEST_MAX_WORKERS: "2" }, timeout: 120_000,
    });

    // Relocate only paths. Flags, compatibility date and asset routing come from production; the repository
    // read path's bindings (unbound in production until the owner configures P5) point at local R2/KV and the
    // real control Worker (wrangler.control.toml), which reads a fake GitHub in this process.
    const productionConfig = await readFile(join(root, "wrangler.toml"), "utf8");
    const configPath = join(directory, "wrangler.toml");
    const compatibilityDate = /^compatibility_date = "([^"]+)"/m.exec(productionConfig)?.[1];
    const bucketName = /^\[\[r2_buckets\]\]\nbinding = "STORAGE"\nbucket_name = "([^"]+)"/m.exec(productionConfig)?.[1];
    if (!compatibilityDate || !bucketName) throw new Error("wrangler.toml must declare compatibility_date and the STORAGE bucket");
    // The one deliberate difference: STORAGE becomes a service that wraps the local R2 bucket, so a spec can fail storage.
    const bucketBinding = /^\[\[r2_buckets\]\]\nbinding = "STORAGE"\nbucket_name = "[^"]+"\n/m;
    await writeFile(configPath, withRepoReadBindings(productionConfig
      .replace('main = "src/worker.ts"', `main = ${JSON.stringify(join(root, "src/worker.ts"))}`)
      .replace('directory = "./public"', `directory = ${JSON.stringify(join(root, "public"))}`)
      .replace(bucketBinding, '[[services]]\nbinding = "STORAGE"\nservice = "storage-faults"\n'), controlWorker.name));
    const controlPath = join(directory, "wrangler.control.toml");
    await writeFile(controlPath, await controlWorkerConfig(root));
    const world = repositoryWorld();
    // The control Worker also tells the local Convex about revocations and removed repositories (#254).
    const controlVars = { GITHUB_API_ORIGIN: world.github.origin, GITHUB_WEB_ORIGIN: world.github.webOrigin, GITHUB_APP_CLIENT_ID: world.github.clientId, CONVEX_URL: convex.origin };
    const controlSecrets = {
      GITHUB_WEBHOOK_SECRET: randomBytes(32).toString("hex"), GITHUB_TOKEN_KEY: randomBytes(32).toString("hex"),
      GITHUB_APP_CLIENT_SECRET: world.github.clientSecret, GITHUB_DEV_TOKEN: world.github.token, CONVEX_INTERNAL_SECRET: vars.CONVEX_INTERNAL_SECRET,
    };
    // The empty file also prevents loading shell credentials through required secrets.
    await writeFile(join(directory, ".dev.vars"), "# Only explicit synthetic bindings are used.\n");
    process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
    process.env.WRANGLER_SEND_METRICS = "false";

    await run("pnpm", ["cli:build"], { cwd: root, env: localEnvironment(), timeout: 120_000 });
    const allowedOrigins = new Set([convex.origin, convex.site, storageProbeOrigin]);
    const faults = await startFaults({ storage: storageProbeOrigin, convex: [convex.origin, convex.site] });
    closers.push(() => faults.close());
    const images = await startImageHost();
    closers.push(() => images.close());
    // Wrangler 4.149.0's harness outboundService delegates to globalThis.fetch.
    // Keep real HTTP to our fixtures; return redirects without following them (auth redirects belong to the browser).
    globalThis.fetch = async (input, init) => {
      // Request fields can be prototype getters (Wrangler passes a Request as init).
      // Normalize before applying overrides, rather than losing headers via spread.
      const request = new Request(input, init);
      const url = new URL(request.url);
      const image = images.intercept(request);
      if (image) return image;
      // The control Worker's GitHub is the in-process fake.
      if (url.origin === world.github.origin || url.origin === world.github.webOrigin) return world.github.fetch(request);
      if (!allowedOrigins.has(url.origin)) {
        blockedOrigins.add(url.origin);
        throw new Error(`Blocked external Worker origin: ${url.origin}`);
      }
      // The storage probe is answered here (see e2e/storage-faults-worker.mjs); it never leaves the machine.
      if (url.origin === storageProbeOrigin) return faults.intercept(request) ?? new Response(null, { status: 204 });
      return faults.intercept(request) ?? originalFetch(request, { redirect: "manual" });
    };
    resources.assertActive();
    const server = createTestHarness({
      root,
      workers: [
        { configPath, vars, secrets: vars },
        { config: {
          name: "storage-faults", main: join(root, "e2e/storage-faults-worker.mjs"),
          compatibility_date: compatibilityDate, compatibility_flags: ["nodejs_compat"],
          r2_buckets: [{ binding: "BUCKET", bucket_name: bucketName }],
        } },
        { configPath: controlPath, vars: controlVars, secrets: controlSecrets },
      ],
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
    // Storage is the Worker's own R2 binding on Miniflare's local simulation: no service, endpoint or key.
    const { BUCKET } = await server.getWorker<{ BUCKET: Parameters<typeof removeSmokeAsset>[0] }>("storage-faults").getEnv();
    await removeSmokeAsset(BUCKET, seed.organizationId, seed.projectId);
    await writeFile(join(directory, "backend-admin.json"), JSON.stringify({ origin: convex.origin, adminKey: convex.adminKey }), { mode: 0o600 });
    const workerEnv = await server.getWorker<{ REPO_CONTENT: R2BucketLike; REPO_SEARCH: SearchD1 }>().getEnv();
    const controlHandle = server.getWorker(controlWorker.name);
    const repos = await seedRepositories({
      bucket: workerEnv.REPO_CONTENT, world, webhookSecret: controlSecrets.GITHUB_WEBHOOK_SECRET, userIds: seed.userIds,
      control: (url, init) => controlHandle.fetch(url, init) as unknown as Promise<Response>,
      search: d1SearchIndex(workerEnv.REPO_SEARCH),
    });
    closers.push(() => repos.close());
    const reposPath = join(directory, "repos.json");
    await writeFile(reposPath, JSON.stringify(repos.fixtures), { mode: 0o600 });
    process.env.RENDRO_E2E_REPOS = reposPath;
    const seedPath = join(directory, "seed.json");
    await writeFile(seedPath, JSON.stringify(seed), { mode: 0o600 });
    process.env.RENDRO_E2E_ORIGIN = url.origin;
    process.env.RENDRO_E2E_CONVEX = convex.origin;
    process.env.RENDRO_E2E_CONVEX_SITE = convex.site;
    process.env.RENDRO_E2E_MAIL = identity.control;
    process.env.RENDRO_E2E_FAULTS = faults.control;
    process.env.RENDRO_E2E_IMAGES = images.control;
    process.env.RENDRO_E2E_IMAGE_PROXY_SECRET = vars.IMAGE_PROXY_SECRET;
    process.env.RENDRO_E2E_SEED = seedPath;
    process.env.RENDRO_E2E_DIRECTORY = directory;
    console.log("E2E: real workerd ready; real local Convex, local R2 simulation, captured mail and OAuth, a fake image host, external fetch blocked.");
    return cleanup;
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "E2E startup and cleanup failed", { cause: cleanupError });
    }
    throw error;
  }
}
