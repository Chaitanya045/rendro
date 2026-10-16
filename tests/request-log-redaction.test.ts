import { Hono, Context } from "hono";
import type { LoggerOptions } from "pino";
import type * as Pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({ lines: [] as string[], options: [] as LoggerOptions[] }));
vi.mock("pino", async importOriginal => {
  const actual = await importOriginal<typeof Pino>();
  return { ...actual, default: (options: LoggerOptions) => {
    capture.options.push(options);
    return actual.pino({ ...options, transport: undefined }, { write: line => { capture.lines.push(line); } });
  } };
});
vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => async (c: Context, next: () => Promise<void>) => {
  if (c.req.query("missing")) return next();
  return c.body("static asset");
} }));
import worker from "../src/worker";
import { app as node } from "../src/index";
import { logger } from "../src/logger";
import { requestLogPath } from "../src/request-log";
import { createShareToken } from "../src/share-links";
import * as minio from "../src/minio";
import { mockSecurityBackend, docsBase, testUser } from "./fixtures/security-headers";

const secret = "SYNTHETIC_PRIVATE_CAPABILITY_88";
const encoded = [...secret].map(char => `%${char.charCodeAt(0).toString(16)}`).join("");
const query = `?token=${secret}&verification_token=${encoded}&invitationId=${secret}&resetToken=${secret}&code=${secret}`;
const faulty = () => Object.assign(new TypeError(`https://example.test/share/${secret}${query}`), {
  name: secret, stack: secret, cause: { authorization: `Bearer ${secret}` }, url: `/s/${secret}`,
});
const records = () => capture.lines.map(line => JSON.parse(line) as Record<string, unknown>);
function noSecrets() {
  expect(capture.lines.length).toBeGreaterThan(0);
  const output = capture.lines.join("");
  for (const marker of [secret, encoded, encodeURIComponent(encoded)]) expect(output).not.toContain(marker);
}
node.get("/synthetic-error/:token", () => { throw faulty(); });
const registered = worker.routes.filter(route => route.method !== "ALL");
function concrete(route: string, token: string) {
  return route.replace(/:[\w]+(?:\{[^}]+\})?/g, token).replaceAll("*", token);
}
beforeEach(() => { mockSecurityBackend(); capture.lines.length = 0; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("request logs derived from all Worker route registrations", () => {
  it.each(registered)("logs only templates for $method $path, including encoded and malformed paths", async ({ method, path: route }) => {
    for (const token of [secret, encoded, encodeURIComponent(encoded), `${secret}%ZZ`, `${secret}%2Fextra`, `${secret}/extra`]) {
      const response = await worker.request(`https://test${concrete(route, token)}${query}`, {
        method, headers: { authorization: `Bearer ${secret}`, origin: "https://test", "content-type": "application/json" },
        ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify({ token: secret }) }),
      });
      expect(response.status).toBeGreaterThanOrEqual(200);
      const requests = records().filter(record => record.msg === "request");
      expect(requests.length).toBeGreaterThan(0);
      for (const record of requests) expect(worker.routes.map(route => route.path)).toContain(record.route);
      noSecrets();
      capture.lines.length = 0;
    }
  });
});

it("captures successful share/ticket responses and storage/proxy errors without capabilities", async () => {
  const share = createShareToken("example/index.html");
  for (const path of [`/share/${share}`, `/s/${secret}`, `/s/${secret}/files/index.html`]) {
    expect((await worker.request(`https://test${path}${query}`)).status).toBe(200);
  }
  const ticketResponse = await worker.request(`https://test${docsBase}/viewer-ticket?manifestKey=tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json`, { headers: { cookie: "better-auth.session_token=test-session" } });
  expect(ticketResponse.status).toBe(200);
  const ticket = await ticketResponse.json() as { prefix: string };
  // Obtain the actual ticket URL from canonical HTML, exercising the live route.
  const document = await worker.request(`https://test${docsBase}/files/index.html`, { headers: { cookie: "better-auth.session_token=test-session" } });
  const html = await document.text();
  const url = html.match(/<base data-rendro-viewer href="([^"]+)"/)![1];
  expect((await worker.request(`https://test${url}${query}`)).status).toBe(200);
  expect(capture.lines.join("")).not.toContain(share);
  expect(capture.lines.join("")).not.toContain(url);
  expect(ticket).toBeTruthy();
  noSecrets();

  vi.mocked(minio.getObjectStream).mockRejectedValue(faulty());
  expect((await worker.request(`https://test/share/${share}${query}`)).status).toBe(503);
  expect((await worker.request(`https://test/public/example/product/files/index.html${query}`)).status).toBe(503);
  const failure = await worker.request(`https://test/${secret}${query}`, {}, { ASSETS: { fetch: () => { throw faulty(); } } });
  expect(failure.status).toBe(500);
  vi.mocked(fetch).mockRejectedValue(faulty());
  expect((await worker.request(`https://test/api/auth/verify-email${query}`)).status).toBe(502);
  expect((await worker.request(`https://test/api/rendro/shares/public${query}`)).status).toBe(502);
  noSecrets();
});

it("uses the same safe logging for Node, including errors and unmatched methods", async () => {
  for (const path of [`/s/${secret}`, `/share/${secret}`, `/reset-password`, `/verify-email`, `/accept-invitation/${secret}`]) {
    await node.request(`https://test${path}${query}`, {}, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  }
  expect((await node.request(`https://test/synthetic-error/${secret}${query}`, {}, { incoming: { socket: {} } })).status).toBe(500);
  expect((await node.request(`https://test/${secret}${query}`, { method: "PATCH" }, { incoming: { socket: {} } })).status).toBe(404);
  noSecrets();
  for (const path of ["/favicon.ico", "/favicon.ico?missing=1"]) {
    await node.request(path, {}, { incoming: { socket: {} } });
  }
  const me = await node.request("/api/auth/me", {}, { incoming: { socket: {} } });
  expect(await me.json()).toEqual({ user: null });
  // The local endpoint also supports a user supplied by preceding middleware.
  const context = new Context(new Request("https://test/api/auth/me"));
  context.set("user", testUser);
  const handler = node.routes.find(route => route.path === "/api/auth/me")!.handler;
  const authenticated = await handler(context, async () => {});
  expect(await authenticated.json()).toMatchObject({ id: "user-a" });
});

it("returns an opaque label when no route is matched", async () => {
  const app = new Hono().notFound(c => c.text(requestLogPath(c)));
  expect(await (await app.request(`/${secret}${query}`)).text()).toBe("[unmatched]");
});

it("redacts credential fields recursively, child bindings and exception objects in actual Pino output", () => {
  const nested: Record<string, unknown> = { safe: 42, token: secret };
  nested.loop = nested;
  const fields = {
    Authorization: `Bearer ${secret}`, authorization: secret, Cookie: secret, "set-cookie": secret,
    password: secret, passwordHash: secret, newPassword: secret, rawKey: secret, api_key: secret,
    access_token: secret, refreshToken: secret, sessionToken: secret, viewerTicket: secret,
    invitationId: secret, verificationToken: secret, resetToken: secret, clientSecret: secret,
    url: `/s/${secret}${query}`, callbackURL: `/verify-email?token=${secret}`, requestPath: `/share/${secret}`, path: `/share/${secret}`, body: secret,
    err: faulty(), error: secret, errorType: secret, cause: faulty(), stack: secret,
    nested: [null, false, { deeper: { fields: { token: secret, authorization: secret, secret } } }],
    circular: nested, toJSON: () => ({ secret }),
  };
  logger.debug(fields, "structured fixture");
  logger.error(faulty(), "exception fixture");
  logger.error(faulty());
  logger.error({ err: faulty() });
  logger.info(null, "null fixture");
  logger.error({ error: new RangeError(secret), other: new Error(secret) }, "error categories");
  logger.error({ errorType: "TypeError" }, "safe type");
  logger.error({ error: null, err: 0 }, "empty errors");
  logger.error({ errorType: { toString: () => "TypeError", secret } }, "unsafe type");
  logger.child(fields).info({ token: secret }, "child fixture");
  noSecrets();
  expect(records()[0]).toMatchObject({ Authorization: "[redacted]", errorType: "Error", err: { category: "TypeError" }, circular: { safe: 42, token: "[redacted]", loop: "[redacted]" } });
  expect(records().find(record => record.msg === "error categories")).toMatchObject({ error: { category: "RangeError" }, other: { category: "Error" } });
});

it("configures redaction in both production and development logger modes", async () => {
  expect(capture.options[0].transport).toBeDefined();
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  const production = await import("../src/logger");
  production.logger.error({ token: secret, error: faulty() }, "production fixture");
  expect(capture.options.at(-1)?.transport).toBeUndefined();
  noSecrets();
});
