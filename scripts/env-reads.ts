/**
 * Static extraction of the bindings, secrets and env vars a deployable reads (#333), for the manifest
 * sync test. The module graph comes from esbuild (local imports only, from the deployable's entry
 * points), and each module is compiled with esbuild first, so comments and type declarations never
 * count as reads.
 *
 * A read is `env.NAME`, `env?.NAME`, `c.env.NAME`, `process.env.NAME` or a destructuring of `env`.
 * A dynamic read (`env[name]`, `process.env[name]`, a whole `process.env`) is allowed only in a module
 * registered in `dynamicReaders`, whose patterns name what it reads; any other dynamic read is
 * reported, so a new reader cannot hide names from the manifest.
 */
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { build, transform, type Plugin } from "esbuild";
import { glob } from "tinyglobby";
import { sourceLoader } from "./coverage-policy";

export interface DynamicReader {
  /** The module that reads by computed name. */
  file: string;
  /** Patterns over every module in the graph; each capture group holds one or more quoted names. */
  names: RegExp[];
}

/** Modules that read by computed name, and where the names they read are written. */
export const dynamicReaders: DynamicReader[] = [
  // Copies every string binding into process.env; the names are the other reads.
  { file: "src/worker.ts", names: [] },
  // Validates process.env against envSchema: its keys are the reads.
  { file: "src/config.ts", names: [/^\s*([A-Z][A-Z0-9_]*): z\./gm] },
  { file: "src/repo-read/admission.ts", names: [/\brateLimiter\(\s*[\w.]+\s*,\s*("[A-Z][A-Z0-9_]*")/g] },
  { file: "src/rum/route.ts", names: [/\bbinding\(\s*[\w.]+\s*,\s*("[A-Z][A-Z0-9_]*")/g] },
  { file: "convex/auth.ts", names: [/\boptionEnv\(\s*("[A-Z][A-Z0-9_]*")\s*\)/g, /for \(const \w+ of \[([^\]]*)\]\)\s*\{\s*if \(!process\.env\[/g] },
  { file: "convex/authEmails.ts", names: [/\brequiredEmailEnv\(\s*("[A-Z][A-Z0-9_]*")\s*\)/g] },
];

export interface Reads {
  /** Name to the modules that read it. */
  names: Map<string, string[]>;
  /** Dynamic reads outside a registered module, as `file:line`. */
  unregistered: string[];
  /** Registered readers whose patterns found nothing (the pattern no longer matches the code). */
  stale: string[];
  files: string[];
}

const STATIC_READ = /\benv\s*(?:\?\.|\.)\s*([A-Z][A-Z0-9_]*)\b/g;
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:[\w$]+\.)*env\b/g;
const DYNAMIC_READ = /\benv\s*(?:\?\.)?\s*\[|\bprocess\.env\b(?!\s*(?:\?\.|\.)\s*[A-Za-z_$])/g;
const QUOTED = /"([A-Z][A-Z0-9_]*)"/g;
const NAME = /^[A-Z][A-Z0-9_]*$/;

/** Local imports only: packages are not ours, and Wrangler provides `cloudflare:` and `node:` modules. */
const localOnly: Plugin = {
  name: "local-only",
  setup(build) {
    build.onResolve({ filter: /^(?:[^./@]|@[^/])/ }, (args) => ({ path: args.path, external: true }));
  },
};

/** The repository-relative modules reachable from `entries` (files under node_modules excluded). */
export async function moduleGraph(root: string, entries: string[]): Promise<string[]> {
  const result = await build({
    absWorkingDir: root, entryPoints: entries, bundle: true, write: false, metafile: true, outdir: "out",
    platform: "neutral", format: "esm", logLevel: "silent", plugins: [localOnly], loader: { ".wasm": "empty" },
    tsconfig: resolve(root, "tsconfig.json"),
  });
  return Object.keys(result.metafile.inputs).filter((file) => /\.[cm]?[jt]sx?$/.test(file)).sort();
}

/** Every module Convex deploys, with what they import. */
export async function convexGraph(root: string, pattern: string): Promise<string[]> {
  const entries = await glob(pattern, { cwd: root, ignore: ["**/_generated/**", "**/*.d.ts", "**/*.test.ts"] });
  return moduleGraph(root, entries.sort());
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/** A captured group: one bare name, or every quoted name in it. */
function namesIn(group: string): string[] {
  return NAME.test(group) ? [group] : [...group.matchAll(QUOTED)].map((match) => match[1]!);
}

/** The keys a destructuring pattern takes: `{ A, B: alias, C = fallback, ...rest }` reads A, B and C. */
function destructured(pattern: string): string[] {
  return pattern.split(",").map((part) => part.split(/[:=]/)[0]!.trim()).filter((key) => NAME.test(key));
}

/** Compiles one module as the project does: no comments, no types. */
async function compiled(root: string, file: string): Promise<string> {
  const source = await readFile(resolve(root, file), "utf8");
  return (await transform(source, { ...sourceLoader(file), legalComments: "none" })).code;
}

/** The names a set of modules reads, with unregistered dynamic reads and stale readers. */
export async function extractReads(root: string, files: string[], readers: DynamicReader[] = dynamicReaders): Promise<Reads> {
  const names = new Map<string, string[]>();
  const add = (name: string, file: string) => names.set(name, [...new Set([...(names.get(name) ?? []), file])]);
  const unregistered: string[] = [];
  const codes = new Map<string, string>();
  for (const file of files) codes.set(file, await compiled(root, file));
  const registered = new Map(readers.map((reader) => [reader.file, reader]));
  for (const [file, code] of codes) {
    for (const match of code.matchAll(STATIC_READ)) add(match[1]!, file);
    for (const match of code.matchAll(DESTRUCTURE)) for (const name of destructured(match[1]!)) add(name, file);
    if (registered.has(file)) continue;
    for (const match of code.matchAll(DYNAMIC_READ)) unregistered.push(`${file}:${lineOf(code, match.index)}`);
  }
  const stale: string[] = [];
  for (const reader of readers.filter((candidate) => codes.has(candidate.file))) {
    for (const pattern of reader.names) {
      let found = false;
      for (const [file, code] of codes) {
        for (const match of code.matchAll(pattern)) {
          for (const group of match.slice(1)) for (const name of namesIn(group!)) { add(name, file); found = true; }
        }
      }
      if (!found) stale.push(`${reader.file}: ${pattern.source}`);
    }
  }
  return { names, unregistered, stale, files: files.map((file) => relative(root, resolve(root, file))) };
}
