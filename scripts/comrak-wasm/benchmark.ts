import { performance } from "node:perf_hooks";

/*
 * The hostile-input benchmark from docs/TECHNICAL.md: 26 pathological Markdown
 * inputs, each about 1 MiB (the source cap), aimed at the parser's worst cases
 * (nesting, autolink/reference spam, giant tables, format floods). It measures
 * the raw comrak engine, which is what the self-built renderer replaces.
 *
 * This is a reporting tool, not a CI gate: wall time belongs to a clean runner.
 * Run it with `pnpm bench:hostile`; it only fails when an input exceeds the
 * 30 s Worker CPU budget, which would be a catastrophic parser regression.
 */

const MIB = 1024 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(MIB / unit.length)).slice(0, MIB);
const lines = (unit: string, count: number) => unit.repeat(count);

export interface HostileInput {
  name: string;
  source: string;
}

export type Render = (markdown: string) => string;
export type Log = (message: string) => void;

export interface HostileReport {
  inputs: number;
  totalMs: number;
  worst: HostileInput;
  worstMs: number;
}

export const hostileInputs: HostileInput[] = [
  { name: "nested-brackets", source: "[".repeat(MIB / 2) + "x" + "]".repeat(MIB / 2) },
  { name: "nested-parentheses", source: "[l](" + "(".repeat(MIB - 8) + ")) " },
  { name: "nested-brackets-and-parens", source: "[".repeat(MIB / 4) + "x](" + ")".repeat(MIB / 4) },
  { name: "emphasis-stars", source: fill("*") },
  { name: "emphasis-underscores", source: fill("_") },
  { name: "alternating-emphasis", source: fill("*a*") },
  { name: "double-emphasis", source: fill("**a** ") },
  { name: "autolink-literals", source: fill("https://a.b/c ") },
  { name: "angle-autolinks", source: fill("<https://a.b/c> ") },
  { name: "email-autolinks", source: fill("<a@b.co> ") },
  { name: "link-references", source: lines("[a][b] ", MIB / 8) },
  { name: "reference-definitions", source: lines("[b]: /x\n", 50_000) },
  { name: "footnote-references", source: lines("x[^a] ", 100_000) + "\n\n[^a]: note\n" },
  { name: "inline-footnotes", source: lines("^[x] ", 100_000) },
  { name: "image-spam", source: fill("![a](b) ") },
  { name: "table-150k-rows", source: "| a | b |\n| - | - |\n" + lines("| x | y |\n", 150_000) },
  { name: "table-wide", source: "|" + " a |".repeat(2_000) + "\n|" + " - |".repeat(2_000) + "\n" + "|" + " x |".repeat(2_000) + "\n" },
  { name: "indented-list-1000", source: lines(" ".repeat(1_000 * 2) + "x\n", 20) },
  { name: "list-items", source: lines("- item\n", MIB / 7) },
  { name: "task-list", source: lines("- [ ] x\n", MIB / 9) },
  { name: "blockquotes", source: lines("> x\n", MIB / 4) },
  { name: "nested-blockquotes", source: ">".repeat(MIB / 2) + " x\n" },
  { name: "atx-headings", source: lines("# h\n", MIB / 4) },
  { name: "html-divs", source: fill("<div>") },
  { name: "code-spans", source: fill("`x` ") },
  { name: "entities", source: fill("&amp;") },
];

/** Render each input and report per-input time; throws once an input exceeds the CPU budget. */
export function runHostileBenchmark(render: Render, inputs: HostileInput[], log: Log, budgetMs = 30_000): HostileReport {
  let totalMs = 0;
  let worst = inputs[0];
  let worstMs = 0;

  log("input                          KiB    output KiB   ms");
  for (const input of inputs) {
    const start = performance.now();
    const output = render(input.source);
    const ms = performance.now() - start;
    if (ms > worstMs) { worstMs = ms; worst = input; }
    totalMs += ms;
    log(`${input.name.padEnd(30)} ${String(Math.round(input.source.length / 1024)).padStart(5)}  ${String(Math.round(output.length / 1024)).padStart(11)}  ${ms.toFixed(0).padStart(6)}`);
    if (ms > budgetMs) throw new Error(`${input.name} took ${ms.toFixed(0)} ms, over the ${budgetMs} ms Worker CPU budget`);
  }

  const throughput = (inputs.length * MIB) / (1024 * 1024 * (totalMs / 1000));
  log(`\n${inputs.length} inputs: ${throughput.toFixed(1)} MiB/s total, slowest ${worst.name} at ${worstMs.toFixed(0)} ms`);
  return { inputs: inputs.length, totalMs, worst, worstMs };
}
