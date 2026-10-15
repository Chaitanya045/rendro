import { test as base, expect } from "@playwright/test";

type Checks = { networkGuard: void; cspViolations: string[] };

export const test = base.extend<Checks>({
  // Playwright requires destructuring even when an option has no dependencies.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const origin = process.env.RENDRO_E2E_ORIGIN;
    if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("Missing local Worker origin");
    await use(origin);
  },
  networkGuard: [async ({ context, baseURL }, use) => {
    const unexpectedOrigins = new Set<string>();
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === baseURL) return route.continue();
      // Fulfilled locally: no request reaches the font/CDN hosts.
      if (url.origin === "https://fonts.googleapis.com") return route.fulfill({ contentType: "text/css", body: "" });
      if (url.origin === "https://cdn.tailwindcss.com") return route.fulfill({ contentType: "text/javascript", body: "window.tailwind={}" });
      unexpectedOrigins.add(url.origin);
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, socket => {
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
