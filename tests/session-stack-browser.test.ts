import rateLimiterTest from "./convex-rate-limiter";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, get, request as httpRequest } from "node:http";
import { once } from "node:events";
import { getRequestListener } from "@hono/node-server";
import { convexTest } from "convex-test";
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { components } from "../convex/_generated/api";
import { browserStep, createBrowserHarness } from "./helpers/browser";
import { subprocessArgs, subprocessEnv } from "./helpers/subprocess-coverage";

// Run the actual local server entry point, including the auth proxy,
// session middleware and all routes. Only remote services are local substitutes:
// Convex HTTP actions/component adapter run in convex-test.
const harness = createBrowserHarness();
let server: ChildProcess | undefined;
const password = "local-stack-fixture-password-only";
const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
rateLimiterTest.register(backend);
backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));

beforeAll(async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing local server port");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const listener = getRequestListener(async request => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mock-convex/")) {
      return backend.fetch(url.pathname.slice("/mock-convex".length) + url.search, {
        method: request.method, headers: request.headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }),
      });
    }
    return new Response(null, { status: 404 });
  });
  await harness.start((request, response) => {
    if (request.url?.startsWith("/mock-")) {
      void listener(request, response).catch(error => response.destroy(error as Error));
      return;
    }
    const proxy = httpRequest({ hostname: "127.0.0.1", port, path: request.url, method: request.method, headers: request.headers }, upstream => {
      response.writeHead(upstream.statusCode!, upstream.headers);
      upstream.pipe(response);
    });
    proxy.on("error", error => response.destroy(error));
    request.pipe(proxy);
  });
  vi.stubEnv("SITE_URL", harness.origin);
  const now = Date.now();
  const user = await backend.mutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
    name: "Stack Reader", email: "stack@example.test", emailVerified: true, createdAt: now, updatedAt: now,
  } } });
  await backend.mutation(components.betterAuth.adapter.create, { input: { model: "account", data: {
    userId: user._id, accountId: user._id, providerId: "credential", password: await hashPassword(password), createdAt: now, updatedAt: now,
  } } });
  server = spawn(process.execPath, [...subprocessArgs(), "--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(), stdio: "ignore", env: subprocessEnv({
      ...process.env, PORT: String(port), LOG_LEVEL: "silent", CONVEX_SITE_URL: `${harness.origin}/mock-convex`,
    }),
  });
  await vi.waitFor(async () => {
    expect(await new Promise<number>(resolve => {
    const probe = get(`http://127.0.0.1:${port}/health`, response => { response.resume(); resolve(response.statusCode ?? 0); });
    probe.on("error", () => resolve(0));
    })).toBe(200);
  // Starting the server takes seconds on a loaded runner, longer under coverage.
  }, { timeout: 60_000, interval: 100 });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await browserStep("stop local server", () => stopped);
  }
});

// Every request crosses the real server process and the coverage-instrumented
// convex-test backend in this worker. On a 2-vCPU runner that serial chain is
// several times slower than the 10s harness step; these budgets only bound hangs.
const stackStep = 30_000;
it("signs in to the home, browses the account and writes through the real local server without a 503", { timeout: 120_000 }, async () => {
  const page = await harness.newPage();
  page.setDefaultTimeout(stackStep);
  page.setDefaultNavigationTimeout(stackStep);
  const failures: string[] = [];
  page.on("response", response => {
    if (response.status() >= 500) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto(`${harness.origin}/sign-in`);
  await page.locator("#email").fill("stack@example.test");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The default return is the root, which sends a signed-in reader to their home.
  await page.waitForURL(`${harness.origin}/home`);
  await expect.poll(() => page.locator("h1").textContent(), { timeout: stackStep }).toBe("Welcome, Stack Reader");
  const security = await page.goto(`${harness.origin}/account/security`);
  expect(security?.status()).toBe(200);
  await expect.poll(() => page.locator("h1").textContent(), { timeout: stackStep }).toBe("Sign-in methods");
  // A cookie-authenticated JSON write from Chromium (it supplies Origin) crosses Node to Convex.
  const renamed = await page.evaluate(async () => (await fetch("/api/auth/update-user", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Stack Renamed" }),
  })).status);
  expect(renamed).toBe(200);
  await page.goto(`${harness.origin}/home`);
  await expect.poll(() => page.locator("h1").textContent(), { timeout: stackStep }).toBe("Welcome, Stack Renamed");
  expect(failures).toEqual([]);
  const sessions = await backend.query(components.betterAuth.adapter.findMany, { model: "session", paginationOpts: { cursor: null, numItems: 10 } });
  expect(sessions.page).toHaveLength(1);
  expect(typeof sessions.page[0].expiresAt).toBe("number");
});
