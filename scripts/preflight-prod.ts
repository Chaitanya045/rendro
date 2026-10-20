/**
 * Production preflight (#333): compares scripts/production-manifest.ts with each Worker's production
 * wrangler configuration and prints a checklist of what is present, what is missing and how to create it.
 *
 *   pnpm preflight:prod             offline: the wrangler files only; exit 1 if anything required is missing
 *   pnpm preflight:prod --report    print the checklist, always exit 0
 *   pnpm preflight:prod --online    also diff the secret names set on each production Worker
 *                                   (`wrangler secret list`) and the Convex production env var names
 *                                   (`convex env list --prod`). Owner-run, with the owner's credentials.
 *
 * Only names are ever printed. CLI output is parsed for names, and values are dropped before anything
 * is logged; output that cannot be parsed is reported by its line count, never echoed.
 */
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { convexDeployable, workers, type Binding, type DeployableKey, type Setting, type WorkerDeployable, type Wiring } from "./production-manifest";

export type Raw = Record<string, unknown>;
type Status = "ok" | "missing" | "verify" | "optional" | "unused";
interface Line { status: Status; label: string; detail: string; fix?: string }
interface Section { key: DeployableKey; deployable: WorkerDeployable; raw: Raw; cfg: Raw | null; where: string }
export interface CliResult { code: number; stdout: string }
export interface Dependencies {
  readConfig(path: string): Raw;
  run(command: string, args: string[]): Promise<CliResult>;
  log(line: string): void;
}

const KV_ID = /^[0-9a-f]{32}$/;
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Keys an `[env.<name>]` section inherits from the top level (Wrangler's `inheritable`); bindings are never inherited. */
const INHERITED = ["routes", "route", "workers_dev", "triggers", "migrations"];

const record = (value: unknown): Raw => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Raw : {});
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.map(record) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The section production deploys: the top level, or `[env.<name>]` with Wrangler's inheritance. */
export function productionSection(raw: Raw, env: string | null): Raw | null {
  if (env === null) return raw;
  const section = record(raw.env)[env];
  if (section === undefined) return null;
  const own = record(section);
  const inherited = Object.fromEntries(INHERITED.filter((key) => own[key] === undefined && raw[key] !== undefined).map((key) => [key, raw[key]]));
  return { ...inherited, name: typeof raw.name === "string" ? `${raw.name}-${env}` : undefined, ...own };
}

function binding(cfg: Raw | null, path: string[], key: string, name: unknown): Raw | undefined {
  let value: unknown = cfg;
  for (const part of path) value = record(value)[part];
  return list(value).find((entry) => entry[key] === name);
}

function routes(cfg: Raw): Raw[] {
  const all = [...(Array.isArray(cfg.routes) ? cfg.routes : []), ...(cfg.route === undefined ? [] : [cfg.route])];
  return all.map((route) => (typeof route === "string" ? { pattern: route } : record(route)));
}

const location = (config: string, env: string | null) => `${config} ${env === null ? "(top level)" : `[env.${env}]`}`;

/** Every rate-limit namespace ID in every section of every configuration, with where it is. */
function namespaceIds(sections: Section[]): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  for (const section of sections) {
    const all = [[null, section.raw], ...Object.entries(record(section.raw.env))] as const;
    for (const [env, cfg] of all) {
      for (const limit of list(record(cfg).ratelimits)) {
        const id = String(limit.namespace_id);
        ids.set(id, [...(ids.get(id) ?? []), location(section.deployable.config, env)]);
      }
    }
  }
  return ids;
}

function settingLine(setting: Setting, cfg: Raw, target: string): Line {
  const vars = record(cfg.vars);
  const required = strings(record(cfg.secrets).required);
  const label = `${setting.name} (${setting.kind})`;
  const asVar = setting.name in vars;
  const asSecret = required.includes(setting.name);
  if (setting.need === "forbidden") {
    return asVar || asSecret
      ? { status: "missing", label, detail: `set in production: ${setting.purpose}`, fix: `remove ${setting.name} from ${target}` }
      : { status: "ok", label, detail: "absent (development and tests only)" };
  }
  const put = `pnpm exec wrangler secret put ${setting.name} --config ${target.split(" ")[0]!}`;
  if (setting.kind === "secret") {
    if (asVar) return { status: "missing", label, detail: "is a plain [vars] entry; a secret must never be a var", fix: `remove it from [vars], then ${put}` };
    if (asSecret) return { status: "ok", label, detail: "declared in [secrets] required" };
    return setting.need === "required"
      ? { status: "missing", label, detail: `not in [secrets] required: ${setting.purpose}`, fix: `add "${setting.name}" to [secrets] required in ${target}, then ${put}` }
      : { status: "optional", label, detail: setting.purpose };
  }
  if (asVar) {
    if (setting.value !== undefined && vars[setting.name] !== setting.value) {
      return { status: "missing", label, detail: `is "${String(vars[setting.name])}"`, fix: `set ${setting.name} = "${setting.value}" in [vars] of ${target}` };
    }
    return { status: "ok", label, detail: "set in [vars]" };
  }
  if (setting.kind === "var-or-secret") {
    if (asSecret) return { status: "ok", label, detail: "declared in [secrets] required" };
    if (setting.need === "required") return { status: "verify", label, detail: `not in [vars]; confirm it is a secret with --online: ${setting.purpose}`, fix: `${put}, or add it to [vars]` };
  }
  return setting.need === "required"
    ? { status: "missing", label, detail: setting.purpose, fix: `add ${setting.name} = ${setting.value === undefined ? "<value>" : `"${setting.value}"`} to [vars] in ${target}` }
    : { status: "optional", label, detail: setting.purpose };
}

function bindingLines(item: Binding, section: Section, sections: Record<DeployableKey, Section>, ids: Map<string, string[]>): Line[] {
  const cfg = section.cfg!;
  const target = section.where;
  const label = `${item.name} (${item.kind})`;
  const missing = (detail: string, fix: string): Line[] => [{ status: item.need === "required" ? "missing" : "optional", label, detail, fix }];
  const peer = (sameAs: { deployable: DeployableKey; binding: string } | undefined, path: string[], key: string): Line[] => {
    if (!sameAs) return [];
    const mine = binding(cfg, path, "binding", item.name)![key];
    const theirs = binding(sections[sameAs.deployable].cfg, path, "binding", sameAs.binding)?.[key];
    if (theirs === undefined || theirs === mine) return [];
    return [{ status: "missing", label, detail: `${key} ${String(mine)} differs from ${sections[sameAs.deployable].deployable.title}'s ${sameAs.binding} (${String(theirs)})`, fix: `bind the same ${item.kind.toUpperCase()} resource in both` }];
  };
  switch (item.kind) {
    case "assets":
      return record(cfg.assets).binding === item.name ? [{ status: "ok", label, detail: "[assets] binding" }] : missing(item.purpose, `add [assets] binding = "${item.name}" to ${target}`);
    case "r2": {
      const entry = binding(cfg, ["r2_buckets"], "binding", item.name);
      if (!entry) return missing(item.purpose, `pnpm exec wrangler r2 bucket create ${item.bucket} (if it does not exist); add [[r2_buckets]] binding = "${item.name}", bucket_name = "${item.bucket}" to ${target}`);
      return [{ status: "ok", label, detail: `bucket ${String(entry.bucket_name)}` }, ...peer(item.sameAs, ["r2_buckets"], "bucket_name")];
    }
    case "kv": {
      const entry = binding(cfg, ["kv_namespaces"], "binding", item.name);
      const create = `pnpm exec wrangler kv namespace create ${item.namespace}`;
      if (!entry) return missing(item.purpose, `${create} (once); add [[kv_namespaces]] binding = "${item.name}", id = "<namespace ID>" to ${target}`);
      if (!KV_ID.test(String(entry.id))) return missing(`id "${String(entry.id)}" is a placeholder, not a namespace ID`, `${create} (once) and put its ID in ${target}`);
      return [{ status: "ok", label, detail: "namespace ID set" }, ...peer(item.sameAs, ["kv_namespaces"], "id")];
    }
    case "d1": {
      const entry = binding(cfg, ["d1_databases"], "binding", item.name);
      const create = `pnpm exec wrangler d1 create ${item.database}`;
      if (!entry) return missing(item.purpose, `${create} (once); add [[d1_databases]] binding = "${item.name}", database_name = "${item.database}", database_id = "<ID>" to ${target}`);
      if (!D1_ID.test(String(entry.database_id))) return missing(`database_id "${String(entry.database_id)}" is a placeholder, not a database ID`, `${create} (once) and put its ID in ${target}`);
      return [{ status: "ok", label, detail: `database ${String(entry.database_name)}` }, ...peer(item.sameAs, ["d1_databases"], "database_id")];
    }
    case "queue-producer": {
      const entry = binding(cfg, ["queues", "producers"], "binding", item.name);
      return entry
        ? [{ status: "ok", label, detail: `queue ${String(entry.queue)}` }]
        : missing(item.purpose, `pnpm exec wrangler queues create ${item.queue} (once); add [[queues.producers]] binding = "${item.name}", queue = "${item.queue}" to ${target}`);
    }
    case "durable-object": {
      const entry = binding(cfg, ["durable_objects", "bindings"], "name", item.name);
      const script = item.script ? sections[item.script].deployable.worker : undefined;
      const add = `add [[durable_objects.bindings]] name = "${item.name}", class_name = "${item.className}"${script ? `, script_name = "${script}"` : ""} to ${target}`;
      if (!entry) return missing(item.purpose, item.script ? `deploy the ${sections[item.script].deployable.title} first, then ${add}` : add);
      if (entry.class_name !== item.className || entry.script_name !== script) {
        return missing(`bound to class ${String(entry.class_name)}${entry.script_name ? ` of ${String(entry.script_name)}` : ""}`, add);
      }
      const lines: Line[] = [{ status: "ok", label, detail: `class ${item.className}${script ? ` of ${script}` : ""}` }];
      if (!script) {
        const migrated = list(cfg.migrations).some((migration) => strings(migration.new_sqlite_classes).includes(item.className));
        lines.push(migrated
          ? { status: "ok", label: `${item.className} (migration)`, detail: "SQLite class created by a migration" }
          : { status: "missing", label: `${item.className} (migration)`, detail: "no migration creates the class", fix: `add [[migrations]] tag = "v1", new_sqlite_classes = ["${item.className}"] to ${target}` });
      }
      return lines;
    }
    case "service": {
      const entry = binding(cfg, ["services"], "binding", item.name);
      const worker = sections[item.service].deployable.worker;
      const add = `add [[services]] binding = "${item.name}", service = "${worker}", entrypoint = "${item.entrypoint}" to ${target}`;
      if (!entry) return missing(item.purpose, `deploy the ${sections[item.service].deployable.title} first, then ${add}`);
      return entry.service === worker && entry.entrypoint === item.entrypoint
        ? [{ status: "ok", label, detail: `${worker}, entrypoint ${item.entrypoint}` }]
        : missing(`bound to ${String(entry.service)}${entry.entrypoint ? `, entrypoint ${String(entry.entrypoint)}` : " without an entrypoint"}`, add);
    }
    case "ratelimit": {
      const entry = binding(cfg, ["ratelimits"], "name", item.name);
      const add = `add [[ratelimits]] name = "${item.name}", namespace_id = "<unique in the account>", simple = { limit = ${item.limit}, period = ${item.period} } to ${target}`;
      if (!entry) return missing(item.purpose, add);
      const simple = record(entry.simple);
      if (simple.limit !== item.limit || simple.period !== item.period) {
        return missing(`limit ${String(simple.limit)} per ${String(simple.period)} s, not ${item.limit} per ${item.period} s`, add);
      }
      const shared = ids.get(String(entry.namespace_id))!.filter((where) => where !== section.where);
      if (shared.length) return missing(`namespace_id ${String(entry.namespace_id)} is also used by ${shared.join(", ")}`, `give ${item.name} a namespace_id unique in the account`);
      return [{ status: "ok", label, detail: `${item.limit} per ${item.period} s, namespace ${String(entry.namespace_id)}` }];
    }
    case "analytics": {
      const entry = binding(cfg, ["analytics_engine_datasets"], "binding", item.name);
      return entry
        ? [{ status: "ok", label, detail: `dataset ${String(entry.dataset)}` }]
        : missing(item.purpose, `enable Analytics Engine on the account; add [[analytics_engine_datasets]] binding = "${item.name}", dataset = "${item.dataset}" to ${target}`);
    }
  }
}

function wiringLine(item: Wiring, section: Section): Line {
  const cfg = section.cfg!;
  const target = section.where;
  const fail = (label: string, detail: string, fix: string): Line => ({ status: item.need === "required" ? "missing" : "optional", label, detail, fix });
  switch (item.kind) {
    case "queue-consumer": {
      const label = `${item.producer} (queue consumer)`;
      const producer = section.deployable.bindings.find((candidate) => candidate.name === item.producer) as Extract<Binding, { kind: "queue-producer" }>;
      const queue = binding(cfg, ["queues", "producers"], "binding", item.producer)?.queue ?? producer.queue;
      const entry = binding(cfg, ["queues", "consumers"], "queue", queue);
      const add = `pnpm exec wrangler queues create ${item.deadLetterQueue} (once); add [[queues.consumers]] queue = "${String(queue)}", dead_letter_queue = "${item.deadLetterQueue}" to ${target}`;
      if (!entry) return fail(label, item.purpose, add);
      return typeof entry.dead_letter_queue === "string" && entry.dead_letter_queue !== queue
        ? { status: "ok", label, detail: `consumes ${String(queue)}, dead-letter queue ${entry.dead_letter_queue}` }
        : fail(label, `consumes ${String(queue)} without a dead-letter queue`, add);
    }
    case "cron":
      return strings(record(cfg.triggers).crons).includes(item.schedule)
        ? { status: "ok", label: `${item.schedule} (cron)`, detail: "scheduled handler" }
        : fail(`${item.schedule} (cron)`, item.purpose, `add "${item.schedule}" to [triggers] crons in ${target}`);
    case "custom-domain":
      return routes(cfg).some((route) => route.pattern === item.pattern && route.custom_domain === true)
        ? { status: "ok", label: `${item.pattern} (custom domain)`, detail: "custom_domain route" }
        : { status: "verify", label: `${item.pattern} (custom domain)`, detail: "not in the configuration; confirm it is attached to the Worker in the dashboard", fix: `or add routes = [{ pattern = "${item.pattern}", custom_domain = true }] to ${target}` };
    case "route": {
      const label = `${item.path} (route)`;
      const route = routes(cfg).find((candidate) => typeof candidate.pattern === "string" && candidate.pattern.replace(/^[^/]*/, "") === item.path);
      return route
        ? { status: "ok", label, detail: String(route.pattern) }
        : fail(label, item.purpose, `add routes = [{ pattern = "<host>${item.path}", zone_name = "<zone>" }] to ${target} and set that URL as the GitHub App's webhook URL`);
    }
    case "workers-dev":
      return cfg.workers_dev === item.enabled
        ? { status: "ok", label: "workers_dev", detail: String(item.enabled) }
        : fail("workers_dev", `is ${String(cfg.workers_dev ?? "unset (Wrangler's default)")}: ${item.purpose}`, `set workers_dev = ${String(item.enabled)} in ${target}`);
  }
}

function sectionOf(key: DeployableKey, deployable: WorkerDeployable, deps: Dependencies): Section {
  const raw = deps.readConfig(deployable.config);
  const where = location(deployable.config, deployable.env);
  return { key, deployable, raw, cfg: productionSection(raw, deployable.env), where };
}

/** The offline checklist, per Worker. */
function offlineLines(sections: Record<DeployableKey, Section>): Map<DeployableKey, Line[]> {
  const ids = namespaceIds(Object.values(sections));
  const result = new Map<DeployableKey, Line[]>();
  for (const section of Object.values(sections)) {
    const { deployable, cfg } = section;
    if (!cfg) {
      result.set(section.key, [{ status: "missing", label: "production section", detail: `${section.where} does not exist`, fix: "add it, with every binding, secret and var the manifest lists" }]);
      continue;
    }
    const name: Line = cfg.name === deployable.worker
      ? { status: "ok", label: "Worker name", detail: deployable.worker }
      : { status: "missing", label: "Worker name", detail: `${section.where} deploys "${String(cfg.name)}", not "${deployable.worker}"`, fix: `make ${section.where} the production Worker (name = "${deployable.worker}"); keep the development Worker under [env.development]` };
    result.set(section.key, [
      name,
      ...deployable.settings.map((setting) => settingLine(setting, cfg, section.where)),
      ...deployable.bindings.flatMap((item) => bindingLines(item, section, sections, ids)),
      ...deployable.wiring.map((item) => wiringLine(item, section)),
    ]);
  }
  return result;
}

/** Secret names from `wrangler secret list --format json`; anything else in the output is dropped. */
export function secretNames(stdout: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(record).map((entry) => entry.name).filter((name): name is string => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  } catch {
    return null;
  }
}

/** Variable names from `convex env list`: the token before `=` on each `NAME=value` line; values are dropped. */
export function convexNames(stdout: string): string[] | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const names = lines.map((line) => /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(line)?.[1]);
  return names.every((name) => name !== undefined) ? names as string[] : null;
}

function unparsed(stdout: string): string {
  const count = stdout.split(/\r?\n/).filter((line) => line.trim()).length;
  return `could not read its output (${count} line${count === 1 ? "" : "s"}, not shown: it may contain values)`;
}

/** Secret names on each production Worker, diffed against the manifest. */
async function onlineWorkerLines(deployable: WorkerDeployable, cfg: Raw | null, deps: Dependencies): Promise<Line[]> {
  const command = `wrangler secret list --name ${deployable.worker}`;
  const result = await deps.run("pnpm", ["exec", "wrangler", "secret", "list", "--name", deployable.worker, "--format", "json"]);
  if (result.code !== 0) return [{ status: "missing", label: "secret names", detail: `${command} failed (exit ${result.code}); run it yourself to see why`, fix: "log in with pnpm exec wrangler login" }];
  const names = secretNames(result.stdout);
  if (!names) return [{ status: "missing", label: "secret names", detail: `${command}: ${unparsed(result.stdout)}` }];
  const vars = record(cfg?.vars);
  const lines: Line[] = [];
  for (const setting of deployable.settings) {
    const label = `${setting.name} (${setting.kind})`;
    const set = names.includes(setting.name);
    if (setting.need === "forbidden") {
      if (set) lines.push({ status: "missing", label, detail: "set as a secret on the production Worker", fix: `pnpm exec wrangler secret delete ${setting.name} --name ${deployable.worker}` });
    } else if (setting.kind === "var") {
      if (set) lines.push({ status: "missing", label, detail: "set as a secret; the manifest expects a [vars] entry", fix: `move it to [vars] in ${deployable.config}` });
    } else if (set) {
      lines.push({ status: "ok", label, detail: "secret set" });
    } else if (setting.kind === "var-or-secret" && setting.name in vars) {
      lines.push({ status: "ok", label, detail: "set in [vars]" });
    } else {
      lines.push(setting.need === "required"
        ? { status: "missing", label, detail: "not set on the production Worker", fix: `pnpm exec wrangler secret put ${setting.name} --name ${deployable.worker}` }
        : { status: "optional", label, detail: `not set: ${setting.purpose}` });
    }
  }
  const known = new Set(deployable.settings.map((setting) => setting.name));
  for (const name of names.filter((candidate) => !known.has(candidate))) {
    lines.push({ status: "unused", label: name, detail: "secret set but not in the manifest (the code does not read it)", fix: `pnpm exec wrangler secret delete ${name} --name ${deployable.worker}` });
  }
  return lines;
}

/** Convex production env var names, diffed against the manifest. */
async function onlineConvexLines(deps: Dependencies): Promise<Line[]> {
  const result = await deps.run("pnpm", ["exec", "convex", "env", "list", "--prod", "--names-only"]);
  if (result.code !== 0) return [{ status: "missing", label: "env var names", detail: `convex env list --prod failed (exit ${result.code}); run it yourself to see why`, fix: "log in with pnpm exec convex login" }];
  const names = convexNames(result.stdout);
  if (!names) return [{ status: "missing", label: "env var names", detail: `convex env list --prod: ${unparsed(result.stdout)}` }];
  const lines: Line[] = convexDeployable.settings.map((setting) => names.includes(setting.name)
    ? { status: "ok", label: setting.name, detail: "set" }
    : { status: "missing", label: setting.name, detail: `not set: ${setting.purpose}`, fix: `pnpm exec convex env set --prod ${setting.name} <value>` });
  const known = new Set([...convexDeployable.settings.map((setting) => setting.name), ...convexDeployable.builtIn]);
  for (const name of names.filter((candidate) => !known.has(candidate))) {
    lines.push({ status: "unused", label: name, detail: "set but not in the manifest (the code does not read it)", fix: `pnpm exec convex env remove --prod ${name}` });
  }
  return lines;
}

const MARK: Record<Status, string> = { ok: "ok      ", missing: "MISSING ", verify: "VERIFY  ", optional: "optional", unused: "unused  " };

function print(deps: Dependencies, heading: string, lines: Line[]): void {
  deps.log("");
  deps.log(heading);
  for (const line of lines) {
    deps.log(`  ${MARK[line.status]}  ${line.label}: ${line.detail}`);
    if (line.fix) deps.log(`              -> ${line.fix}`);
  }
}

const USAGE = "usage: pnpm preflight:prod [--report] [--online]";

export async function main(argv: string[], deps: Dependencies): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--report" && arg !== "--online");
  if (unknown.length) { deps.log(`Unknown argument ${unknown.join(" ")}. ${USAGE}`); return 2; }
  const report = argv.includes("--report");
  const online = argv.includes("--online");
  deps.log(`Production preflight (${online ? "offline and online" : "offline"}) against scripts/production-manifest.ts`);
  const sections = Object.fromEntries((Object.keys(workers) as DeployableKey[]).map((key) => [key, sectionOf(key, workers[key], deps)])) as Record<DeployableKey, Section>;
  const all: Line[] = [];
  for (const [key, lines] of offlineLines(sections)) {
    const { deployable, cfg, where } = sections[key];
    // Online, the secret list settles what the offline check could only ask to verify.
    const shown = online
      ? [...lines.filter((line) => !(line.status === "verify" && line.label.endsWith("(var-or-secret)"))), ...await onlineWorkerLines(deployable, cfg, deps)]
      : lines;
    print(deps, `${deployable.title} "${deployable.worker}": ${where}, deployed by \`${deployable.deploy}\``, shown);
    all.push(...shown);
  }
  const convex = online
    ? await onlineConvexLines(deps)
    : convexDeployable.settings.map((setting): Line => ({ status: "verify", label: setting.name, detail: setting.purpose, fix: `pnpm exec convex env set --prod ${setting.name} <value> (checked by --online)` }));
  print(deps, `${convexDeployable.title} (production deployment): env vars, deployed by \`pnpm exec convex deploy\``, convex);
  all.push(...convex);
  const missing = all.filter((line) => line.status === "missing").length;
  const verify = all.filter((line) => line.status === "verify").length;
  deps.log("");
  deps.log(`${missing} required item${missing === 1 ? "" : "s"} missing, ${verify} to verify${online ? "" : " (secrets and Convex: run --online with production credentials)"}.`);
  return missing && !report ? 1 : 0;
}

/** Runs a command without a shell and returns only its exit code and stdout; stderr is discarded unread. */
export function runCommand(command: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { experimental_readRawConfig } = await import("wrangler");
  const deps: Dependencies = {
    readConfig: (path) => experimental_readRawConfig({ config: path }).rawConfig as Raw,
    run: runCommand,
    log: (line) => console.log(line),
  };
  process.exitCode = await main(process.argv.slice(2), deps);
}
