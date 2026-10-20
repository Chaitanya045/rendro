import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import rateLimiterTest from "./convex-rate-limiter";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { apiKeyRateLimiter } from "../convex/apiKeyHttp";
import { sha256 } from "../convex/credentialHash";
import { analyzeQueryClockReads, enforceAllowlist } from "./helpers/convex-query-clock";

const modules = import.meta.glob("../convex/**/*.ts");
const start = Date.UTC(2026, 0, 1);

// ---- Static guard over the real tree -------------------------------------

// A clock read reachable from a query is a bug unless it is listed here with a
// reason it cannot affect an access decision. Entries are `file#top-level symbol`.
// An entry that no query reaches any more fails the test, so this list only shrinks.
const allowedClockReads: Record<string, string> = {
  "convex/sessionReadLimit.ts#authReadLimit":
    "Better Auth before-hook for HTTP /get-session and organization reads, run only by auth.handler/auth.api in httpActions "
    + "(it calls ctx.runMutation, which a query cannot). Queries reach it only because createAuthOptions() builds the plugin list "
    + "for auth.$context/adapter lookups. It reads the clock solely to pick a rate-limit bucket, never to grant access.",
};

function loadSources() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sources: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(`${root}${directory}`, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== "_generated") walk(path); }
      else if (path.endsWith(".ts") && !path.endsWith(".generated.ts")) sources[path] = readFileSync(`${root}${path}`, "utf8");
    }
  };
  walk("convex");
  walk("shared");
  return sources;
}

describe("Convex queries never read the clock", () => {
  it("finds no clock access reachable from any registered query outside the justified allowlist", () => {
    const analysis = analyzeQueryClockReads(loadSources());
    const { violations, stale } = enforceAllowlist(analysis, allowedClockReads);
    expect(violations.map(finding => `${finding.query} reaches ${finding.text} at ${finding.file}:${finding.line} via ${finding.path.join(" -> ")}`)).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("analyzes exactly the queries Convex registers", async () => {
    // The runtime module exports are the ground truth for what Convex serves;
    // a query shape the static analysis does not recognise fails here.
    const registered: string[] = [];
    for (const [path, load] of Object.entries(modules)) {
      // Component/app definitions only load inside the Convex runtime.
      if (path.includes("/_generated/") || path.endsWith("/convex.config.ts")) continue;
      const exports = await load() as Record<string, { isQuery?: boolean } | undefined>;
      for (const [name, value] of Object.entries(exports)) {
        if (value && typeof value === "object" || typeof value === "function") {
          if ((value as { isQuery?: boolean }).isQuery === true) registered.push(`${path.replace("../", "")}:${name}`);
        }
      }
    }
    expect(registered.length).toBeGreaterThan(5);
    expect(analyzeQueryClockReads(loadSources()).queries).toEqual(registered.sort());
  }, 30_000);

  it("flags the clock in a handler, a helper, a cross-module helper and an aliased read", () => {
    const fixture = (extra: Record<string, string>) => analyzeQueryClockReads({
      "convex/helpers.ts": "export const stamp = () => Date.now();\nexport function viaNew() { return new Date(); }\nexport const fine = (ms: number) => new Date(ms).getTime() + Date.UTC(2020, 0) + Date.parse('2020');\n",
      ...extra,
    });
    const direct = fixture({ "convex/q.ts": 'import { internalQuery } from "./_generated/server";\nexport const check = internalQuery({ handler: async () => Date.now() > 3 });' });
    expect(direct.queries).toEqual(["convex/q.ts:check"]);
    expect(direct.findings).toMatchObject([{ file: "convex/q.ts", line: 2, text: "Date.now", symbol: "check" }]);
    const helper = fixture({ "convex/q.ts": 'import { query } from "./publicFunctions";\nimport { stamp, viaNew } from "./helpers";\nexport const a = query({ handler: async () => stamp() });\nexport const b = query({ handler: async () => viaNew() });' });
    expect(helper.findings.map(f => [f.query, f.text, f.symbol, f.path])).toEqual([
      ["convex/q.ts:a", "Date.now", "stamp", ["convex/helpers.ts:stamp"]],
      ["convex/q.ts:b", "new Date()", "viaNew", ["convex/helpers.ts:viaNew"]],
    ]);
    const namespace = fixture({ "convex/q.ts": 'import { query } from "./publicFunctions";\nimport * as h from "./helpers";\nexport const a = query({ handler: async () => h.stamp() });' });
    expect(namespace.findings.map(f => f.symbol)).toEqual(["stamp"]);
    const aliased = fixture({ "convex/q.ts": 'import { query } from "./publicFunctions";\nexport const a = query({ handler: async () => { const { now } = Date; const clock = performance; return [now(), clock, Temporal.Now]; } });' });
    expect(aliased.findings.map(f => f.text).sort()).toEqual(["Date", "Temporal", "performance"]);
    const chained = fixture({
      "convex/index.ts": 'export * from "./helpers";\nexport { stamp as renamed } from "./helpers";',
      "convex/q.ts": 'import { query } from "./publicFunctions";\nimport { renamed } from "./index";\nexport const a = query({ handler: async () => renamed() });',
    });
    expect(chained.findings.map(f => f.symbol)).toEqual(["stamp"]);
    const starred = fixture({
      "convex/index.ts": 'export * from "./helpers";',
      "convex/q.ts": 'import { query } from "./publicFunctions";\nimport { viaNew } from "./index";\nexport const a = query({ handler: async () => viaNew() });',
    });
    expect(starred.findings.map(f => f.symbol)).toEqual(["viaNew"]);
  });

  it("follows query factories, objects, classes, destructured bindings and recursion", () => {
    const analysis = analyzeQueryClockReads({
      "convex/factory.ts": [
        'import { queryGeneric } from "convex/server";',
        "export function guarded(original: unknown) { return queryGeneric(async () => original); }",
        "export const wrapped = (x: number) => guarded(x);",
        "const holder = { read() { return Date.now(); } };",
        "class Clock { now() { return Date.now(); } }",
        "const { alias } = { alias: () => holder };",
        "function loop(n: number): number { return n ? loop(n - 1) : 0; }",
        "export const viaFactory = guarded(holder);",
        "export const viaWrapped = wrapped(1);",
        "export const viaClass = guarded(new Clock());",
        "export const viaDestructure = guarded(alias);",
        "export const viaLoop = guarded(loop(2));",
        "export const notAQuery = (x: number) => x;",
        "export const plainValue = 1;",
        "export const callsOther = notAQuery(1);",
        "export const typed: Date = new Date(0);",
        "export type Stamp = Date;",
      ].join("\n"),
    });
    expect(analysis.queries).toEqual(["convex/factory.ts:viaClass", "convex/factory.ts:viaDestructure", "convex/factory.ts:viaFactory", "convex/factory.ts:viaLoop", "convex/factory.ts:viaWrapped"]);
    expect(new Set(analysis.findings.map(finding => finding.symbol))).toEqual(new Set(["holder", "Clock"]));
    // Type positions, instanceof, and `new Date(value)` are not clock reads.
    const pure = analyzeQueryClockReads({ "convex/q.ts": 'import { query } from "./publicFunctions";\nexport const a = query({ handler: async (_ctx, args: { d: Date }) => (args.d instanceof Date ? new Date(args.d).getTime() : Date.UTC(1)) });' });
    expect(pure.findings).toEqual([]);
  });

  it("ignores mutations, other packages and unresolved imports, and reports each read once", () => {
    const analysis = analyzeQueryClockReads({
      "convex/m.ts": 'import { internalMutation } from "./_generated/server";\nexport const write = internalMutation({ handler: async () => Date.now() });',
      "convex/q.ts": [
        'import { query } from "./publicFunctions";',
        'import { z } from "zod";',
        'import { missing } from "./missing";',
        'import type { Thing } from "./helpers";',
        'import Default from "./helpers";',
        'export { gone } from "./missing";',
        "export const a = query({ handler: async () => { z.string(); missing(); return Date.now(); } });",
        "export const b = query({ handler: async () => z.number() });",
        "export const unknownNamespace = query({ handler: async () => Default.thing });",
      ].join("\n"),
      "convex/helpers.ts": "export const x = 1;",
    });
    expect(analysis.findings.map(finding => `${finding.query}:${finding.line}`)).toEqual(["convex/q.ts:a:7"]);
    const { violations, stale } = enforceAllowlist(analysis, { "convex/q.ts#a": "justified", "convex/q.ts#unused": "stale" });
    expect(violations).toEqual([]);
    expect(stale).toEqual(["convex/q.ts#unused"]);
    expect(enforceAllowlist(analysis, {}).violations).toHaveLength(1);
  });
});

// ---- Runtime regressions --------------------------------------------------

// Any clock read now throws and is recorded; callers restore with `clock.mockReturnValue`.
const forbidClock = (clock: MockInstance<() => number>) => {
  const fail = () => { throw new Error("query read the clock"); };
  clock.mockClear();
  clock.mockImplementation(fail);
  return [clock, vi.spyOn(performance, "now").mockImplementation(fail)];
};

function fixture() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return { t, clock };
}

beforeAll(async () => { await import("../convex/http"); }, 30_000);
afterEach(() => vi.restoreAllMocks());

describe("API-key rate-limit identity is decided by the caller, not the cached query", () => {
  async function keyFixture() {
    const f = fixture();
    const secret = "expiring-api-key";
    const expiresAt = start + 5_000;
    const secretHash = await sha256(secret);
    const id = await f.t.mutation(internal.apiKeyCredentials.createInternal, {
      organizationId: "org-test", keyId: "expiring", keyPrefix: "rnd_live_expiring", name: "CI", secretHash, scopes: ["docs:read"], expiresAt, actorId: "owner",
    });
    const limit = vi.spyOn(apiKeyRateLimiter, "limit");
    const validate = () => f.t.fetch(`/api/rendro/credentials/validate?organizationId=org-test&scope=docs:read`, { headers: { authorization: `Bearer ${secret}` } });
    // [budget, bucket] of every limiter charge since the last call.
    const charges = () => { const calls = limit.mock.calls.map(call => [call[1], call[2]]); limit.mockClear(); return calls; };
    return { ...f, id, expiresAt, secretHash, charges, validate };
  }

  it("charges the credential bucket at expiresAt-1 and treats the key as unverified at expiresAt", async () => {
    const f = await keyFixture();
    f.clock.mockReturnValue(f.expiresAt - 1);
    await f.validate();
    expect(f.charges()).toEqual([["credential", { key: f.id }]]);
    f.clock.mockReturnValue(f.expiresAt);
    expect((await f.validate()).status).toBe(401);
    // The same cached lookup now falls back to the failed-IP budget.
    expect(f.charges()).toEqual([["failedIp", { key: "unverified" }]]);
    f.clock.mockReturnValue(f.expiresAt + 86_400_000);
    await f.validate();
    expect(f.charges()).toEqual([["failedIp", { key: "unverified" }]]);
  });

  it("returns the stored deadline from the query without reading the clock", async () => {
    const f = await keyFixture();
    f.clock.mockReturnValue(f.expiresAt + 1);
    const spies = forbidClock(f.clock);
    expect(await f.t.query(internal.apiKeyCredentials.verifiedIdInternal, { secretHash: f.secretHash })).toEqual({ id: f.id, expiresAt: f.expiresAt });
    expect(await f.t.query(internal.apiKeyCredentials.verifiedIdInternal, { secretHash: "unknown" })).toBeNull();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    spies[1].mockRestore();
    f.clock.mockReturnValue(f.expiresAt + 1);
    await f.t.mutation(internal.apiKeyCredentials.revokeInternal, { organizationId: "org-test", keyId: "expiring", actorId: "owner" });
    expect(await f.t.query(internal.apiKeyCredentials.verifiedIdInternal, { secretHash: f.secretHash })).toBeNull();
  });

  it("keeps a key without an expiry verified", async () => {
    const f = await keyFixture();
    await f.t.run(ctx => ctx.db.patch(f.id, { expiresAt: undefined }));
    f.clock.mockReturnValue(start + 10 ** 12);
    await f.validate();
    expect(f.charges()).toEqual([["credential", { key: f.id }]]);
  });
});
