import type { BrowserContext } from "playwright";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { browserStep, createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
const previousContexts: BrowserContext[] = [];

beforeAll(async () => {
  await harness.start((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><title>Local fixture</title><p>Ready</p>');
  });
});

beforeEach(() => {
  for (const context of previousContexts) expect(context.pages(), "preceding test context closed").toEqual([]);
});

it.each([1, 2])("isolates storage and cleans up contexts across tests (round %s)", async () => {
  const first = await harness.newPage();
  previousContexts.push(first.context());
  await browserStep("load first context", () => first.goto(harness.origin));
  await first.evaluate(() => {
    document.cookie = "fixture=first";
    localStorage.setItem("fixture", "first");
  });
  const second = await harness.newPage();
  previousContexts.push(second.context());
  await browserStep("load isolated context", () => second.goto(harness.origin));
  expect(await second.evaluate(() => [document.cookie, localStorage.getItem("fixture")])).toEqual(["", null]);
  expect(await second.title()).toBe("Local fixture");
  const response = await browserStep("check fixture health from Chromium", () => second.goto(`${harness.origin}/__browser_health`));
  expect(response?.status()).toBe(200);
  expect(await response?.text()).toBe("browser-fixture-ready");
  // Intentionally leave both contexts open: the harness must own their cleanup.
});
