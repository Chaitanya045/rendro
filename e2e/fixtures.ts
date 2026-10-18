import { createHash } from "node:crypto";
import { test as base, expect, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { localHttp } from "./backend";
import type { Seed } from "./seed";

type Checks = { secondContext: BrowserContext; networkGuard: void; cspViolations: string[]; seed: Seed };

export const test = base.extend<Checks>({
  // Playwright requires destructuring even when an option has no dependencies.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const origin = process.env.RENDRO_E2E_ORIGIN;
    if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("Missing local Worker origin");
    await use(origin);
  },
  // eslint-disable-next-line no-empty-pattern
  seed: async ({}, use) => {
    const path = process.env.RENDRO_E2E_SEED;
    if (!path) throw new Error("Missing seed metadata");
    await use(JSON.parse(await readFile(path, "utf8")) as Seed);
  },
  networkGuard: [async ({ context, baseURL }, use, info) => {
    const unexpectedOrigins = await guardContext(context, baseURL, `${info.testId}-${info.retry}`);
    try { await use(); } finally {
      expect([...unexpectedOrigins], "Unexpected external browser requests (blocked)").toEqual([]);
    }
  }, { auto: true }],
  secondContext: async ({ browser, baseURL }, use, info) => {
    const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
    const unexpectedOrigins = await guardContext(context, baseURL, `${info.testId}-${info.retry}-second`);
    try { await use(context); } finally {
      await context.close();
      expect([...unexpectedOrigins], "Unexpected external secondary-context requests").toEqual([]);
    }
  },
  cspViolations: async ({ context, page }, use) => {
    const violations: string[] = [];
    await context.exposeBinding("recordCspViolation", (_source, value: string) => { violations.push(value); });
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", event => {
        const recorder = window as unknown as { recordCspViolation(value: string): Promise<void> };
        void recorder.recordCspViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
      });
    });
    page.on("console", message => {
      if (/content.security.policy|violates.*policy/i.test(message.text())) violations.push(message.text());
    });
    await use(violations);
  },
});

export async function guardContext(context: BrowserContext, baseURL: string | undefined, testId: string) {
  // Distinct ingress per test/context keeps real auth windows independent.
  const ip = createHash("sha256").update(testId).digest();
  await context.setExtraHTTPHeaders({ "CF-Connecting-IP": `198.18.${ip[0]}.${ip[1]}` });
  const unexpectedOrigins = new Set<string>();
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL || url.origin === process.env.RENDRO_E2E_CONVEX) return route.continue();
    if (url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth") {
      const result = await localHttp(`${process.env.RENDRO_E2E_MAIL}/authorize${url.search}`);
      if (result.status !== 200) throw new Error("Local OAuth authorization failed");
      const { location } = JSON.parse(result.body) as { location: string };
      // WebKit cannot fulfill an intercepted request with a 3xx response.
      // Model the provider's completion page, retaining a real browser callback navigation.
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Local OAuth fixture</title><script>location.replace(${JSON.stringify(location).replaceAll("<", "\\u003c")})</script>` });
    }
    // Fonts and viewer styles are self-hosted: any CDN request is unexpected and fails the test.
    unexpectedOrigins.add(url.origin);
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, socket => {
    if (new URL(socket.url()).origin === process.env.RENDRO_E2E_CONVEX?.replace("http:", "ws:")) {
      socket.connectToServer();
      return;
    }
    unexpectedOrigins.add(new URL(socket.url()).origin);
    return socket.close();
  });
  return unexpectedOrigins;
}

export { expect };
