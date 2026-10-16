import type { CoverageMapData } from "istanbul-lib-coverage";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";
import { convertBrowserCoverage } from "./helpers/browser-coverage";

let failureReport: CoverageMapData | undefined;
let captureFailure = false;
let failureFixtureStarted = false;
let deliberateFailureReached = false;
const harness = createBrowserHarness({ coverage: true, chromiumArgs: ["--site-per-process", "--enable-features=IsolateSandboxedIframes"], onCoverage: report => { if (captureFailure) failureReport = report; } });
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
  await frame.goto(`${harness.origin}/__browser_health`);
  const result = await harness.coverageSnapshot(page, included);
  expect(Object.keys(result).sort()).toEqual([...included].sort());
  const file = result[probe];
  expect(file).toBeDefined();
  const countsAt = (line: number) => Object.entries(file.statementMap).filter(([, loc]) => loc.start.line === line).map(([id]) => file.s[id]);
  expect(countsAt(3)).toEqual([2]);
  expect(countsAt(5)).toEqual([0]);
  expect(Object.values(file.b)).toContainEqual([2, 0]);
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
  expect(popupFile.s[executed[0]]).toBe(2);
  expect(result["src/commentor/commentor.ts"]).toBeUndefined();
});

it("rejects unmapped first-party scripts", async () => {
  await expect(convertBrowserCoverage([{ scriptId: "1", url: `${harness.origin}/missing.js`, source: "window.unmapped = true", functions: [] }]))
    .rejects.toThrow("Unmapped browser script");
  await expect(convertBrowserCoverage([{ scriptId: "2", url: `${harness.origin}/missing.js`, functions: [] }]))
    .rejects.toThrow("Missing browser script source");
});

it("fails teardown for an unmapped extensionless first-party script", async () => {
  const page = await harness.newPage();
  await page.goto(`${harness.origin}/opener`);
  await page.addScriptTag({ url: `${harness.origin}/unmapped` });
  await expect(page.context().close()).rejects.toThrow("Unmapped browser script");
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
