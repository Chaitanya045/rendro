import type { CoverageMapData } from "istanbul-lib-coverage";
import { buildBrowserBundle, collectBrowserContext } from "./browser-coverage";
export { buildBrowserBundle } from "./browser-coverage";
import { existsSync } from "node:fs";
import { createServer, get, type RequestListener, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Frame, type Page } from "playwright";
import { afterAll, afterEach, expect } from "vitest";

// Shorter than the 30s test budget so failures identify the stalled operation.
export const browserStepTimeout = 10_000;

export async function browserStep<T>(label: string, action: () => Promise<T>, timeout = browserStepTimeout): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } catch (cause) {
    throw new Error(`Browser step: ${label}`, { cause });
  } finally {
    clearTimeout(timer);
  }
}

/** Build from source in memory; browser tests run before build:assets in CI. */
export async function bundleBrowserAsset(entry: string): Promise<string> {
  return browserStep(`bundle ${entry}`, async () =>
    (await buildBrowserBundle({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser" })).outputFiles[0].text);
}

/** Call after hydration or an interaction, before auditing rendered styles. */
export async function waitForSettled(page: Page | Frame) {
  await browserStep("wait for fonts, animations and transitions to settle", () => page.evaluate(async () => {
    await document.fonts.ready;
    for (;;) {
      // Let frame-scheduled entrance classes and style changes start their animations.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const animations = document.getAnimations().filter(animation =>
        animation.playState !== "finished" && animation.playState !== "idle");
      if (!animations.length) return;
      // Cancellation also settles an animation; recheck for any replacement motion.
      await Promise.allSettled(animations.map(animation => animation.finished));
    }
  }));
}

/** Call once at file scope. Owns one browser/server and a fresh context per page. */
export function createBrowserHarness(harnessOptions: { coverage?: boolean; chromiumArgs?: string[]; onCoverage?: (report: CoverageMapData) => void } = {}) {
  const collectors = new Map<BrowserContext, Awaited<ReturnType<typeof collectBrowserContext>>>();
  let browser: Browser | undefined;
  let server: Server | undefined;
  let origin = "";
  const contexts = new Set<BrowserContext>();
  const unexpectedOrigins = new Set<string>();

  async function closeContexts() {
    const results = await Promise.allSettled([...contexts].map(context =>
      browserStep("close browser context", () => context.close())));
    contexts.clear();
    collectors.clear();
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason as unknown);
    if (errors.length) throw new AggregateError(errors, "Browser context teardown failed");
  }

  afterEach(async () => {
    try {
      await closeContexts();
      expect([...unexpectedOrigins], "Unexpected external browser requests (blocked)").toEqual([]);
    } finally {
      unexpectedOrigins.clear();
    }
  });

  afterAll(async () => {
    // Close sockets even if a test failed with a deliberately held response.
    const results = await Promise.allSettled([
      browserStep("close Chromium", async () => { await browser?.close(); }),
      browserStep("close fixture server", async () => {
        if (!server) return;
        const closing = new Promise<void>((resolve, reject) => {
          server!.close(error => error ? reject(error) : resolve());
        });
        server.closeAllConnections();
        await closing;
      }),
    ]);
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason as unknown);
    if (errors.length) throw new AggregateError(errors, "Browser harness teardown failed");
  });

  return {
    get origin() { return origin; },
    coverageTargets(page: Page) { return collectors.get(page.context())!.targets(); },
    coverageSnapshot(page: Page, include?: Set<string>) {
      const collector = collectors.get(page.context());
      if (!collector) throw new Error("Browser coverage is not enabled");
      return collector.snapshot(include);
    },
    async start(handler: RequestListener, assets: ReadonlyMap<string, string> = new Map()) {
      if (server) throw new Error("Browser harness already started");
      server = createServer((request, response) => {
        if (request.url === "/__browser_health") {
          response.writeHead(200, { "Content-Type": "text/plain" });
          response.end("browser-fixture-ready");
        } else {
          const asset = assets.get(new URL(request.url!, "http://localhost").pathname);
          if (asset !== undefined) {
            response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
            response.end(asset);
          } else handler(request, response);
        }
      });
      await browserStep("listen on an ephemeral loopback port", () => new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          server!.off("error", reject);
          resolve();
        });
      }), 5_000);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      origin = `http://127.0.0.1:${address.port}`;
      // Node HTTP deliberately bypasses tests/setup.ts's mocked global fetch.
      await browserStep("fixture HTTP health check", () => new Promise<void>((resolve, reject) => {
        const request = get(`${origin}/__browser_health`, response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("error", reject);
          response.on("end", () => {
            if (response.statusCode === 200 && body === "browser-fixture-ready") resolve();
            else reject(new Error(`Unexpected fixture health response: ${response.statusCode}`));
          });
        });
        request.on("error", reject);
        request.setTimeout(4_000, () => request.destroy(new Error("Fixture health request timed out")));
      }), 5_000);
      browser = await browserStep("launch Chromium", () => chromium.launch({
        timeout: 45_000,
        args: harnessOptions.chromiumArgs,
        // CI uses the pinned Playwright build; local hosts can opt into system Chromium.
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ?? (!process.env.CI && existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      }), 46_000);
    },
    async newPage(options: BrowserContextOptions = {}) {
      if (!browser) throw new Error("Start the browser harness before creating a page");
      const context = await browserStep("create browser context", () => browser!.newContext({
        ...options, serviceWorkers: "block",
      }));
      contexts.add(context);
      context.setDefaultTimeout(browserStepTimeout);
      context.setDefaultNavigationTimeout(browserStepTimeout);
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ["data:", "blob:", "about:"].includes(url.protocol)) return route.continue();
        unexpectedOrigins.add(url.origin);
        return route.abort("blockedbyclient");
      });
      await context.routeWebSocket(/.*/, socket => {
        unexpectedOrigins.add(new URL(socket.url()).origin);
        return socket.close();
      });
      const collector = harnessOptions.coverage || process.env.RENDRO_BROWSER_COVERAGE_DIR
        ? await collectBrowserContext(context, expect.getState().testPath!, origin, harnessOptions.onCoverage) : undefined;
      if (collector) collectors.set(context, collector);
      const page = await browserStep("create browser page", () => context.newPage());
      await collector?.ready(page);
      return page;
    },
  };
}
