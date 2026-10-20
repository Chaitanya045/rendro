import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseAccessLog, parseQueueMetrics, safeFunction, safePath, serialize, summarize, type TimingEntry } from "../scripts/e2e-timings";
import { createTimingRecorder, recordBackendLog, sampleBackendQueue, timeUpstream, timingFile } from "../e2e/timings";

const directories: string[] = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "rendro-timings-")); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

// Fake material only: shapes of what the local backend's log and the Worker's requests can carry.
const adminKey = "e2e-4f2a9c|01c0ffeeDEADbeef9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5";
const cookie = "better-auth.session_token=Zk3QpL9xW2mN8rT5vB7yC1dF4gH6jK0s.SgNaTuRe";
const email = "reader.one@example.test";
const token = "Tq8Rr2Lm5Vn7Xp1Zw4Ys6Uk9";
const secrets = [adminKey, "01c0ffeeDEADbeef", cookie, "Zk3QpL9xW2mN8rT5vB7yC1dF4gH6jK0s", email, "reader.one", token];
const startedAt = Date.parse("2026-10-20T22:37:20.000Z");
const at = (iso: string, line: string) => `\u001b[2m${iso}\u001b[0m \u001b[32m INFO\u001b[0m ${line}`;
const accessLine = (iso: string, method: string, uri: string, status: number, duration: string, extra = '"-" "-" application/json -') =>
  at(iso, `convex-cloud-http: [] 127.0.0.1:59584 "${method} ${uri} HTTP/1.1" ${status} ${extra} ${duration}`);

function expectNoSecrets(text: string) {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("redacted e2e timings (#328)", () => {
  it("keeps only timings from a backend log line that carries an admin key, a cookie, an email and a token", () => {
    const hostile = accessLine("2026-10-20T22:37:28.500Z", "POST",
      `/api/auth/reset-password/${token}?token=${token}&email=${encodeURIComponent(email)}&adminKey=${encodeURIComponent(adminKey)}`, 200, "212.5ms",
      `"https://app.test/?email=${email}" "Mozilla/5.0 Cookie: ${cookie} Authorization: Convex ${adminKey}" application/json -`);
    const entry = parseAccessLog(hostile, startedAt);
    expect(entry).toEqual({ kind: "backend", method: "POST", path: "/api/auth/reset-password/:param", status: 200, startMs: 8287.5, durationMs: 212.5 });
    const line = serialize(entry)!;
    expect(JSON.parse(line)).toEqual({ kind: "backend", method: "POST", path: "/api/auth/reset-password/:param", status: 200, startMs: 8287.5, durationMs: 212.5 });
    expectNoSecrets(line);
    // Lines that are not access-log lines have no timing to keep and are dropped whole.
    for (const other of [
      at("2026-10-20T22:37:28.500Z", `keybroker::broker: Admin key accepted ${adminKey} for ${email}`),
      at("2026-10-20T22:37:28.500Z", `isolate: Auth diagnostic cookie=${cookie} token=${token}`),
      `convex-cloud-http: "GET /api/query?token=${token} HTTP/1.1" 200 - 1ms`,
    ]) expect(parseAccessLog(other, startedAt)).toBeUndefined();
  });

  it("drops anything outside the allowlist from every entry kind", () => {
    const hostile = {
      kind: "upstream", target: "convex", method: "post", path: `/api/${email}/x?key=${adminKey}`, fn: `${token}`,
      startMs: 1, durationMs: 2.25, status: 200, cookie, headers: { cookie, authorization: adminKey }, error: email, injected: "yes",
    };
    const line = serialize(hostile)!;
    expect(JSON.parse(line)).toEqual({ kind: "upstream", target: "convex", method: "POST", path: "/api/:param/x", startMs: 1, durationMs: 2.3, status: 200 });
    expectNoSecrets(line);
    const queue = serialize({ kind: "queue", atMs: 5, values: { httpInFlight: 3, [email]: 1, siteInFlight: Number.NaN, token } })!;
    expect(JSON.parse(queue)).toEqual({ kind: "queue", atMs: 5, values: { httpInFlight: 3 } });
    expectNoSecrets(queue);
    expect(serialize({ kind: "meta", version: 9, startedAt: 12.7, email })).toBe('{"kind":"meta","version":1,"startedAt":13}');
  });

  it.each([
    [null], ["text"], [{ kind: "unknown", startMs: 1 }], [{ kind: "meta", startedAt: "now" }],
    [{ kind: "upstream", target: "elsewhere", startMs: 1, durationMs: 1 }], [{ kind: "upstream", target: "convex", startMs: 1, durationMs: Infinity }],
    [{ kind: "upstream", target: "convex", startMs: "1", durationMs: 1 }],
    [{ kind: "backend", status: 700, startMs: 1, durationMs: 1 }], [{ kind: "backend", status: 200, startMs: 1 }], [{ kind: "backend", status: 200, durationMs: 1 }],
    [{ kind: "queue", atMs: 1 }], [{ kind: "queue", atMs: 1, values: "x" }], [{ kind: "queue", values: {} }],
  ])("refuses an entry it cannot vouch for: %j", entry => {
    expect(serialize(entry)).toBeUndefined();
  });

  it("keeps a failed or injected call's outcome, and a valid function name", () => {
    expect(JSON.parse(serialize({ kind: "upstream", target: "convex-site", method: "PROPFIND", path: 7, startMs: 0, durationMs: 5008, status: null, error: "timeout", injected: true })!))
      .toEqual({ kind: "upstream", target: "convex-site", method: "OTHER", path: "/?", startMs: 0, durationMs: 5008, status: null, error: "timeout", injected: true });
    expect(JSON.parse(serialize({ kind: "upstream", target: "convex", method: 1, path: "/api/query", fn: "repoComments:threadSnapshot", startMs: 0, durationMs: 1, status: 99 })!))
      .toMatchObject({ method: "OTHER", fn: "repoComments:threadSnapshot", status: null });
  });

  it.each([
    ["/api/auth/sign-out", "/api/auth/sign-out"], ["/http/api/auth/get-session?x=1#y", "/http/api/auth/get-session"],
    ["/api/auth/oauth2/callback/github", "/api/auth/oauth2/callback/github"], ["/api/update_environment_variables", "/api/update_environment_variables"],
    ["/api/run/repoComments/threadSnapshot", "/api/run/:param/:param"], ["/", "/"], ["/a/b4c", "/a/:param"], [`/u/${"a".repeat(40)}`, "/u/:param"],
    ["/api/auth/verify/abcdef0123456789", "/api/auth/verify/:param"], ["/x/%40", "/x/:param"],
  ])("reduces path %s to %s", (path, expected) => {
    expect(safePath(path)).toBe(expected);
  });

  it.each([
    ["repoComments:threadSnapshot", true], ["auth/session:read", true], ["_internal:run_1", true],
    ["repoComments", false], [token, false], [email, false], ["a:b c", false], [`${"a".repeat(90)}:${"b".repeat(10)}`, false], [42, false],
  ])("accepts %s as a function name: %s", (name, accepted) => {
    expect(safeFunction(name)).toBe(accepted ? name : undefined);
  });

  it("reads durations in every unit the access log uses, ending at the log timestamp", () => {
    const parse = (duration: string) => parseAccessLog(accessLine("2026-10-20T22:37:21.000000Z", "GET", "/version", 200, duration), startedAt);
    expect(parse("1.5s")).toMatchObject({ startMs: -500, durationMs: 1500 });
    expect(parse("250µs")).toMatchObject({ durationMs: 0.25 });
    expect(parse("250us")).toMatchObject({ durationMs: 0.25 });
    expect(parse("4000ns")).toMatchObject({ durationMs: 0.004 });
    expect(parseAccessLog(`${accessLine("2026-10-20T22:37:21Z", "HEAD", "/api/x", 404, "3ms")}   \r`, startedAt)).toMatchObject({ method: "HEAD", status: 404, startMs: 997 });
  });

  it("sums allowlisted queue gauges over label sets and drops the labels", () => {
    const text = [
      "# TYPE convex_local_backend_backend_http_service_concurrent_requests gauge",
      "convex_local_backend_backend_http_service_concurrent_requests 3",
      "convex_local_backend_backend_http_proxy_http_service_concurrent_requests 4",
      'convex_local_backend_http_service_max_concurrent_requests{service_name="backend"} 128',
      'convex_local_backend_http_service_max_concurrent_requests{service_name="backend_http_proxy"} 4',
      `convex_local_backend_udf_queue_seconds_sum{udf_type="query",client_id="${email}"} 0.5`,
      'convex_local_backend_udf_queue_seconds_sum{udf_type="mutation"} 0.25',
      "convex_local_backend_udf_queue_seconds_count 3",
      "convex_local_backend_scheduled_job_backlog_seconds NaN",
      `convex_local_backend_secret_${token.toLowerCase()} 1`,
      `convex_local_backend_concurrency_permit_total_hold_time_seconds{client_id="${adminKey}"} 3711`,
    ].join("\n");
    const values = parseQueueMetrics(text);
    expect(values).toEqual({ httpInFlight: 3, siteInFlight: 4, siteLimit: 4, udfQueueSeconds: 0.75, udfQueueCount: 3 });
    expectNoSecrets(JSON.stringify(values));
  });

  it("summarizes the slowest calls with the backend's view and queue peaks", () => {
    const lines = [
      serialize({ kind: "meta", version: 1, startedAt })!,
      ...Array.from({ length: 12 }, (_, index) => serialize({ kind: "upstream", target: "convex", method: "POST", path: "/api/query", fn: "repoComments:threadSnapshot", startMs: index * 100, durationMs: 10 + index, status: 200 })!),
      serialize({ kind: "upstream", target: "convex-site", method: "POST", path: "/api/auth/sign-out", startMs: 20_000, durationMs: 5008, status: null, error: "abort" })!,
      serialize({ kind: "upstream", target: "convex", method: "POST", path: "/api/mutation", startMs: 40_000, durationMs: 900, status: 503, injected: true })!,
      serialize({ kind: "backend", method: "GET", path: "/version", status: 200, startMs: 1, durationMs: 2 })!,
      serialize({ kind: "backend", method: "POST", path: "/http/api/auth/sign-out", status: 200, startMs: 20_001, durationMs: 6100 })!,
      serialize({ kind: "queue", atMs: 21_000, values: { httpInFlight: 2, siteInFlight: 4, siteLimit: 4, udfQueueSeconds: 1, udfQueueCount: 10, commitQueueSeconds: 0, commitQueueCount: 1 } })!,
      serialize({ kind: "queue", atMs: 22_000, values: { httpInFlight: 1, siteInFlight: 4, siteLimit: 4, udfQueueSeconds: 4, udfQueueCount: 12, commitQueueSeconds: 0, commitQueueCount: 1 } })!,
      serialize({ kind: "queue", atMs: 23_000, values: {} })!,
      serialize({ kind: "queue", atMs: 24_000, values: { udfQueueCount: 20 } })!,
      '{"kind":"upstream","target":"conv',
    ];
    const summary = summarize(lines);
    const rows = summary.split("\n");
    expect(rows[0]).toBe("Slowest 10 of 14 Worker calls to the local Convex backend:");
    expect(rows[2]).toMatch(/^ {2}5008 ms {3}abort {4}20\.0s {4}http 2, site 4 {6}POST site \/api\/auth\/sign-out$/);
    expect(rows[3]).toContain("503      40.0s    http 0, site 0      POST api /api/mutation (injected fault)");
    expect(rows[4]).toContain("POST api /api/query repoComments:threadSnapshot");
    expect(rows.filter(row => row.includes("repoComments:threadSnapshot"))).toHaveLength(8);
    expect(summary).toContain("Slowest 2 of 2 requests in the backend's access log:\n  6100 ms   200      20.0s    POST /http/api/auth/sign-out\n  2 ms");
    expect(summary).toContain("site proxy in-flight 4 of 4");
    expect(summary).toContain("function queue 1500 ms, commit queue 0 ms, permit 0 ms.");
  });

  it("says so when nothing was recorded", () => {
    expect(summarize([])).toBe([
      "Slowest 0 of 0 Worker calls to the local Convex backend:",
      "Slowest 0 of 0 requests in the backend's access log:",
      "No backend queue samples were recorded.",
    ].join("\n"));
  });

  it("prints every shard file in a directory, and never fails when there is none", async () => {
    const directory = temporary();
    const log = vi.fn();
    expect(await main([join(directory, "missing")], log)).toBe(0);
    expect(log).toHaveBeenCalledWith(`No e2e timing files in ${join(directory, "missing")}.`);
    writeFileSync(join(directory, "shard-1-of-2.jsonl"), `${serialize({ kind: "upstream", target: "convex", method: "GET", path: "/version", startMs: 0, durationMs: 7, status: 200 })}\n\n`);
    writeFileSync(join(directory, "notes.txt"), "ignored");
    log.mockClear();
    expect(await main([directory], log)).toBe(0);
    expect(log.mock.calls.map(call => call[0] as string)).toEqual(["== shard-1-of-2.jsonl", expect.stringContaining("7 ms")]);
  });

  it("runs as a script with the default directory, and stays quiet when imported", async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.argv = [argv[0]!];
      vi.resetModules();
      await import("../scripts/e2e-timings");
      expect(log).not.toHaveBeenCalled();
      process.argv = [argv[0]!, new URL("../scripts/e2e-timings.ts", import.meta.url).pathname];
      process.exitCode = undefined;
      vi.resetModules();
      await import("../scripts/e2e-timings");
      await vi.waitFor(() => expect(process.exitCode).toBe(0));
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^(No e2e timing files in test-results\/e2e-timings\.|== )/));
    } finally { process.argv = argv; process.exitCode = exitCode; }
  });
});

describe("e2e timing recorder", () => {
  it("names one file per shard outside Playwright's output directory", () => {
    expect(timingFile("/r", { current: 2, total: 2 })).toBe("/r/test-results/e2e-timings/shard-2-of-2.jsonl");
    expect(timingFile("/r", null)).toBe("/r/test-results/e2e-timings/run.jsonl");
  });

  it("records a Worker call's function name but never its arguments or secrets", async () => {
    const file = join(temporary(), "nested/run.jsonl");
    let clock = 1000;
    const recorder = createTimingRecorder(file, () => clock);
    clock = 1250;
    const request = new Request("http://127.0.0.1:1/api/query?token=" + token, { method: "POST", headers: { cookie },
      body: JSON.stringify({ path: "repoComments:threadSnapshot", args: [{ internalSecret: adminKey, email }] }) });
    const response = await timeUpstream(recorder, request, "convex", async () => {
      expect(await request.text()).toContain("internalSecret");
      return new Response("{}", { status: 201 });
    });
    expect(response.status).toBe(201);
    const text = readFileSync(file, "utf8");
    expectNoSecrets(text);
    const [meta, entry] = text.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(meta).toEqual({ kind: "meta", version: 1, startedAt: 1000 });
    expect(entry).toMatchObject({ kind: "upstream", target: "convex", method: "POST", path: "/api/query", fn: "repoComments:threadSnapshot", startMs: 250, status: 201 });
  });

  it("records a site call without a body read, and an injected fault", async () => {
    const file = join(temporary(), "run.jsonl");
    const recorder = createTimingRecorder(file);
    await timeUpstream(recorder, new Request("http://127.0.0.1:1/api/auth/sign-out", { method: "POST", body: "{}" }), "convex-site", () => new Response(null, { status: 503 }), true);
    await timeUpstream(recorder, new Request("http://127.0.0.1:1/api/mutation", { method: "POST", body: "not json" }), "convex", () => new Response(null));
    const [, site, mutation] = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(site).toMatchObject({ target: "convex-site", path: "/api/auth/sign-out", status: 503, injected: true });
    expect(site).not.toHaveProperty("fn");
    expect(mutation).toMatchObject({ path: "/api/mutation", status: 200 });
    expect(mutation).not.toHaveProperty("fn");
  });

  it.each([
    [new DOMException("aborted", "AbortError"), "abort"], [new DOMException("timed out", "TimeoutError"), "timeout"],
    [new TypeError(`fetch failed for ${email}`), "network"], [null, "network"],
  ])("records a failed call as %s and rethrows it", async (error, outcome) => {
    const file = join(temporary(), "run.jsonl");
    const recorder = createTimingRecorder(file);
    const request = new Request("http://127.0.0.1:1/api/action", { method: "POST", body: JSON.stringify({ path: "repoComments:post" }) });
    await expect(timeUpstream(recorder, request, "convex", () => Promise.reject(error as Error))).rejects.toBe(error);
    const text = readFileSync(file, "utf8");
    expectNoSecrets(text);
    expect(JSON.parse(text.trim().split("\n")[1]!)).toMatchObject({ fn: "repoComments:post", status: null, error: outcome });
  });

  it("samples the queue gauges until stopped, skipping failed and non-200 samples", async () => {
    const file = join(temporary(), "run.jsonl");
    const recorder = createTimingRecorder(file);
    const answers = [
      () => Promise.reject(new Error("busy")),
      () => Promise.resolve({ status: 503, body: "" }),
      () => Promise.resolve({ status: 200, body: `convex_local_backend_backend_http_service_concurrent_requests 2\nconvex_local_backend_x{key="${adminKey}"} 1` }),
    ];
    let calls = 0;
    const stop = sampleBackendQueue(recorder, () => answers[Math.min(calls++, 2)]!(), 5);
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(4));
    await stop();
    const after = calls;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toBe(after);
    const lines = readFileSync(file, "utf8").trim().split("\n").slice(1).map(line => JSON.parse(line) as { kind: string; values: unknown });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) expect(line).toMatchObject({ kind: "queue", values: { httpInFlight: 2 } });
    expectNoSecrets(readFileSync(file, "utf8"));
  });

  it("reduces the backend log to access timings, without the sampler's own requests", async () => {
    const directory = temporary();
    mkdirSync(join(directory, "out"));
    const log = join(directory, "backend.log");
    const recorder = createTimingRecorder(join(directory, "out/run.jsonl"), () => startedAt);
    writeFileSync(log, [
      at("2026-10-20T22:37:21.000Z", `keybroker::broker: Admin key accepted ${adminKey}`),
      accessLine("2026-10-20T22:37:22.000Z", "GET", "/metrics", 200, "1ms"),
      accessLine("2026-10-20T22:37:26.000Z", "POST", `/http/api/auth/sign-out?email=${email}`, 200, "5.5s", `"-" "${cookie}" application/json -`),
    ].join("\r\n"));
    await recordBackendLog(recorder, log);
    const text = readFileSync(recorder.file, "utf8");
    expectNoSecrets(text);
    expect(text.trim().split("\n").slice(1).map(line => JSON.parse(line) as unknown))
      .toEqual([{ kind: "backend", method: "POST", path: "/http/api/auth/sign-out", status: 200, startMs: 500, durationMs: 5500 }]);
  });

  it("ignores entries the allowlist refuses", () => {
    const file = join(temporary(), "run.jsonl");
    const recorder = createTimingRecorder(file);
    recorder.record({ kind: "queue" } as unknown as TimingEntry);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
