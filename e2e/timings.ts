import { appendFileSync, createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseAccessLog, parseQueueMetrics, serialize, type TimingEntry } from "../scripts/e2e-timings";

/** Where a run's timings go: outside Playwright's cleaned output directory, one file per shard (#328). */
export function timingFile(root: string, shard?: { current: number; total: number } | null) {
  return join(root, "test-results/e2e-timings", shard ? `shard-${shard.current}-of-${shard.total}.jsonl` : "run.jsonl");
}

export type TimingRecorder = ReturnType<typeof createTimingRecorder>;

/**
 * Appends each entry as it happens, so a run that is killed keeps what it recorded. Entries only
 * reach the file through `serialize`, the allowlist in scripts/e2e-timings.ts.
 */
export function createTimingRecorder(file: string, now = Date.now) {
  const startedAt = now();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${serialize({ kind: "meta", version: 1, startedAt })}\n`);
  return {
    file, startedAt,
    offset: () => now() - startedAt,
    record(entry: TimingEntry) {
      const line = serialize(entry);
      if (line) appendFileSync(file, `${line}\n`);
    },
  };
}

function failure(error: unknown): "abort" | "timeout" | "network" {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" ? "abort" : name === "TimeoutError" ? "timeout" : "network";
}

/**
 * Times one Worker call to the local backend until its response headers arrive. For function calls
 * the `path` field of the JSON body names the function; only that field is read, and only an
 * allowlisted `module:function` name is kept.
 */
export async function timeUpstream(recorder: TimingRecorder, request: Request, target: "convex" | "convex-site",
  send: () => Response | Promise<Response>, injected = false): Promise<Response> {
  const url = new URL(request.url);
  const copy = request.method === "POST" && /^\/api\/(query|mutation|action|function)$/.test(url.pathname) ? request.clone() : undefined;
  const startMs = recorder.offset();
  const started = performance.now();
  const fn = copy?.json().then(body => (body as { path?: unknown } | null)?.path, () => undefined);
  const base = { kind: "upstream" as const, target, method: request.method, path: url.pathname, startMs, injected };
  try {
    const response = await send();
    recorder.record({ ...base, fn: await fn as string | undefined, durationMs: performance.now() - started, status: response.status });
    return response;
  } catch (error) {
    recorder.record({ ...base, fn: await fn as string | undefined, durationMs: performance.now() - started, status: null, error: failure(error) });
    throw error;
  }
}

/**
 * Samples the backend's queue gauges about once a second from its loopback `/metrics` endpoint.
 * Returns a stop function. A failed or slow sample is skipped; the next tick tries again.
 */
export function sampleBackendQueue(recorder: TimingRecorder, metrics: () => Promise<{ status: number; body: string }>, intervalMs = 1000) {
  let pending: Promise<void> | undefined;
  const tick = async () => {
    try {
      const response = await metrics();
      if (response.status === 200) recorder.record({ kind: "queue", atMs: recorder.offset(), values: parseQueueMetrics(response.body) });
    } catch { /* The backend may be busy or stopping; a gap in the samples is itself a signal. */ }
  };
  const timer = setInterval(() => { pending ??= tick().finally(() => { pending = undefined; }); }, intervalMs);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}

/** Reduces the backend's log to access-log timings. The sampler's own `/metrics` requests are left out. */
export async function recordBackendLog(recorder: TimingRecorder, log: string) {
  const lines = createInterface({ input: createReadStream(log, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    const entry = parseAccessLog(line, recorder.startedAt);
    if (entry?.kind === "backend" && entry.path !== "/metrics") recorder.record(entry);
  }
}
