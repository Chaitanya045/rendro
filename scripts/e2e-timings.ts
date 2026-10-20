/**
 * Redacted timing capture for the e2e harness (#328), and the failed-shard summary CI prints.
 *
 *   pnpm exec tsx scripts/e2e-timings.ts test-results/e2e-timings
 *
 * The harness records three kinds of entry, one JSON object per line: the Worker's calls to the local
 * Convex backend (e2e/global-setup.ts), the backend's own access log, and samples of its queue gauges
 * (e2e/backend.ts). The files are uploaded with a failed shard's artifacts, and the repository is public,
 * so every entry passes through `serialize`, an allowlist: it rebuilds the entry from known fields that
 * each pass a strict pattern or are finite numbers. Nothing is copied from a log line, URL, header or
 * request body as a whole. Query strings are dropped, and a path segment or function name that does not
 * look like a route word or a `module:function` name is replaced, so tokens, cookies, emails and keys
 * have no field to travel in.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const TARGETS = new Set(["convex", "convex-site"]);
const ERRORS = new Set(["abort", "timeout", "network"]);
/** Route words: lowercase letters, `-` or `_`, optionally one trailing digit (`oauth2`, `v1`). */
const SEGMENT = /^[a-z][a-z_-]{0,30}[0-9]?$/;
/** Convex function references (`dir/module:export`). The colon is required: a bare token never has one. */
const FUNCTION = /^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$/;

/** The local backend's Prometheus gauges and queue-time totals worth keeping, by our signal name. */
export const QUEUE_METRICS = {
  httpInFlight: "backend_http_service_concurrent_requests",
  siteInFlight: "backend_http_proxy_http_service_concurrent_requests",
  siteLimit: "http_service_max_concurrent_requests",
  codelQueue: "common_codel_queue_length_total",
  codelOverloaded: "common_codel_queue_overloaded_total",
  commits: "committer_concurrent_commits",
  subscriptionQueue: "subscription_queue_length_info",
  scheduledBacklogSeconds: "scheduled_job_backlog_seconds",
  runningJobs: "scheduled_job_running_jobs_info",
  udfQueueSeconds: "udf_queue_seconds_sum",
  udfQueueCount: "udf_queue_seconds_count",
  commitQueueSeconds: "database_commit_queue_seconds_sum",
  commitQueueCount: "database_commit_queue_seconds_count",
  permitWaitSeconds: "concurrency_permit_acquire_seconds_sum",
  permitWaitCount: "concurrency_permit_acquire_seconds_count",
} as const;
export type QueueSignal = keyof typeof QUEUE_METRICS;
const SIGNALS = Object.keys(QUEUE_METRICS) as QueueSignal[];

/** Start/at offsets are milliseconds since the recorder's `startedAt`. */
export type TimingEntry =
  | { kind: "meta"; version: 1; startedAt: number }
  | { kind: "upstream"; target: "convex" | "convex-site"; method: string; path: string; fn?: string; startMs: number; durationMs: number; status: number | null; error?: "abort" | "timeout" | "network"; injected?: boolean }
  | { kind: "backend"; method: string; path: string; status: number; startMs: number; durationMs: number }
  | { kind: "queue"; atMs: number; values: Partial<Record<QueueSignal, number>> };

export function safeMethod(method: unknown): string {
  return typeof method === "string" && METHODS.has(method.toUpperCase()) ? method.toUpperCase() : "OTHER";
}

/** The path without its query or fragment, each segment kept only if it is a route word. */
export function safePath(path: unknown): string {
  if (typeof path !== "string") return "/?";
  const bare = path.split(/[?#]/, 1)[0]!;
  const segments = bare.split("/").slice(1).map(segment => segment === "" || SEGMENT.test(segment) ? segment : ":param");
  return `/${segments.join("/")}`;
}

export function safeFunction(name: unknown): string | undefined {
  return typeof name === "string" && name.length <= 96 && FUNCTION.test(name) ? name : undefined;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number) => Math.round(value * 10) / 10;
const statusCode = (value: unknown) => Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599 ? value as number : null;

/** The one way out of the process: an entry rebuilt from allowlisted fields, or undefined to drop it. */
export function serialize(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const value = entry as Record<string, unknown>;
  switch (value.kind) {
    case "meta":
      return finite(value.startedAt) ? JSON.stringify({ kind: "meta", version: 1, startedAt: Math.round(value.startedAt) }) : undefined;
    case "upstream": {
      if (!TARGETS.has(value.target as string) || !finite(value.startMs) || !finite(value.durationMs)) return undefined;
      const fn = safeFunction(value.fn);
      const error = ERRORS.has(value.error as string) ? value.error as string : undefined;
      return JSON.stringify({
        kind: "upstream", target: value.target, method: safeMethod(value.method), path: safePath(value.path),
        ...(fn ? { fn } : {}), startMs: round(value.startMs), durationMs: round(value.durationMs), status: statusCode(value.status),
        ...(error ? { error } : {}), ...(value.injected === true ? { injected: true } : {}),
      });
    }
    case "backend": {
      const status = statusCode(value.status);
      if (status === null || !finite(value.startMs) || !finite(value.durationMs)) return undefined;
      return JSON.stringify({ kind: "backend", method: safeMethod(value.method), path: safePath(value.path), status,
        startMs: round(value.startMs), durationMs: round(value.durationMs) });
    }
    case "queue": {
      if (!finite(value.atMs) || !value.values || typeof value.values !== "object") return undefined;
      const source = value.values as Record<string, unknown>;
      const values = Object.fromEntries(SIGNALS.flatMap(signal => finite(source[signal]) ? [[signal, source[signal]]] : []));
      return JSON.stringify({ kind: "queue", atMs: round(value.atMs), values });
    }
    default:
      return undefined;
  }
}

const UNITS: Record<string, number> = { ns: 1e-6, "µs": 1e-3, us: 1e-3, ms: 1, s: 1000 };
const ANSI = /\u001b\[[0-9;]*m/g;
// `<timestamp> INFO convex-cloud-http: [<request id>] <peer> "<METHOD> <uri> HTTP/<v>" <status> ... <duration><unit>`,
// logged when the response completes. Everything between the status and the duration (referer,
// user agent, content type) is skipped, never captured.
const ACCESS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+INFO convex-cloud-http: \[[^\]]*\] \S+ "([A-Z]+) (\S+) HTTP\/[\d.]+" (\d{3}) .* (\d+(?:\.\d+)?)(ns|µs|us|ms|s)$/;

/** A backend access-log line as a `backend` entry relative to `startedAt` (epoch ms), or undefined. */
export function parseAccessLog(line: string, startedAt: number): TimingEntry | undefined {
  const match = ACCESS.exec(line.replace(ANSI, "").trimEnd());
  if (!match) return undefined;
  const [, timestamp, method, uri, status, amount, unit] = match as unknown as [string, string, string, string, string, string, string];
  const durationMs = Number(amount) * UNITS[unit]!;
  const endMs = Date.parse(timestamp) - startedAt;
  return { kind: "backend", method: safeMethod(method), path: safePath(uri), status: Number(status), startMs: endMs - durationMs, durationMs };
}

/** The allowlisted queue signals in a Prometheus text body, each summed over its label sets; labels are dropped. */
export function parseQueueMetrics(text: string): Partial<Record<QueueSignal, number>> {
  const byMetric = new Map<string, QueueSignal>(SIGNALS.map(signal => [QUEUE_METRICS[signal], signal]));
  const values: Partial<Record<QueueSignal, number>> = {};
  for (const line of text.split("\n")) {
    const match = /^convex_local_backend_([a-z_]+)(\{[^}]*\})? (\S+)$/.exec(line);
    const signal = match && byMetric.get(match[1]!);
    if (!signal) continue;
    // Only the site proxy's limit is interesting among the per-service limits.
    if (signal === "siteLimit" && !match[2]?.includes('service_name="backend_http_proxy"')) continue;
    const value = Number(match[3]);
    if (Number.isFinite(value)) values[signal] = (values[signal] ?? 0) + value;
  }
  return values;
}

type Upstream = Extract<TimingEntry, { kind: "upstream" }>;
type Backend = Extract<TimingEntry, { kind: "backend" }>;
type Queue = Extract<TimingEntry, { kind: "queue" }>;

function entries(lines: string[]) {
  const parsed: TimingEntry[] = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line) as TimingEntry); } catch { /* A shard cut off mid-write leaves a partial last line. */ }
  }
  return parsed;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const pad = (text: string, width: number) => text.padEnd(width);

/** Peak gauges over the queue samples taken during [from, to] (samples are about a second apart). */
function peaks(samples: Queue[], from: number, to: number) {
  const window = samples.filter(sample => sample.atMs >= from - 1000 && sample.atMs <= to + 1000);
  const max = (signal: QueueSignal) => Math.max(0, ...window.map(sample => sample.values[signal] ?? 0));
  return `http ${max("httpInFlight")}, site ${max("siteInFlight")}`;
}

/** Largest mean wait per sampling interval for a cumulative queue-time total. */
function worstInterval(samples: Queue[], sum: QueueSignal, count: QueueSignal) {
  let worst = 0;
  for (let index = 1; index < samples.length; index++) {
    const [before, after] = [samples[index - 1]!.values, samples[index]!.values];
    const calls = (after[count] ?? 0) - (before[count] ?? 0);
    if (calls > 0) worst = Math.max(worst, ((after[sum] ?? 0) - (before[sum] ?? 0)) / calls);
  }
  return `${Math.round(worst * 1000)} ms`;
}

/** The job-log summary for one shard's timing lines. */
export function summarize(lines: string[], limit = 10): string {
  const all = entries(lines);
  const upstream = all.filter((entry): entry is Upstream => entry.kind === "upstream").sort((a, b) => b.durationMs - a.durationMs);
  const backend = all.filter((entry): entry is Backend => entry.kind === "backend").sort((a, b) => b.durationMs - a.durationMs);
  const samples = all.filter((entry): entry is Queue => entry.kind === "queue").sort((a, b) => a.atMs - b.atMs);
  const out = [`Slowest ${Math.min(limit, upstream.length)} of ${upstream.length} Worker calls to the local Convex backend:`];
  if (upstream.length) out.push(`  ${pad("duration", 10)}${pad("status", 9)}${pad("start", 9)}${pad("backend in-flight", 20)}call`);
  for (const call of upstream.slice(0, limit)) {
    const status = call.error ?? String(call.status);
    const name = `${call.method} ${call.target === "convex-site" ? "site" : "api"} ${call.path}${call.fn ? ` ${call.fn}` : ""}${call.injected ? " (injected fault)" : ""}`;
    out.push(`  ${pad(`${Math.round(call.durationMs)} ms`, 10)}${pad(status, 9)}${pad(seconds(call.startMs), 9)}${pad(peaks(samples, call.startMs, call.startMs + call.durationMs), 20)}${name}`);
  }
  out.push(`Slowest ${Math.min(5, backend.length)} of ${backend.length} requests in the backend's access log:`);
  for (const request of backend.slice(0, 5)) {
    out.push(`  ${pad(`${Math.round(request.durationMs)} ms`, 10)}${pad(String(request.status), 9)}${pad(seconds(request.startMs), 9)}${request.method} ${request.path}`);
  }
  if (samples.length) {
    const max = (signal: QueueSignal) => Math.max(...samples.map(sample => sample.values[signal] ?? 0));
    out.push(`Backend queue peaks over ${samples.length} samples: http in-flight ${max("httpInFlight")}, site proxy in-flight ${max("siteInFlight")} of ${max("siteLimit")},`
      + ` codel queue ${max("codelQueue")} (overloaded ${max("codelOverloaded")}), concurrent commits ${max("commits")}, scheduled backlog ${max("scheduledBacklogSeconds")} s;`
      + ` worst 1 s mean waits: function queue ${worstInterval(samples, "udfQueueSeconds", "udfQueueCount")},`
      + ` commit queue ${worstInterval(samples, "commitQueueSeconds", "commitQueueCount")}, permit ${worstInterval(samples, "permitWaitSeconds", "permitWaitCount")}.`);
  } else {
    out.push("No backend queue samples were recorded.");
  }
  return out.join("\n");
}

/** Prints the summary of every `*.jsonl` timing file in the directory. Never fails the job. */
export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  const directory = argv[0] ?? "test-results/e2e-timings";
  const files = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl")).sort();
  if (!files.length) { log(`No e2e timing files in ${directory}.`); return 0; }
  for (const file of files) {
    log(`== ${file}`);
    log(summarize((await readFile(join(directory, file), "utf8")).split("\n").filter(Boolean)));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
