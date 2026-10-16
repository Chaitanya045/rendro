import type { CoverageMapData } from "istanbul-lib-coverage";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { browserStepTimeout, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";
import { convertBrowserCoverage } from "./helpers/browser-coverage";

let failureReport: CoverageMapData | undefined;
let captureFailure = false;
let failureFixtureStarted = false;
let deliberateFailureReached = false;
let advanceReportingClock = false;
let slowReportReached = false;
const harness = createBrowserHarness({ coverage: true, chromiumArgs: ["--site-per-process", "--enable-features=IsolateSandboxedIframes"], onCoverage: report => {
  if (captureFailure) failureReport = report;
  if (advanceReportingClock) {
    slowReportReached = true;
    vi.advanceTimersByTime(browserStepTimeout + 1);
  }
} });
const probe = "tests/fixtures/browser-coverage-probe.ts";
const included = new Set([probe, "src/commentor/commentor.ts"]);
beforeAll(async () => {
  const assets = new Map([
    ["/probe.js", await bundleBrowserAsset(probe)],
    ["/commentor.js", await bundleBrowserAsset("src/commentor/commentor.ts")],
  ]);
  await harness.start((request, response) => {
    if (request.url === "/unmapped") {
      response.setHeader("Content-Type", "text/javascript");
      response.end("globalThis.unmapped = true");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(request.url === "/opener" ? '<!doctype html><a href="/popup" target="_blank">Popup</a>' : request.url === "/frame"
      ? '<!doctype html><p>Child</p><script src="/probe.js"></script><script src="/commentor.js"></script>'
      : request.url === "/popup"
        ? '<!doctype html><script src="/probe.js"></script><button onclick="window.close()">Close</button>'
        : '<!doctype html><title>Coverage</title><iframe sandbox="allow-scripts" src="/frame"></iframe><a href="/popup" target="_blank">Popup</a>');
  }, assets);
});

it("maps opaque child branches to exact source lines across navigation", async () => {
  const page = await harness.newPage();
  await page.goto(harness.origin);
  const frame = page.frames().find(frame => frame !== page.mainFrame())!;
  expect(await frame.evaluate(() => location.origin)).toBe(harness.origin);
  // The sandbox makes the security origin opaque despite location.origin.
  expect(await frame.evaluate(() => { try { return parent.document.title; } catch { return "opaque"; } })).toBe("opaque");
  await expect.poll(() => frame.evaluate("globalThis.coverageProof")).toBe("executed browser branch");
  expect(await harness.coverageTargets(page)).toContain("iframe");
  await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await frame.evaluate("coverageProbe(true)");
  await harness.flushCoverage(page);
  await frame.evaluate("coverageProbe(true)");
  await frame.goto(`${harness.origin}/__browser_health`);
  const result = await harness.coverageSnapshot(page, included);
  expect(Object.keys(result).sort()).toEqual([...included].sort());
  const file = result[probe];
  expect(file).toBeDefined();
  const countsAt = (line: number) => Object.entries(file.statementMap).filter(([, loc]) => loc.start.line === line).map(([id]) => file.s[id]);
  expect(countsAt(3)).toEqual([3]);
  expect(countsAt(5)).toEqual([0]);
  expect(Object.values(file.b)).toContainEqual([3, 0]);
  const unused = Object.entries(file.fnMap).find(([, fn]) => fn.name === "neverCalled")!;
  expect(file.f[unused[0]]).toBe(0);
  expect(Object.values(result["src/commentor/commentor.ts"].s).some(count => count > 0)).toBe(true);
});

it.each(["navigate", "self-close"])("collects popup execution before %s", async action => {
  const page = await harness.newPage();
  await page.goto(`${harness.origin}/opener`);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Popup" }).click();
  const popup = await popupPromise;
  await expect.poll(() => popup.evaluate("globalThis.coverageProof")).toBe("executed browser branch");
  await popup.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await popup.evaluate("coverageProbe(true)");
  await harness.flushCoverage(popup);
  await popup.evaluate("coverageProbe(true)");
  if (action === "navigate") {
    await popup.goto(`${harness.origin}/__browser_health`);
    await popup.close();
  } else {
    const closed = popup.waitForEvent("close");
    await popup.evaluate(() => { setTimeout(() => window.close(), 0); });
    await closed;
  }
  const result = await harness.coverageSnapshot(page, included);
  const popupFile = result[probe];
  const executed = Object.entries(popupFile.statementMap).find(([, loc]) => loc.start.line === 3)!;
  expect(popupFile.s[executed[0]]).toBe(3);
  expect(result["src/commentor/commentor.ts"]).toBeUndefined();
});

it("flushes an opaque child before direct DOM removal", async () => {
  const page = await harness.newPage();
  await page.goto(harness.origin);
  const frame = page.frames().find(frame => frame !== page.mainFrame())!;
  await expect.poll(() => frame.evaluate("globalThis.coverageProof")).toBe("executed browser branch");
  await frame.evaluate("coverageProbe(true)");
  await harness.flushCoverage(page);
  await page.locator("iframe").evaluate(frame => frame.remove());
  const report = await harness.coverageSnapshot(page, included);
  const file = report[probe];
  const executed = Object.entries(file.statementMap).find(([, loc]) => loc.start.line === 3)!;
  expect(file.s[executed[0]]).toBe(2);
});

it("flushes every child before reloading its parent", async () => {
  const page = await harness.newPage();
  await page.goto(harness.origin);
  const frame = page.frames().find(frame => frame !== page.mainFrame())!;
  await frame.evaluate("coverageProbe(true)");
  await page.reload();
  const report = await harness.coverageSnapshot(page, included);
  const file = report[probe];
  const executed = Object.entries(file.statementMap).find(([, loc]) => loc.start.line === 3)!;
  expect(file.s[executed[0]]).toBe(3);
});

it("collects opaque child execution before page code reloads the child", async () => {
  const page = await harness.newPage();
  await page.goto(harness.origin);
  const frame = page.frames().find(frame => frame !== page.mainFrame())!;
  await expect.poll(() => frame.evaluate("globalThis.coverageProof")).toBe("executed browser branch");
  await frame.evaluate("coverageProbe(true)");
  // Page code navigates itself; no harness navigation API is involved.
  const reloaded = page.waitForEvent("framenavigated", navigated => navigated === frame);
  await frame.evaluate(() => { setTimeout(() => location.reload(), 0); });
  await reloaded;
  await expect.poll(() => frame.evaluate("globalThis.coverageProof")).toBe("executed browser branch");
  const file = (await harness.coverageSnapshot(page, included))[probe];
  const executed = Object.entries(file.statementMap).find(([, loc]) => loc.start.line === 3)!;
  expect(file.s[executed[0]]).toBe(3);
});

it("rejects unmapped first-party scripts", async () => {
  await expect(convertBrowserCoverage([{ scriptId: "1", url: `${harness.origin}/missing.js`, source: "window.unmapped = true", functions: [] }]))
    .rejects.toThrow("Unmapped browser script");
  await expect(convertBrowserCoverage([{ scriptId: "2", url: `${harness.origin}/missing.js`, functions: [] }]))
    .rejects.toThrow("Missing browser script source");
});

it("recovers a sourceless sample only from one agreeing source for its URL", async () => {
  const code = await bundleBrowserAsset(probe);
  const url = `${harness.origin}/probe.js`;
  const start = code.indexOf("function coverageProbe");
  const sample = (scriptId: string, count: number, source?: string) => ({ scriptId, url, source, functions: [
    { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] },
    { functionName: "coverageProbe", isBlockCoverage: true, ranges: [{ startOffset: start, endOffset: code.indexOf("\n  }", start) + 4, count }] },
  ] });
  const executed = (report: CoverageMapData) => {
    const file = report[probe];
    return file.s[Object.entries(file.statementMap).find(([, loc]) => loc.start.line === 3)![0]];
  };
  // Reload deltas can name a script id that the debugger never announced.
  expect(executed(await convertBrowserCoverage([sample("1", 1, code), sample("2", 2)], process.cwd(), new Set([probe])))).toBe(3);
  await expect(convertBrowserCoverage([sample("3", 1), sample("1", 1, code), sample("2", 1, `${code}\n`)], process.cwd(), new Set([probe])))
    .rejects.toThrow("Missing browser script source");
  await expect(convertBrowserCoverage([sample("2", 1), sample("1", 1, "x")], process.cwd(), new Set([probe])))
    .rejects.toThrow("Incompatible browser script source");
});

it("fails teardown for an unmapped extensionless first-party script", async () => {
  const page = await harness.newPage();
  await page.goto(`${harness.origin}/opener`);
  await page.addScriptTag({ url: `${harness.origin}/unmapped` });
  await expect(page.context().close()).rejects.toThrow("Unmapped browser script");
});

it("allows coverage reporting to outlive the browser action deadline", async () => {
  const page = await harness.newPage();
  await page.goto(`${harness.origin}/opener`);
  // The report callback runs after protocol cleanup and physical context close.
  // Advance Node time there to simulate slow reporting without a real delay.
  onTestFinished(() => {
    vi.useRealTimers();
    advanceReportingClock = false;
    expect(slowReportReached).toBe(true);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  advanceReportingClock = true;
});

// it.fails also swallows hook failures: assert OUTSIDE that test's lifecycle.
afterAll(() => {
  if (!failureFixtureStarted) return;
  expect(deliberateFailureReached).toBe(true);
  expect(failureReport).toBeDefined();
  expect(Object.values(failureReport!["src/commentor/commentor.ts"].s).some(count => count > 0)).toBe(true);
});

it.fails("flushes coverage when the test body fails", async () => {
  failureFixtureStarted = true;
  captureFailure = true;
  onTestFinished(() => { captureFailure = false; });
  const page = await harness.newPage();
  await page.goto(`${harness.origin}/frame`);
  await expect.poll(() => page.evaluate("globalThis.coverageProof")).toBe("executed browser branch");
  deliberateFailureReached = true;
  throw new Error("Deliberate fixture failure before page/context close");
});
