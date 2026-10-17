import { collectShareAssets } from "../../src/share-assets";
import { WorkBudget, ShareAssetError } from "../../src/share-budget";
import assert from "node:assert/strict";
const files = [{ path: "index.html", contentType: "text/html" },
  ...Array.from({ length: 500 }, (_, i) => ({ path: `a${i}`, contentType: "image/png" }))];
const discover = (html: string, budget = new WorkBudget()) => collectShareAssets({ files }, "index.html",
  () => Promise.resolve(new Response(html).body), budget);
const matrix: Array<[string, number, (n: number) => string]> = [
  ["nested div", 1000, n => '<div>'.repeat(n)],
  ["nested templates", 1000, n => '<template>'.repeat(n)],
  ["duplicate paths", 2500, n => '<img srcset="' + files.slice(1).map(f => f.path + ', ').join('') + 'a0, '.repeat(n) + '">'],
  ["unique paths up to cap", 125, n => '<img srcset="' + files.slice(1, n + 1).map(f => f.path + ', ').join('') + '">'],
  ["giant attribute", 25_000, n => '<img title="' + 'x'.repeat(n) + '" src=a0>'],
  ["many attributes", 1000, n => '<img' + ' a'.repeat(n) + '>'],
  ["huge srcset", 2500, n => '<img srcset="' + 'a0 1x, '.repeat(n) + '">'],
  ["CSS URLs and imports", 1000, n => '<style>' + '@import "a0";a{background:url(a1)}'.repeat(n) + '</style>'],
  ["long URLs", 10_000, n => '<img src="' + 'x'.repeat(n) + '">'],
  ["comments", 10_000, n => '<!--' + '->x'.repeat(n)],
  ["CDATA", 10_000, n => '<svg><![CDATA[' + 'x]<'.repeat(n)],
  ["unclosed tag", 10_000, n => '<img a="' + 'x <'.repeat(n)],
  ["foster parenting", 1000, n => '<table>' + '<div></div>x'.repeat(n)],
  ["formatting attributes", 128, n => Array.from({ length: n }, (_, i) => '<b ' + Array.from({ length: 127 }, (_, j) => `a${j}=x`).join(' ') + ` last=${i}>`).join('')],
  ["formatting repair", 1000, n => '<b><p>x</b>y</p>'.repeat(n)],
  ["embedded whitespace URL", 10_000, n => '<img src="a' + ' '.repeat(n) + 'b">'],
  ["embedded comma srcset", 10_000, n => '<img srcset="a' + ','.repeat(n) + 'b,">'],
  ["mixed", 1000, n => '<div style="background:url(a0)"><img srcset="a1, a1"><!-- x --></div>'.repeat(n)],
];

const results = [];
// Warm tiny parser/URL paths once.
await discover('<img src=a0>');
// Contention (other processes, SMT siblings, shared caches) only ever ADDS CPU time, so the
// fastest of several samples is the least-contended estimate of the true cost. The small and
// large inputs are sampled alternately, so a burst of contention cannot land on just one side
// of the ratio. A real super-linear regression slows every sample and still raises the minimum.
const SAMPLES = 5;
// The production deadline is wall-clock, so a starved process can be cut off by it. That is
// the documented transient `share_busy` outcome, not a cost measurement: such a sample stops
// early, so its CPU and work are understated and must not feed the scaling comparison.
// A work-cap rejection is deterministic and is measured like a success.
async function sample(html: string) {
  const budget = new WorkBudget();
  const start = process.cpuUsage();
  let interrupted = false;
  try { await discover(html, budget); }
  catch (error) {
    assert(error instanceof ShareAssetError);
    interrupted = error.reason === "deadline";
  }
  const elapsed = process.cpuUsage(start);
  return { cpu: (elapsed.user + elapsed.system) / 1000, work: budget.used, interrupted };
}
for (const [name, n, generate] of matrix) {
  const inputs = [n, n * 4].map(generate);
  const samples: Array<Array<Awaited<ReturnType<typeof sample>>>> = inputs.map(() => []);
  for (let round = 0; round < SAMPLES; round++) {
    for (const [index, html] of inputs.entries()) samples[index].push(await sample(html));
  }
  // `cpu` (minimum of the complete samples) feeds the scaling ratio; `maxCpu` (worst of ALL
  // samples) keeps the absolute ceiling.
  const points = samples.map(taken => {
    const complete = taken.filter(({ interrupted }) => !interrupted);
    assert(complete.length > 0, `${name}: every sample hit the wall-clock deadline`);
    return {
      cpu: Math.min(...complete.map(({ cpu }) => cpu)),
      maxCpu: Math.max(...taken.map(({ cpu }) => cpu)),
      work: complete[0].work,
    };
  });
  results.push({ name, points });
}
const html = '<!doctype html><meta charset=utf-8><title>Manual</title>'
  + ('<section><h2>Usage</h2><p>' + 'Readable documentation. '.repeat(90) + '</p><img src=a0></section>').repeat(500);
assert(html.length > 1_000_000);
// A document that needs under 1s of CPU is accepted by the real deadline unless the process is
// starved of CPU; retry only that wall-clock `share_busy` outcome, as the product tells clients to.
// A genuinely slow parser exceeds the deadline on every attempt and still fails.
let legitimate: { bytes: number; cpu: number } | undefined;
for (let attempt = 0; attempt < 5 && !legitimate; attempt++) {
  const start = process.cpuUsage();
  try { assert.deepEqual(await discover(html), ["a0"]); }
  catch (error) {
    if (error instanceof ShareAssetError && error.reason === "deadline" && attempt < 4) continue;
    throw error;
  }
  const elapsed = process.cpuUsage(start);
  legitimate = { bytes: html.length, cpu: (elapsed.user + elapsed.system) / 1000 };
}
console.log(JSON.stringify({ results, legitimate }));
