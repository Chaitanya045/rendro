import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import GithubSlugger from "github-slugger";
import { experimental_readRawConfig } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexGraph, dynamicReaders, extractReads, moduleGraph, type Reads } from "../scripts/env-reads";
import { convexDeployable, workers, type Binding, type DeployableKey } from "../scripts/production-manifest";

const root = join(import.meta.dirname, "..");
const keys = Object.keys(workers) as DeployableKey[];

/** The names a deployable reads through `env`, according to the manifest. */
function manifestReads(key: DeployableKey): string[] {
  const { settings, bindings } = workers[key];
  return [...settings.map((setting) => setting.name), ...bindings.map((item) => item.name)].sort();
}

function located(reads: Reads, names: string[]): string[] {
  return names.map((name) => `${name} (${reads.names.get(name)!.join(", ")})`);
}

describe("production manifest stays in sync with the code (#333)", () => {
  const reads = new Map<DeployableKey | "convex", Reads>();
  beforeAll(async () => {
    for (const key of keys) reads.set(key, await extractReads(root, await moduleGraph(root, [workers[key].entry])));
    reads.set("convex", await extractReads(root, await convexGraph(root, convexDeployable.entries)));
  });

  it.each(keys)("lists every binding, secret and var the %s Worker reads, and nothing it does not", (key) => {
    const found = reads.get(key)!;
    const listed = manifestReads(key);
    const read = [...found.names.keys()].sort();
    // A new read: add it to scripts/production-manifest.ts (required, optional or forbidden) and to docs/SETUP.md.
    expect(located(found, read.filter((name) => !listed.includes(name))), "read by the code but not in the manifest").toEqual([]);
    // A removed read: remove it from the manifest (and from production, once deployed code no longer reads it).
    expect(listed.filter((name) => !read.includes(name)), "in the manifest but no longer read").toEqual([]);
  });

  it("lists every env var Convex reads, and nothing it does not", () => {
    const found = reads.get("convex")!;
    const listed = convexDeployable.settings.map((setting) => setting.name).sort();
    const read = [...found.names.keys()].sort();
    expect(located(found, read.filter((name) => !listed.includes(name))), "read by Convex but not in the manifest").toEqual([]);
    expect(listed.filter((name) => !read.includes(name)), "in the manifest but no longer read").toEqual([]);
    expect(found.files).toContain("convex/auth.ts");
  });

  it("allows computed-name reads only in registered readers, and every reader still matches its code", () => {
    for (const found of reads.values()) {
      expect(found.unregistered, "a computed env read: register it in dynamicReaders with patterns for its names").toEqual([]);
      expect(found.stale, "a registered reader's pattern no longer matches: update dynamicReaders").toEqual([]);
    }
    const graphs = [...reads.values()].flatMap((found) => found.files);
    for (const reader of dynamicReaders) expect(graphs, `${reader.file} is registered but no deployable imports it`).toContain(reader.file);
  });

  it.each(keys)("the %s Worker's main module exports every class and entrypoint the manifest binds", async (key) => {
    const { entry, exports, bindings } = workers[key];
    const source = await readFile(join(root, entry), "utf8");
    const exported = [...source.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim()));
    for (const name of exports) expect(exported).toContain(name);
    const own = bindings.filter((item): item is Extract<Binding, { kind: "durable-object" }> => item.kind === "durable-object" && !item.script);
    for (const item of own) expect(exports).toContain(item.className);
    for (const other of keys) {
      for (const item of workers[other].bindings) {
        if (item.kind === "durable-object" && item.script === key) expect(exports).toContain(item.className);
        if (item.kind === "service" && item.service === key) expect(exports).toContain(item.entrypoint);
      }
    }
  });

  it("has the handlers its queue consumer and cron need", async () => {
    const files = reads.get("ingest")!.files;
    const code = (await Promise.all(files.map((file) => readFile(join(root, file), "utf8")))).join("\n");
    for (const item of workers.ingest.wiring) {
      if (item.kind === "queue-consumer") {
        expect(workers.ingest.bindings.find((candidate) => candidate.name === item.producer)?.kind).toBe("queue-producer");
        expect(code).toMatch(/\basync queue\(/);
      }
      if (item.kind === "cron") expect(code).toMatch(/\basync scheduled\(/);
    }
  });

  it("declares, in every wrangler configuration, only bindings the manifest knows, with the same type", () => {
    const sections: Record<string, (raw: Record<string, unknown>) => unknown[]> = {
      r2: (raw) => (raw.r2_buckets as unknown[] | undefined) ?? [],
      kv: (raw) => (raw.kv_namespaces as unknown[] | undefined) ?? [],
      d1: (raw) => (raw.d1_databases as unknown[] | undefined) ?? [],
      "queue-producer": (raw) => (raw.queues as { producers?: unknown[] } | undefined)?.producers ?? [],
      "durable-object": (raw) => (raw.durable_objects as { bindings?: unknown[] } | undefined)?.bindings ?? [],
      service: (raw) => (raw.services as unknown[] | undefined) ?? [],
      ratelimit: (raw) => (raw.ratelimits as unknown[] | undefined) ?? [],
      analytics: (raw) => (raw.analytics_engine_datasets as unknown[] | undefined) ?? [],
    };
    let checked = 0;
    for (const key of keys) {
      const raw = experimental_readRawConfig({ config: join(root, workers[key].config) }).rawConfig as Record<string, unknown>;
      const all = [raw, ...Object.values((raw.env as Record<string, Record<string, unknown>> | undefined) ?? {})];
      for (const section of all) {
        for (const [kind, entries] of Object.entries(sections)) {
          for (const entry of entries(section) as { binding?: string; name?: string }[]) {
            const name = entry.binding ?? entry.name;
            expect(workers[key].bindings.find((item) => item.name === name)?.kind, `${workers[key].config}: ${name}`).toBe(kind);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("points every item at a section that exists", async () => {
    const anchors = new Map<string, Set<string>>();
    for (const file of ["TECHNICAL.md", "SETUP.md"]) {
      const slugger = new GithubSlugger();
      const headings = (await readFile(join(root, "docs", file), "utf8")).split("\n").flatMap((line) => /^#+ (.+)$/.exec(line)?.slice(1) ?? []);
      anchors.set(file, new Set(headings.map((heading) => slugger.slug(heading))));
    }
    const items = [...keys.flatMap((key) => [...workers[key].settings, ...workers[key].bindings, ...workers[key].wiring]), ...convexDeployable.settings];
    for (const item of items) {
      const [file, anchor] = item.doc.split("#");
      expect(anchors.get(file!)?.has(anchor!), item.doc).toBe(true);
      expect(item.purpose.length).toBeGreaterThan(10);
    }
  });
});

describe("env read extraction", () => {
  let dir: string;
  const write = async (files: Record<string, string>) => {
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), source);
    }
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rendro-env-reads-"));
    await write({
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "src/entry.ts": [
        'import { helper } from "@/helper";',
        'import { Hono } from "hono";',
        'import wasm from "./engine.wasm";',
        "// env.IN_A_COMMENT is not a read",
        "/*! env.IN_A_LEGAL_COMMENT is not a read either */",
        "interface Env { DECLARED_ONLY?: string }",
        "export default { fetch(_r: Request, env: Env & Record<string, string>) { const { DESTRUCTURED, RENAMED: alias, DEFAULTED = \"x\", ...rest } = env; return [env.STATIC, env?.OPTIONAL, process.env.PROCESS, DESTRUCTURED, alias, DEFAULTED, rest, helper(env), Hono, wasm]; } };",
      ].join("\n"),
      "src/helper.ts": 'export function helper(env: Record<string, unknown>) { return [env["COMPUTED"], read(env, "VIA_READER")]; }\nfunction read(env: Record<string, unknown>, name: string) { return env[name]; }',
      "src/engine.wasm": "",
      "src/view.tsx": "export const View = (props: { env: Record<string, string> }) => <p>{props.env.FROM_TSX}</p>;",
      "src/loose.ts": "export const all = { ...process.env };",
      "convex/a.ts": 'import { b } from "./b";\nexport const a = () => process.env.CONVEX_A ?? b;',
      "convex/b.ts": "export const b = 1;",
      "convex/a.test.ts": "export const t = process.env.TEST_ONLY;",
      "convex/_generated/api.ts": "export const g = process.env.GENERATED;",
    });
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("follows local imports only and compiles each module before reading it", async () => {
    const files = await moduleGraph(dir, ["src/entry.ts"]);
    expect(files).toEqual(["src/entry.ts", "src/helper.ts"]);
    const reads = await extractReads(dir, [...files, "src/view.tsx"], [{ file: "src/helper.ts", names: [/\bread\(\s*\w+\s*,\s*("[A-Z_]+")/g] }]);
    expect([...reads.names.keys()].sort()).toEqual(["DEFAULTED", "DESTRUCTURED", "FROM_TSX", "OPTIONAL", "PROCESS", "RENAMED", "STATIC", "VIA_READER"]);
    expect(reads.names.get("VIA_READER")).toEqual(["src/helper.ts"]);
    expect(reads.unregistered).toEqual([]);
    expect(reads.stale).toEqual([]);
  });

  it("reports computed reads outside a registered reader, and readers whose patterns stopped matching", async () => {
    const reads = await extractReads(dir, ["src/entry.ts", "src/helper.ts", "src/loose.ts"], [
      { file: "src/entry.ts", names: [/\bnoSuchReader\(("[A-Z_]+")\)/g] },
      { file: "src/absent.ts", names: [/./g] },
    ]);
    expect(reads.unregistered).toEqual(["src/helper.ts:2", "src/helper.ts:5", "src/loose.ts:1"]);
    expect(reads.stale).toEqual(["src/entry.ts: \\bnoSuchReader\\((\"[A-Z_]+\")\\)"]);
  });

  it("reads the same name once per module, from every module that reads it", async () => {
    await write({ "src/twice.ts": "export const x = (env: { A: string }) => [env.A, env.A];", "src/again.ts": "export const y = (env: { A: string }) => env.A;" });
    const reads = await extractReads(dir, ["src/twice.ts", "src/again.ts"], []);
    expect(reads.names.get("A")).toEqual(["src/twice.ts", "src/again.ts"]);
  });

  it("walks every Convex module except generated code and tests", async () => {
    expect(await convexGraph(dir, "convex/**/*.ts")).toEqual(["convex/a.ts", "convex/b.ts"]);
  });
});
