import { managementPagesSource } from "../scripts/management-pages-source";
import { buildBrowserBundle } from "./helpers/browser";
import { commitWithProof } from "./helpers/storage-proof";
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
import { components, internal } from "../convex/_generated/api";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";

// Run the actual local server entry point, including the auth proxy,
// session middleware and all routes. Only remote services are local substitutes:
// Convex HTTP actions/component adapter run in convex-test; S3 serves two objects.
const harness = createBrowserHarness();
let server: ChildProcess | undefined;
let organizationId: string, projectId: string;
const password = "local-stack-fixture-password-only";
const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
rateLimiterTest.register(backend);
backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
const objects = new Map<string, string>();

beforeAll(async () => {
  const assets = new Map<string, string>();
  for (const [path, entry] of [
    ["/private-viewer.js", "src/viewer/entry.ts"],
    ["/lazy-tree.js", "src/lazy-tree/lazy-tree.ts"],
    ["/commentor.js", "src/commentor/commentor.ts"],
    ["/commentor-parent.js", "src/commentor/parent-entry.ts"],
    ["/management-query.js", "src/management-query/browser.ts"],
    ["/select.js", "src/ui/select-browser.ts"],
  ]) {
    assets.set(path, await bundleBrowserAsset(entry));
  }
  assets.set("/management-pages.js", (await buildBrowserBundle({ stdin: { contents: managementPagesSource(), sourcefile: "tests/fixtures/generated-management-pages.js", resolveDir: process.cwd() } })).outputFiles[0].text);
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
    const body = objects.get(decodeURIComponent(url.pathname));
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
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
  }, assets);
  vi.stubEnv("SITE_URL", harness.origin);
  const now = Date.now();
  const user = await backend.mutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
    name: "Stack Reader", email: "stack@example.test", emailVerified: true, createdAt: now, updatedAt: now,
  } } });
  await backend.mutation(components.betterAuth.adapter.create, { input: { model: "account", data: {
    userId: user._id, accountId: user._id, providerId: "credential", password: await hashPassword(password), createdAt: now, updatedAt: now,
  } } });
  const organization = await backend.mutation(components.betterAuth.adapter.create, { input: { model: "organization", data: {
    name: "Stack Organization", slug: "stack-org", createdAt: now,
  } } });
  organizationId = organization._id;
  await backend.mutation(components.betterAuth.adapter.create, { input: { model: "member", data: {
    organizationId, userId: user._id, role: "owner", createdAt: now,
  } } });
  const project = await backend.mutation(internal.projects.createInternal, { organizationId, name: "Stack Docs", slug: "stack-docs", actorId: user._id });
  projectId = project!._id;
  const deployment = await backend.mutation(internal.deployments.startInternal, {
    organizationId, projectId, actorId: user._id, manifestSha256: "a".repeat(64), fileCount: 1, byteCount: 100, provenance: { source: { kind: "local" }, execution: { kind: "local" }, cliVersion: "test", manifestSha256: "a".repeat(64) },
  });
  await commitWithProof(backend, { organizationId, projectId, deploymentId: deployment.deploymentId, actorId: user._id });
  const document = "<!doctype html><html><head><title>Stack guide</title></head><body><h1>Local stack document loaded</h1></body></html>";
  objects.set(`/mock-storage/docs/${deployment.manifestKey}`, JSON.stringify({ version: 1, files: [{ path: "index.html", contentType: "text/html", sha256: "b".repeat(64), size: document.length }] }));
  objects.set(`/mock-storage/docs/${deployment.objectRoot}/files/index.html`, document);
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(), stdio: "ignore", env: {
      ...process.env, PORT: String(port), LOG_LEVEL: "silent", CONVEX_SITE_URL: `${harness.origin}/mock-convex`,
      MINIO_ENDPOINT: `${harness.origin}/mock-storage`, MINIO_BUCKET: "docs",
    },
  });
  await vi.waitFor(async () => {
    expect(await new Promise<number>(resolve => {
    const probe = get(`http://127.0.0.1:${port}/health`, response => { response.resume(); resolve(response.statusCode ?? 0); });
    probe.on("error", () => resolve(0));
    })).toBe(200);
  }, { timeout: 10_000, interval: 100 });
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
it("signs in and browses management and docs without a 503 on the real local server", { timeout: 120_000 }, async () => {
  const page = await harness.newPage();
  page.setDefaultTimeout(stackStep);
  page.setDefaultNavigationTimeout(stackStep);
  // convex-test provides HTTP actions, not the realtime WebSocket protocol.
  // Keep comment subscriptions offline; auth/session HTTP remains real.
  await page.routeWebSocket(/.*/, socket => socket.close());
  const failures: string[] = [];
  page.on("response", response => {
    if (response.status() >= 500) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.route(url => url.hostname === "cdn.tailwindcss.com", route => route.fulfill({ contentType: "text/javascript; charset=utf-8", body: "" }));
  const orgPath = `/organizations/${organizationId}`;
  await page.goto(`${harness.origin}/sign-in?returnTo=${encodeURIComponent(orgPath)}`);
  await page.locator("#email").fill("stack@example.test");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${harness.origin}${orgPath}`);
  await expect.poll(() => page.locator("body").textContent(), { timeout: stackStep }).toContain("Stack Organization");
  for (const path of [orgPath + "/projects", orgPath + "/people", orgPath + `/projects/${projectId}`]) {
    const response = await page.goto(harness.origin + path);
    expect(response?.status()).toBe(200);
    await expect.poll(() => page.locator("body").textContent(), { timeout: stackStep }).toContain("Stack Organization");
  }
  // Exercise the actual management transport against Node -> Convex. Chromium
  // supplies Origin and the shared transport supplies JSON for every mutation.
  const writes = await page.evaluate(async ({ organizationId, projectId }) => {
    const ui = (window as unknown as { RendroUI: { request(path: string, options: object): Promise<Record<string, unknown>> } }).RendroUI;
    const post = (path: string, body: object) => ui.request(path, { method: "POST", body: JSON.stringify(body) });
    const scope = { organizationId, projectId };
    const project = await post("/api/rendro/projects", { organizationId, name: "Browser created", slug: "browser-created" });
    const credential = await post("/api/rendro/credentials", { ...scope, name: "Browser key", scopes: ["docs:read"] });
    await post("/api/rendro/credentials/revoke", { organizationId, keyId: (credential.credential as { keyId: string }).keyId });
    const share = await post("/api/rendro/shares", { ...scope, documentPath: "index.html", expiresInSeconds: 600 });
    await post("/api/rendro/shares/revoke", { organizationId, grantId: (share.grant as { _id: string })._id });
    const publication = await post("/api/rendro/publications", { ...scope, slug: "browser-publication", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" });
    await post("/api/rendro/publications/remove", { ...scope, publicationId: (publication.publication as { _id: string })._id });
    return { createdProject: Boolean(project.project), createdKey: Boolean(credential.rawKey), createdShare: Boolean(share.token), createdPublication: Boolean(publication.publication) };
  }, { organizationId, projectId });
  expect(writes).toEqual({ createdProject: true, createdKey: true, createdShare: true, createdPublication: true });
  const docs = `${orgPath}/projects/${projectId}/docs`;
  expect((await page.goto(harness.origin + docs))?.status()).toBe(200);
  // The viewer iframe exercises the canonical route and a fresh persisted
  // authorization read after the top-level session lookup.
  await expect.poll(async () => Promise.all(page.frames().map(frame => frame.locator("body").textContent())).then(texts => texts.join(" ")), { timeout: stackStep }).toContain("Local stack document loaded");
  expect(failures).toEqual([]);
  const sessions = await backend.query(components.betterAuth.adapter.findMany, { model: "session", paginationOpts: { cursor: null, numItems: 10 } });
  expect(sessions.page).toHaveLength(1);
  expect(typeof sessions.page[0].expiresAt).toBe("number");
});
