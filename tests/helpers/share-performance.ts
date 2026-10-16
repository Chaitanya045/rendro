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
// Warm tiny parser/URL paths once; no timing retries and no sleeping.
await discover('<img src=a0>');
for (const [name, n, generate] of matrix) {
  const points = [];
  for (const size of [n, n * 4]) {
    const html = generate(size);
    const budget = new WorkBudget();
    const start = process.cpuUsage();
    let outcome = "success";
    try { await discover(html, budget); }
    catch (error) { assert(error instanceof ShareAssetError); outcome = "controlled rejection"; }
    const elapsed = process.cpuUsage(start);
    points.push({ cpu: (elapsed.user + elapsed.system) / 1000, work: budget.used, outcome });
  }
  results.push({ name, points });
}
const html = '<!doctype html><meta charset=utf-8><title>Manual</title>'
  + ('<section><h2>Usage</h2><p>' + 'Readable documentation. '.repeat(90) + '</p><img src=a0></section>').repeat(500);
assert(html.length > 1_000_000);
const start = process.cpuUsage();
assert.deepEqual(await discover(html), ["a0"]);
const elapsed = process.cpuUsage(start);
console.log(JSON.stringify({ results, legitimate: { bytes: html.length, cpu: (elapsed.user + elapsed.system) / 1000 } }));
