import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkBudget, ShareAssetError, MAX_SHARE_WORK, MAX_SHARE_CPU_MS } from "../src/share-budget";
import { collectShareAssets } from "../src/share-assets";
import { parseShareHtml, MAX_HTML_DEPTH } from "../src/share-html";
import { parse, serialize, defaultTreeAdapter } from "parse5";
import { shareTree } from "../src/share-tree";

afterEach(() => vi.restoreAllMocks());
const files = [{ path: "index.html", contentType: "text/html" },
  ...Array.from({ length: 500 }, (_, i) => ({ path: `a${i}`, contentType: "image/png" }))];
const discover = (html: string, budget = new WorkBudget()) => collectShareAssets({ files }, "index.html",
  () => Promise.resolve(new Response(html).body), budget);

describe("one cumulative discovery budget", () => {
  it("checks work boundaries and the monotonic deadline, including a final short stage", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budget = new WorkBudget();
    budget.charge(MAX_SHARE_WORK);
    expect(() => budget.charge()).toThrow("document too complex to share");
    const timed = new WorkBudget();
    now = MAX_SHARE_CPU_MS;
    timed.charge();
    now++;
    expect(() => timed.check()).toThrow(ShareAssetError);
    expect(() => timed.charge(1024)).toThrow(ShareAssetError);
  });

  it("excludes async storage waits, including rejection, but counts synchronous setup", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budget = new WorkBudget();
    expect(await budget.wait(async () => { await Promise.resolve(); now += 1000; return 7; })).toBe(7);
    await expect(budget.wait(async () => { await Promise.resolve(); now += 1000; throw new Error("storage"); })).rejects.toThrow("storage");
    budget.check();
    await expect(budget.wait(() => { now += MAX_SHARE_CPU_MS + 1; return Promise.resolve(); })).rejects.toThrow(ShareAssetError);
  });

  it("preserves the complexity error when decoding exhausts the shared budget", async () => {
    const budget = new WorkBudget();
    const charge = budget.charge.bind(budget);
    // Allow stream reads, then exhaust precisely at the decoder entry.
    vi.spyOn(budget, "charge").mockImplementation(units => {
      if (units === 10 + "text/html".length + "index.html".length) charge(MAX_SHARE_WORK);
      charge(units);
    });
    await expect(discover("0123456789", budget)).rejects.toThrow("document too complex to share");
  });

  it("shares the remaining allowance across linked CSS sources", async () => {
    const manifest = { files: [files[0], { path: "a.css", contentType: "text/css" }, { path: "b.css", contentType: "text/css" }] };
    const html = '<link rel=stylesheet href=a.css><link rel=stylesheet href=b.css>';
    const css = "/*" + "x".repeat(130_000) + "*/";
    await expect(collectShareAssets(manifest, "index.html", path => Promise.resolve(new Response(path === "index.html" ? html : css).body)))
      .rejects.toThrow("document too complex to share");
  });

  it("does not re-encode or revalidate an unchanged allowlist", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const html = '<img srcset="' + files.slice(1).map(f => f.path + ', ').join("") + 'a0, '.repeat(10_000) + '">';
    expect(await discover(html)).toHaveLength(500);
    // Response encoding plus one encoding per UNIQUE path; no whole-list encoding.
    expect(encode.mock.calls.filter(([value]) => value?.startsWith('"a'))).toHaveLength(500);
    expect(encode.mock.calls.some(([value]) => value?.startsWith('["'))).toBe(false);
  });
});

// V8 coverage instruments every hot character loop. Measure production code in
// ONE uninstrumented child, with the real deadline enabled. Absolute CPU limits
// and strict deterministic work ratios accompany a 25ms cold-JIT/GC timing floor.
it("meets the generated adversarial CPU/work matrix and accepts a real 1 MiB document", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "tests/helpers/share-performance.ts"]);
  const report = JSON.parse(stdout) as { results: Array<{ name: string; points: Array<{ cpu: number; work: number }> }>; legitimate: { cpu: number; bytes: number } };
  for (const { name, points: [small, large] } of report.results) {
    expect(small.cpu, name).toBeLessThan(1000);
    expect(large.cpu, name).toBeLessThan(1000);
    expect(large.cpu, name).toBeLessThanOrEqual(Math.max(small.cpu, 25) * 5);
    expect(large.work, name).toBeLessThanOrEqual(small.work * 5);
  }
  expect(report.legitimate.bytes).toBeGreaterThan(1_000_000);
  expect(report.legitimate.cpu).toBeLessThan(1000);
}, 15_000); // Child startup/scheduling is separate from measured discovery CPU.

describe("bounded parser and linear tree repair", () => {
  it("bounds actual open elements including implicit html/body and templates", () => {
    expect(() => parseShareHtml('<div>'.repeat(MAX_HTML_DEPTH - 2))).not.toThrow();
    expect(() => parseShareHtml('<div>'.repeat(MAX_HTML_DEPTH - 1))).toThrow(ShareAssetError);
    expect(() => parseShareHtml('<template>'.repeat(MAX_HTML_DEPTH + 1))).toThrow(ShareAssetError);
    expect(() => parseShareHtml(Array.from({ length: MAX_HTML_DEPTH + 1 }, (_, i) => `<p><b data-i=${i}>`).join(""))).toThrow(ShareAssetError);
  });

  it.each([
    '<!doctype html><html a=1><html b=2><body c=3><body d=4>x',
    '<table>hello<!--c--><b>x</b><i>y</i>after<tr><td>cell</table>end',
    '<b><p>1<i>2</b>3</i>4</p>', '<b><div><i>x</b>y</i>z</div>',
    '<template><table>text<div>a</div></table></template><img src=a0>',
    '<svg><![CDATA[text]]><g><image href=a0/></g></svg>',
    '<body>x<frameset><frame></frameset>',
  ])("preserves parse5 tree correction: %s", html => {
    expect(serialize(parseShareHtml(html))).toBe(serialize(parse(html)));
  });

  it("preserves first matching attributes across foreign namespaces", async () => {
    expect(await discover('<svg><image href="a0" xlink:href="a1"/></svg>')).toEqual(["a0"]);
  });

  it("ignores non-text children of foreign style elements", async () => {
    expect(await discover('<svg><style><!-- ignored --></style></svg>')).toEqual([]);
  });

  it("bounds repeated html/body attribute adoption", () => {
    expect(() => parseShareHtml('<html ' + Array.from({ length: 128 }, (_, i) => 'a' + i).join(' ') + '><html extra>')).toThrow(ShareAssetError);
  });

  it("supports unlinking first/middle/last siblings and detached nodes in constant work", () => {
    const tree = shareTree(new WorkBudget());
    const parent = defaultTreeAdapter.createDocument();
    const a = defaultTreeAdapter.createCommentNode('a');
    const b = defaultTreeAdapter.createCommentNode('b');
    const c = defaultTreeAdapter.createCommentNode('c');
    tree.adapter.appendChild(parent, a);
    tree.adapter.appendChild(parent, b);
    tree.adapter.insertBefore(parent, c, b);
    tree.adapter.detachNode(c);
    tree.adapter.detachNode(a);
    tree.adapter.detachNode(b);
    tree.adapter.detachNode(b);
    tree.adapter.setDocumentType(parent, 'html', '', '');
    tree.adapter.setDocumentType(parent, 'html', 'public', 'system');
    tree.finish();
    expect(parent.childNodes).toEqual([expect.objectContaining({ nodeName: '#documentType', publicId: 'public' })]);
  });
});
