import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { localHttp } from "./backend";
import type { Seed } from "./seed";

type Checks = { networkGuard: void; cspViolations: string[]; seed: Seed };

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
    // Distinct local ingress addresses keep each engine's real auth limits independent.
    await context.setExtraHTTPHeaders({ "CF-Connecting-IP": `192.0.2.${10 + ["chromium", "firefox", "webkit"].indexOf(info.project.name)}` });
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
      // Fulfilled locally: no request reaches the font/CDN hosts.
      if (url.origin === "https://fonts.googleapis.com") return route.fulfill({ contentType: "text/css", body: "" });
      if (url.origin === "https://cdn.tailwindcss.com") return route.fulfill({ contentType: "text/javascript", body: "window.tailwind={}" });
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
    try { await use(); } finally {
      expect([...unexpectedOrigins], "Unexpected external browser requests (blocked)").toEqual([]);
    }
  }, { auto: true }],
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

export { expect };
