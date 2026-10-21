import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexNames, main, productionSection, runCommand, secretNames, type CliResult, type Raw } from "../scripts/preflight-prod";
import { workers, type DeployableKey, type WorkerDeployable } from "../scripts/production-manifest";

const KV = "0123456789abcdef0123456789abcdef";
const D1 = "0f0e0d0c-0b0a-4908-8706-050403020100";
type Configs = Record<string, Raw>;

/** Production configurations with everything the manifest asks for. */
function wired(): Configs {
  return {
    "wrangler.toml": {
      name: "rendro",
      secrets: { required: ["CONVEX_INTERNAL_SECRET", "IMAGE_PROXY_SECRET", "REPO_CAPABILITY_SECRET", "REPO_CONTENT_KEY"] },
      vars: { NODE_ENV: "production", CONVEX_URL: "https://example.convex.cloud" },
      assets: { directory: "./public", binding: "ASSETS" },
      r2_buckets: [{ binding: "REPO_CONTENT", bucket_name: "rendro-ingest" }],
      kv_namespaces: [{ binding: "REPO_EPOCHS", id: KV }],
      services: [{ binding: "REPO_ACCESS", service: "rendro-control", entrypoint: "RepoAccessService" }],
      d1_databases: [{ binding: "REPO_SEARCH", database_name: "rendro-repo-search", database_id: D1 }],
      durable_objects: { bindings: [{ name: "REPO_INGEST", class_name: "RepoIngestCoordinator", script_name: "rendro-ingest" }] },
      ratelimits: [
        { name: "FIRST_VIEW_LIMIT", namespace_id: "1", simple: { limit: 20, period: 60 } },
        { name: "SEARCH_LIMIT", namespace_id: "2", simple: { limit: 60, period: 60 } },
        { name: "RUM_LIMIT", namespace_id: "3", simple: { limit: 60, period: 60 } },
      ],
      analytics_engine_datasets: [{ binding: "RUM_ANALYTICS", dataset: "rendro_rum" }],
      routes: [{ pattern: "rendro.app", custom_domain: true }],
      env: { development: { name: "rendro-dev", ratelimits: [{ name: "RUM_LIMIT", namespace_id: "9", simple: { limit: 60, period: 60 } }] } },
    },
    "wrangler.ingest.toml": {
      name: "rendro-ingest",
      workers_dev: false,
      secrets: { required: ["IMAGE_PROXY_SECRET", "REPO_CONTENT_KEY"] },
      r2_buckets: [{ binding: "INGEST_BUCKET", bucket_name: "rendro-ingest" }],
      queues: { producers: [{ binding: "INGEST_QUEUE", queue: "rendro-ingest" }], consumers: [{ queue: "rendro-ingest", dead_letter_queue: "rendro-ingest-dlq" }] },
      durable_objects: { bindings: [{ name: "INGEST_COORDINATOR", class_name: "RepoIngestCoordinator" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["RepoIngestCoordinator"] }],
      d1_databases: [{ binding: "REPO_SEARCH", database_name: "rendro-repo-search", database_id: D1 }],
      triggers: { crons: ["*/10 * * * *"] },
    },
    "wrangler.control.toml": {
      name: "rendro-control",
      workers_dev: false,
      secrets: { required: ["GITHUB_TOKEN_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_SECRET", "CONVEX_INTERNAL_SECRET"] },
      vars: { GITHUB_APP_CLIENT_ID: "Iv1.0000", CONVEX_URL: "https://example.convex.cloud" },
      durable_objects: { bindings: [
        { name: "REPO_ACCESS_DIRECTORY", class_name: "RepoAccessDirectory" },
        { name: "REPO_INGEST", class_name: "RepoIngestCoordinator", script_name: "rendro-ingest" },
      ] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["RepoAccessDirectory"] }],
      kv_namespaces: [{ binding: "REPO_EPOCHS", id: KV }],
      routes: [{ pattern: "hooks.example.com/v1/github/webhook", zone_name: "example.com" }],
    },
  };
}

/** Secret names set on each production Worker, as `wrangler secret list` reports them. */
function secretsSet(): Record<string, string[]> {
  return {
    rendro: ["CONVEX_INTERNAL_SECRET", "IMAGE_PROXY_SECRET", "REPO_CAPABILITY_SECRET", "REPO_CONTENT_KEY"],
    "rendro-ingest": ["IMAGE_PROXY_SECRET", "REPO_CONTENT_KEY"],
    "rendro-control": ["GITHUB_TOKEN_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_SECRET", "CONVEX_INTERNAL_SECRET"],
  };
}

const CONVEX_LIST = "SITE_URL=https://rendro.app\nAUTH_SECRET=hunter2-auth-value\nCONVEX_INTERNAL_SECRET=hunter2-internal-value\nRESEND_API_KEY=re_hunter2\nAUTH_EMAIL_FROM=Rendro <auth@rendro.app>\n";

function cli(secrets = secretsSet(), convex: CliResult = { code: 0, stdout: CONVEX_LIST }, overrides: Record<string, CliResult> = {}) {
  return vi.fn((_command: string, args: string[]): Promise<CliResult> => {
    if (args[1] === "convex") return Promise.resolve(convex);
    const worker = args[args.indexOf("--name") + 1]!;
    return Promise.resolve(overrides[worker] ?? { code: 0, stdout: JSON.stringify(secrets[worker]!.map((name) => ({ name, type: "secret_text" }))) });
  });
}

async function run(argv: string[], configs = wired(), runner = cli()) {
  const lines: string[] = [];
  const code = await main(argv, { readConfig: (path) => configs[path]!, run: runner, log: (line) => lines.push(line) });
  const text = lines.join("\n");
  /** The checklist line for `label` in the section whose heading mentions `worker`. */
  const line = (label: string, worker = "") => {
    const start = worker ? lines.findIndex((candidate) => !candidate.startsWith(" ") && (candidate.includes(`"${worker}"`) || candidate.startsWith(worker))) : 0;
    const found = lines.slice(start).find((candidate) => candidate.includes(` ${label}`));
    if (!found) throw new Error(`no line for ${label}:\n${text}`);
    return found;
  };
  const fixOf = (label: string, worker = "") => lines[lines.indexOf(line(label, worker)) + 1]!;
  return { code, lines, text, line, fixOf, runner };
}

const mutate = (change: (configs: Configs) => void) => { const configs = wired(); change(configs); return configs; };
const at = (configs: Configs, file: string) => configs[file]!;
const items = (cfg: Raw, key: string) => cfg[key] as Raw[];

let saved: Record<DeployableKey, WorkerDeployable>;
beforeEach(() => { saved = structuredClone(workers); });
afterEach(() => {
  for (const key of Object.keys(saved) as DeployableKey[]) workers[key] = saved[key];
  vi.restoreAllMocks();
});

describe("production preflight, offline (#333)", () => {
  it("passes a production that has everything the manifest lists", async () => {
    const { code, text, line } = await run([]);
    expect(code).toBe(0);
    expect(text).not.toContain("MISSING");
    expect(line("ASSETS (assets)")).toContain("ok");
    expect(line("REPO_ACCESS (service)")).toContain("rendro-control, entrypoint RepoAccessService");
    expect(line("RepoIngestCoordinator (migration)")).toContain("ok");
    expect(line("INGEST_QUEUE (queue consumer)")).toContain("consumes rendro-ingest, dead-letter queue rendro-ingest-dlq");
    expect(line("rendro.app (custom domain)")).toContain("ok");
    expect(line("/v1/github/webhook (route)")).toContain("hooks.example.com/v1/github/webhook");
    expect(line("REPO_CONTENT_KEY_PREVIOUS (secret)")).toMatch(/^\s+optional/);
    expect(line("CONVEX_SITE_URL (var-or-secret)")).toMatch(/^\s+optional/);
    expect(line("LOG_LEVEL (var)")).toMatch(/^\s+optional/);
    expect(line("AUTH_SECRET")).toMatch(/^\s+VERIFY/);
    expect(text).toContain("0 required items missing, 5 to verify (secrets and Convex: run --online with production credentials).");
  });

  it("checks secrets, vars and development-only settings", async () => {
    const configs = mutate((c) => {
      const serving = at(c, "wrangler.toml");
      serving.vars = { NODE_ENV: "development", IMAGE_PROXY_SECRET: "never-a-var", CONVEX_SITE_URL: "https://example.convex.site", LOG_LEVEL: "info", REPO_SHARED_CACHE_DEBUG: "1" };
      serving.secrets = { required: ["CONVEX_INTERNAL_SECRET", "IMAGE_PROXY_SECRET", "REPO_CONTENT_KEY", "REPO_CONTENT_KEY_PREVIOUS", 7] };
      at(c, "wrangler.ingest.toml").secrets = { required: ["IMAGE_PROXY_SECRET", "REPO_CONTENT_KEY", "GITHUB_API_ORIGIN"] };
      const control = at(c, "wrangler.control.toml");
      control.vars = {};
      control.secrets = { required: ["GITHUB_TOKEN_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_SECRET", "CONVEX_INTERNAL_SECRET", "CONVEX_URL"] };
    });
    const { code, line, fixOf } = await run([], configs);
    expect(code).toBe(1);
    expect(line("NODE_ENV (var)")).toContain('MISSING   NODE_ENV (var): is "development"');
    expect(fixOf("NODE_ENV (var)")).toContain('set NODE_ENV = "production" in [vars] of wrangler.toml (top level)');
    expect(line("IMAGE_PROXY_SECRET (secret)")).toContain("is a plain [vars] entry");
    expect(fixOf("IMAGE_PROXY_SECRET (secret)")).toContain("remove it from [vars], then pnpm exec wrangler secret put IMAGE_PROXY_SECRET --config wrangler.toml");
    expect(line("REPO_CAPABILITY_SECRET (secret)")).toContain("MISSING   REPO_CAPABILITY_SECRET (secret): not in [secrets] required");
    expect(line("REPO_CONTENT_KEY_PREVIOUS (secret)")).toContain("ok        REPO_CONTENT_KEY_PREVIOUS (secret): declared in [secrets] required");
    expect(line("CONVEX_URL (var-or-secret)")).toContain("VERIFY    CONVEX_URL (var-or-secret): not in [vars]; confirm it is a secret with --online");
    expect(line("CONVEX_SITE_URL (var-or-secret)")).toContain("ok        CONVEX_SITE_URL (var-or-secret): set in [vars]");
    expect(line("LOG_LEVEL (var)")).toContain("ok        LOG_LEVEL (var): set in [vars]");
    expect(line("REPO_SHARED_CACHE_DEBUG (var)")).toContain("MISSING   REPO_SHARED_CACHE_DEBUG (var): set in production");
    expect(fixOf("REPO_SHARED_CACHE_DEBUG (var)")).toContain("remove REPO_SHARED_CACHE_DEBUG from wrangler.toml (top level)");
    expect(line("GITHUB_API_ORIGIN (var)", "rendro-ingest")).toContain("MISSING   GITHUB_API_ORIGIN (var): set in production");
    expect(line("GITHUB_APP_CLIENT_ID (var)", "rendro-control")).toContain("MISSING");
    expect(fixOf("GITHUB_APP_CLIENT_ID (var)", "rendro-control")).toContain("add GITHUB_APP_CLIENT_ID = <value> to [vars] in wrangler.control.toml (top level)");
    expect(line("CONVEX_URL (var)", "rendro-control")).toContain("MISSING");
  });

  it("asks for a declared secret when a var-or-secret is declared there, and for the expected value of a missing var", async () => {
    const configs = mutate((c) => {
      const serving = at(c, "wrangler.toml");
      serving.vars = {};
      (serving.secrets as { required: string[] }).required.push("CONVEX_URL");
    });
    const { line, fixOf } = await run([], configs);
    expect(line("CONVEX_URL (var-or-secret)")).toContain("ok        CONVEX_URL (var-or-secret): declared in [secrets] required");
    expect(fixOf("NODE_ENV (var)")).toContain('add NODE_ENV = "production" to [vars] in wrangler.toml (top level)');
  });

  it("reports a missing binding with the command that creates it", async () => {
    const configs = mutate((c) => {
      const serving = at(c, "wrangler.toml");
      for (const key of ["assets", "r2_buckets", "kv_namespaces", "services", "d1_databases", "durable_objects", "ratelimits", "analytics_engine_datasets", "routes"]) delete serving[key];
      const ingest = at(c, "wrangler.ingest.toml");
      for (const key of ["queues", "durable_objects", "triggers", "workers_dev"]) delete ingest[key];
      const control = at(c, "wrangler.control.toml");
      control.routes = [{ pattern: 42 }, { pattern: "hooks.example.com/other" }];
      control.workers_dev = true;
    });
    const { code, line, fixOf } = await run([], configs);
    expect(code).toBe(1);
    expect(fixOf("ASSETS (assets)")).toContain('add [assets] binding = "ASSETS" to wrangler.toml (top level)');
    expect(fixOf("REPO_CONTENT (r2)")).toContain("pnpm exec wrangler r2 bucket create rendro-ingest (if it does not exist)");
    expect(fixOf("REPO_EPOCHS (kv)")).toContain("pnpm exec wrangler kv namespace create rendro-repo-epochs (once)");
    expect(fixOf("REPO_ACCESS (service)")).toContain('deploy the Control Worker first, then add [[services]] binding = "REPO_ACCESS", service = "rendro-control", entrypoint = "RepoAccessService"');
    expect(fixOf("REPO_SEARCH (d1)")).toContain("pnpm exec wrangler d1 create rendro-repo-search (once)");
    expect(fixOf("REPO_INGEST (durable-object)")).toContain('deploy the Ingest Worker first, then add [[durable_objects.bindings]] name = "REPO_INGEST", class_name = "RepoIngestCoordinator", script_name = "rendro-ingest"');
    expect(fixOf("FIRST_VIEW_LIMIT (ratelimit)")).toContain("simple = { limit = 20, period = 60 }");
    expect(fixOf("RUM_ANALYTICS (analytics)")).toContain("enable Analytics Engine on the account");
    expect(line("rendro.app (custom domain)")).toContain("VERIFY    rendro.app (custom domain): not in the configuration");
    expect(fixOf("INGEST_QUEUE (queue-producer)", "rendro-ingest")).toContain("pnpm exec wrangler queues create rendro-ingest (once)");
    expect(fixOf("INGEST_QUEUE (queue consumer)", "rendro-ingest")).toContain('add [[queues.consumers]] queue = "rendro-ingest", dead_letter_queue = "rendro-ingest-dlq"');
    expect(fixOf("INGEST_COORDINATOR (durable-object)", "rendro-ingest")).toMatch(/-> add \[\[durable_objects.bindings]] name = "INGEST_COORDINATOR", class_name = "RepoIngestCoordinator" to/);
    expect(fixOf("*/10 * * * * (cron)", "rendro-ingest")).toContain('add "*/10 * * * *" to [triggers] crons');
    expect(line("workers_dev", "rendro-ingest")).toContain("is unset (Wrangler's default)");
    expect(line("/v1/github/webhook (route)", "rendro-control")).toContain("MISSING");
    expect(line("workers_dev", "rendro-control")).toContain("is true");
  });

  it("refuses placeholders, mismatched resources and wrong targets", async () => {
    const configs = mutate((c) => {
      const serving = at(c, "wrangler.toml");
      items(serving, "r2_buckets")[0]!.bucket_name = "another-bucket";
      items(serving, "kv_namespaces")[0]!.id = "f".repeat(32);
      items(serving, "d1_databases")[0]!.database_id = "1f0e0d0c-0b0a-4908-8706-050403020100";
      (serving.durable_objects as { bindings: Raw[] }).bindings[0]!.class_name = "Other";
      items(serving, "services")[0]!.entrypoint = undefined;
      items(serving, "ratelimits")[0]!.simple = { limit: 10, period: 60 };
      items(serving, "ratelimits")[2]!.namespace_id = "9";
      const control = at(c, "wrangler.control.toml");
      items(control, "kv_namespaces")[0]!.id = "rendro-repo-epochs-dev";
      (control.durable_objects as { bindings: Raw[] }).bindings[1]!.script_name = undefined;
      control.migrations = [];
      const ingest = at(c, "wrangler.ingest.toml");
      items(ingest, "d1_databases")[0]!.database_id = "rendro-repo-search-dev";
      (ingest.queues as { consumers: Raw[] }).consumers[0]!.dead_letter_queue = undefined;
      ingest.name = "rendro-ingest-dev";
    });
    const { line } = await run([], configs);
    expect(line("REPO_CONTENT (r2)")).toContain("ok");
    expect(line("REPO_CONTENT (r2): bucket_name")).toContain("bucket_name another-bucket differs from Ingest Worker's INGEST_BUCKET (rendro-ingest)");
    expect(line("REPO_EPOCHS (kv): id")).toContain(`id ${"f".repeat(32)} differs from Control Worker's REPO_EPOCHS (rendro-repo-epochs-dev)`);
    expect(line("REPO_SEARCH (d1): database_id")).toContain("differs from Ingest Worker's REPO_SEARCH (rendro-repo-search-dev)");
    expect(line("REPO_INGEST (durable-object)")).toContain("bound to class Other of rendro-ingest");
    expect(line("REPO_ACCESS (service)")).toContain("bound to rendro-control without an entrypoint");
    expect(line("FIRST_VIEW_LIMIT (ratelimit)")).toContain("limit 10 per 60 s, not 20 per 60 s");
    expect(line("RUM_LIMIT (ratelimit)")).toContain("namespace_id 9 is also used by wrangler.toml [env.development]");
    expect(line("REPO_EPOCHS (kv)", "rendro-control")).toContain('id "rendro-repo-epochs-dev" is a placeholder, not a namespace ID');
    expect(line("REPO_INGEST (durable-object)", "rendro-control")).toMatch(/bound to class RepoIngestCoordinator$/);
    expect(line("RepoAccessDirectory (migration)", "rendro-control")).toContain("no migration creates the class");
    expect(line("REPO_SEARCH (d1)", "rendro-ingest")).toContain('database_id "rendro-repo-search-dev" is a placeholder, not a database ID');
    expect(line("INGEST_QUEUE (queue consumer)", "rendro-ingest")).toContain("consumes rendro-ingest without a dead-letter queue");
    expect(line("Worker name", "rendro-ingest")).toContain('wrangler.ingest.toml (top level) deploys "rendro-ingest-dev", not "rendro-ingest"');
  });

  it("names the service a binding points at, finds a single route, and refuses a dead-letter queue that is the queue itself", async () => {
    const configs = mutate((c) => {
      items(at(c, "wrangler.toml"), "services")[0]!.service = "rendro-control-dev";
      const control = at(c, "wrangler.control.toml");
      delete control.routes;
      control.route = "hooks.example.com/v1/github/webhook";
      const ingest = at(c, "wrangler.ingest.toml");
      ingest.queues = { consumers: [{ queue: "rendro-ingest", dead_letter_queue: "rendro-ingest" }] };
    });
    const { line } = await run([], configs);
    expect(line("REPO_ACCESS (service)")).toContain("bound to rendro-control-dev, entrypoint RepoAccessService");
    expect(line("/v1/github/webhook (route)", "rendro-control")).toContain("ok");
    expect(line("INGEST_QUEUE (queue-producer)", "rendro-ingest")).toContain("MISSING");
    expect(line("INGEST_QUEUE (queue consumer)", "rendro-ingest")).toContain("without a dead-letter queue");
  });

  it("lists a missing optional binding or wiring without failing", async () => {
    workers.serving.bindings.find((item) => item.name === "ASSETS")!.need = "optional";
    workers.ingest.wiring.find((item) => item.kind === "cron")!.need = "optional";
    const configs = mutate((c) => { delete at(c, "wrangler.toml").assets; delete at(c, "wrangler.ingest.toml").triggers; });
    const { code, line } = await run([], configs);
    expect(code).toBe(0);
    expect(line("ASSETS (assets)")).toMatch(/^\s+optional/);
    expect(line("*/10 * * * * (cron)")).toMatch(/^\s+optional/);
  });

  it("reads a named production environment with Wrangler's inheritance, and reports one that does not exist", async () => {
    workers.serving.env = "production";
    workers.ingest.env = "production";
    const configs = mutate((c) => {
      const { routes, env, ...serving } = at(c, "wrangler.toml");
      c["wrangler.toml"] = { name: "rendro-base", routes, env: { ...(env as Raw), production: { ...serving, name: "rendro" } } };
    });
    const { code, line, text } = await run(["--report"], configs);
    expect(code).toBe(0);
    expect(text).toContain('Serving Worker "rendro": wrangler.toml [env.production], deployed by `pnpm run deploy`');
    expect(line("rendro.app (custom domain)")).toContain("ok");
    expect(line("RUM_LIMIT (ratelimit)")).toContain("ok");
    expect(line("production section", "rendro-ingest")).toContain("wrangler.ingest.toml [env.production] does not exist");
    const online = await run(["--online"], configs);
    expect(online.line("production section", "rendro-ingest")).toContain("MISSING");
    expect(online.line("IMAGE_PROXY_SECRET (secret)", "rendro-ingest")).toContain("secret set");
  });

  it("resolves the production section", () => {
    const raw = { name: "rendro-ingest-dev", workers_dev: false, triggers: { crons: ["* * * * *"] }, vars: { A: "1" }, env: { production: { vars: { B: "2" }, workers_dev: true } } };
    expect(productionSection(raw, null)).toBe(raw);
    expect(productionSection(raw, "staging")).toBeNull();
    expect(productionSection(raw, "production")).toEqual({ name: "rendro-ingest-dev-production", workers_dev: true, triggers: { crons: ["* * * * *"] }, vars: { B: "2" } });
    expect(productionSection({ env: { production: "not a table" } }, "production")).toEqual({ name: undefined });
  });

  it("rejects unknown arguments", async () => {
    const { code, text } = await run(["--prod"]);
    expect(code).toBe(2);
    expect(text).toBe("Unknown argument --prod. usage: pnpm preflight:prod [--report] [--online]");
  });

  it("fails while anything required is missing, unless asked only to report", async () => {
    const configs = mutate((c) => { delete at(c, "wrangler.toml").analytics_engine_datasets; });
    const failing = await run([], configs);
    expect(failing.code).toBe(1);
    expect(failing.text).toContain("1 required item missing, 5 to verify");
    expect((await run(["--report"], configs)).code).toBe(0);
  });
});

describe("production preflight, online (#333)", () => {
  it("diffs secret and env var names, and never prints a value", async () => {
    const runner = cli();
    const { code, text, line } = await run(["--online"], wired(), runner);
    expect(code).toBe(0);
    expect(text).toContain("Production preflight (offline and online)");
    expect(text).toContain("0 required items missing, 0 to verify.");
    expect(line("CONVEX_URL (var-or-secret)")).toContain("ok        CONVEX_URL (var-or-secret): set in [vars]");
    expect(line("REPO_CAPABILITY_SECRET (secret): secret set")).toMatch(/^\s+ok/);
    expect(line("AUTH_SECRET", "Convex")).toContain("ok        AUTH_SECRET: set");
    expect(text).not.toMatch(/hunter2|example\.convex/);
    expect(runner.mock.calls).toEqual([
      ["pnpm", ["exec", "wrangler", "secret", "list", "--name", "rendro", "--format", "json"]],
      ["pnpm", ["exec", "wrangler", "secret", "list", "--name", "rendro-ingest", "--format", "json"]],
      ["pnpm", ["exec", "wrangler", "secret", "list", "--name", "rendro-control", "--format", "json"]],
      ["pnpm", ["exec", "convex", "env", "list", "--prod", "--names-only"]],
    ]);
  });

  it("reports missing, misplaced, development-only and unused names", async () => {
    const secrets = secretsSet();
    secrets.rendro = ["CONVEX_INTERNAL_SECRET", "IMAGE_PROXY_SECRET", "REPO_CONTENT_KEY", "OLD_UPLOAD_SECRET"];
    secrets["rendro-ingest"] = ["IMAGE_PROXY_SECRET", "REPO_CONTENT_KEY", "GITHUB_API_ORIGIN"];
    secrets["rendro-control"] = ["GITHUB_TOKEN_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_SECRET", "CONVEX_INTERNAL_SECRET", "CONVEX_URL"];
    const configs = mutate((c) => { at(c, "wrangler.toml").vars = { NODE_ENV: "production" }; });
    const convex = { code: 0, stdout: "SITE_URL=https://rendro.app\nAUTH_SECRET=hunter2\nCONVEX_SITE_URL=https://x.convex.site\nLEGACY_GOOGLE_SECRET=hunter2-google\n" };
    const { code, text, line, fixOf } = await run(["--online"], configs, cli(secrets, convex));
    expect(code).toBe(1);
    expect(line("REPO_CAPABILITY_SECRET (secret): not set")).toContain("not set on the production Worker");
    expect(fixOf("REPO_CAPABILITY_SECRET (secret): not set")).toContain("pnpm exec wrangler secret put REPO_CAPABILITY_SECRET --name rendro");
    expect(line("CONVEX_URL (var-or-secret)")).toContain("MISSING   CONVEX_URL (var-or-secret): not set on the production Worker");
    expect(line("REPO_CONTENT_KEY_PREVIOUS (secret): not set")).toMatch(/^\s+optional/);
    expect(line("OLD_UPLOAD_SECRET")).toContain("unused    OLD_UPLOAD_SECRET: secret set but not in the manifest");
    expect(line("GITHUB_API_ORIGIN (var): set as a secret", "rendro-ingest")).toContain("MISSING");
    expect(fixOf("GITHUB_API_ORIGIN (var): set as a secret", "rendro-ingest")).toContain("pnpm exec wrangler secret delete GITHUB_API_ORIGIN --name rendro-ingest");
    expect(line("CONVEX_URL (var): set as a secret", "rendro-control")).toContain("the manifest expects a [vars] entry");
    expect(line("RESEND_API_KEY", "Convex")).toContain("MISSING   RESEND_API_KEY: not set");
    expect(fixOf("RESEND_API_KEY", "Convex")).toContain("pnpm exec convex env set --prod RESEND_API_KEY <value>");
    expect(line("LEGACY_GOOGLE_SECRET", "Convex")).toContain("unused");
    expect(text).not.toContain("CONVEX_SITE_URL: set but not in the manifest");
    expect(text).not.toContain("hunter2");
  });

  it("never echoes output it cannot read, and reports a failed command without its output", async () => {
    const overrides = {
      rendro: { code: 0, stdout: "REPO_CONTENT_KEY=hunter2-not-json" },
      "rendro-ingest": { code: 0, stdout: JSON.stringify({ error: "hunter2-object" }) },
      "rendro-control": { code: 1, stdout: "hunter2-partial" },
    };
    const { code, text, line } = await run(["--online"], wired(), cli(secretsSet(), { code: 0, stdout: "SITE_URL=x\n  AUTH_SECRET = hunter2 spaced\nnot a variable line hunter2\n" }, overrides));
    expect(code).toBe(1);
    expect(line("secret names", "rendro")).toContain("wrangler secret list --name rendro: could not read its output (1 line, not shown: it may contain values)");
    expect(line("secret names", "rendro-ingest")).toContain("could not read its output (1 line,");
    expect(line("secret names", "rendro-control")).toContain("wrangler secret list --name rendro-control failed (exit 1); run it yourself to see why");
    expect(line("env var names", "Convex")).toContain("could not read its output (3 lines, not shown: it may contain values)");
    expect(text).not.toContain("hunter2");
    const failed = await run(["--online"], wired(), cli(secretsSet(), { code: 2, stdout: "hunter2" }));
    expect(failed.line("env var names", "Convex")).toContain("convex env list --prod failed (exit 2)");
    expect(failed.text).not.toContain("hunter2");
  });

  it("keeps names and drops values from the CLI output", () => {
    expect(secretNames(JSON.stringify([{ name: "A_SECRET", type: "secret_text", value: "hunter2" }, { name: "bad name" }, { type: "x" }, null]))).toEqual(["A_SECRET"]);
    expect(secretNames("not json")).toBeNull();
    expect(secretNames("{}")).toBeNull();
    expect(convexNames("A=hunter2=with=equals\r\nB=\nC\n\n")).toEqual(["A", "B", "C"]);
    expect(convexNames("")).toEqual([]);
    expect(convexNames("A=1\n= value only\n")).toBeNull();
  });
});

describe("preflight command", () => {
  it("runs a command without a shell and keeps only its exit status and stdout", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stdout.write('names'); process.stderr.write('hunter2')"])).resolves.toEqual({ code: 0, stdout: "names" });
    await expect(runCommand(process.execPath, ["-e", "process.stdout.write('x'); process.exit(3)"])).resolves.toEqual({ code: 3, stdout: "x" });
    await expect(runCommand("rendro-no-such-command-333", [])).resolves.toEqual({ code: 1, stdout: "" });
  });

  it("checks the repository's wrangler files when run as a script", async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [argv[0]!, new URL("../scripts/preflight-prod.ts", import.meta.url).pathname, "--report"];
    try {
      vi.resetModules();
      await import("../scripts/preflight-prod");
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\d+ required items? missing, \d+ to verify/));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Serving Worker "rendro": wrangler.toml (top level)'));
      // Every top level is the production Worker; the development Workers live under [env.development] (#336).
      const text = log.mock.calls.map(([line]) => String(line)).join("\n");
      for (const worker of ["rendro", "rendro-ingest", "rendro-control"]) expect(text).toContain(`ok        Worker name: ${worker}\n`);
      expect(text).not.toMatch(/rendro-[a-z-]+-dev\b/);
      // The ingest and control skeletons bind no production resource until the owner creates them.
      expect(text).toContain("MISSING   INGEST_BUCKET (r2): ");
      expect(text).toContain("MISSING   REPO_SEARCH (d1): The search index");
      expect(text).toContain("MISSING   REPO_EPOCHS (kv): Revocation epochs, read by the serving Worker");
      expect(process.exitCode).toBe(0);
    } finally { process.argv = argv; process.exitCode = exitCode; }
  });

  it("is importable without an executable path", async () => {
    const argv = process.argv;
    process.argv = [argv[0]!];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try { vi.resetModules(); await import("../scripts/preflight-prod"); } finally { process.argv = argv; }
    expect(log).not.toHaveBeenCalled();
  });
});
