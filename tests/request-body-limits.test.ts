import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono, type Context } from "hono";
import { boundedRequest, BodyTooLargeError, readBoundedBody, readExactBody } from "../src/bounded-body";
import { bodyAdmission } from "../src/middleware/body-admission";
import { MAX_FILE_BYTES, MAX_HTTP_BODY_BYTES, MAX_MANIFEST_BODY_BYTES } from "../shared/deployment-limits";
import { authClientIpHeaders, registerAuthClientIp } from "../src/auth-client-ip";
import { AUTH_CLIENT_IP_HEADER, verifiedAuthRequest } from "../shared/auth-client-ip";
import { httpAction } from "../convex/httpErrors";
import router from "../convex/http";

function request(size: number, length?: string, method = "POST", path = "/api/rendro/projects") {
  const cancel = vi.fn();
  let remaining = size;
  const stream = new ReadableStream<Uint8Array>({ pull(c) {
    if (!remaining) { c.close(); return; }
    const chunk = Math.min(remaining, 8192); remaining -= chunk;
    c.enqueue(new Uint8Array(chunk).fill(32));
  }, cancel }, { highWaterMark: 0 });
  const headers: Record<string, string> = { "content-type": "application/json", origin: process.env.SITE_URL! };
  if (length !== undefined) headers["content-length"] = length;
  return { cancel, req: new Request("https://rendro.test" + path, { method, headers, body: stream, duplex: "half" } as RequestInit) };
}
afterEach(() => vi.restoreAllMocks());

describe("streaming request caps", () => {
  it.each([MAX_HTTP_BODY_BYTES - 1, MAX_HTTP_BODY_BYTES])("accepts %s actual bytes with absent or dishonest smaller Content-Length", async size => {
    for (const length of [undefined, "1", String(size)]) {
      expect((await readBoundedBody(request(size, length).req)).byteLength).toBe(size);
    }
  });
  it.each([undefined, "1", String(MAX_HTTP_BODY_BYTES + 1)])("returns 413 and cancels overflow with length %s", async length => {
    const { req, cancel } = request(MAX_HTTP_BODY_BYTES + 1, length);
    const error = await readBoundedBody(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BodyTooLargeError);
    if (!(error instanceof BodyTooLargeError)) throw new Error("Expected bounded-body rejection");
    expect(error.response().status).toBe(413);
    expect(await error.response().json()).toEqual({ error: `Request body exceeds the ${MAX_HTTP_BODY_BYTES}-byte limit` });
    expect(cancel).toHaveBeenCalledOnce();
    expect(req.body!.locked).toBe(false);
  });
  it("rejects excessive/malformed headers before reading and tolerates cancellation failure", async () => {
    for (const length of ["-1", "1.5", "bad", String(Number.MAX_SAFE_INTEGER), String(MAX_HTTP_BODY_BYTES + 1)]) {
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull, cancel: () => Promise.reject(new Error("closed")) }, { highWaterMark: 0 });
      const req = new Request("https://rendro.test", { method: "POST", headers: { "content-length": length }, body, duplex: "half" } as RequestInit);
      await expect(readBoundedBody(req)).rejects.toBeInstanceOf(BodyTooLargeError);
      expect(pull).not.toHaveBeenCalled();
    }
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2)); }, cancel: () => Promise.reject(new Error("closed")) });
    await expect(readBoundedBody(new Request("https://rendro.test", { method: "POST", body, duplex: "half" } as RequestInit), 1)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it("handles missing bodies, safe reads, empty chunks and stream failures", async () => {
    const get = new Request("https://rendro.test");
    expect(await boundedRequest(get)).toBe(get);
    const head = new Request(get, { method: "HEAD" });
    expect(await boundedRequest(head)).toBe(head);
    expect(await readBoundedBody(get)).toEqual(new Uint8Array());
    expect(await (await boundedRequest(new Request(get, { method: "POST" }))).text()).toBe("");
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(undefined); c.close(); } });
    expect(await readBoundedBody(new Request(get, { method: "POST", body, duplex: "half" } as RequestInit))).toEqual(new Uint8Array());
    const broken = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("broken")); } });
    await expect(readBoundedBody(new Request(get, { method: "POST", body: broken, duplex: "half" } as RequestInit))).rejects.toThrow("broken");
    expect(broken.locked).toBe(false);
  });
  it("caps uploads independently of client manifest sizes", async () => {
    for (const size of [MAX_FILE_BYTES - 1, MAX_FILE_BYTES]) expect((await readExactBody(request(size).req.body, size))!.byteLength).toBe(size);
    const { req } = request(MAX_FILE_BYTES + 1);
    expect(await readExactBody(req.body, MAX_FILE_BYTES + 1)).toBeNull();
    expect(req.bodyUsed).toBe(false);
  });
});

it("admits all Worker JSON/forms before parsing, preserves trusted ingress, and gives start its larger cap", async () => {
  const app = new Hono();
  app.use("*", bodyAdmission);
  app.all("*", async c => {
    const headers = await authClientIpHeaders(c.req.raw, "https://backend.test/ip", "GET");
    const verified = await verifiedAuthRequest(new Request("https://backend.test/ip", { headers }), process.env.CONVEX_INTERNAL_SECRET);
    return c.json({ bytes: (await c.req.arrayBuffer()).byteLength, ip: verified.headers.get(AUTH_CLIENT_IP_HEADER) });
  });
  const source = request(MAX_HTTP_BODY_BYTES, "1").req;
  registerAuthClientIp(source, "192.0.2.1");
  expect(await (await app.request(source)).json()).toEqual({ bytes: MAX_HTTP_BODY_BYTES, ip: "192.0.2.1" });
  for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-out", "/api/rendro/projects", "/api/rendro/migration/project", "/api/rendro/deployments/id/copy", "/api/rendro/deployments/fail", "/api/publications"]) {
    for (const length of [undefined, "1", String(MAX_HTTP_BODY_BYTES + 1)]) {
      const { req } = request(MAX_HTTP_BODY_BYTES + 1, length, "POST", path);
      req.headers.set("content-type", "application/x-www-form-urlencoded");
      expect((await app.request(req)).status).toBe(413);
    }
  }
  for (const size of [MAX_MANIFEST_BODY_BYTES - 1, MAX_MANIFEST_BODY_BYTES, MAX_MANIFEST_BODY_BYTES + 1]) {
    expect((await app.request(request(size, undefined, "POST", "/api/rendro/deployments/start").req)).status).toBe(size > MAX_MANIFEST_BODY_BYTES ? 413 : 200);
  }
  expect((await app.request(request(0, String(MAX_FILE_BYTES + 1), "PUT", "/api/rendro/deployments/id/files/index.html").req)).status).toBe(413);
  expect((await app.request(request(1, undefined, "PUT", "/api/rendro/deployments/id/files/index.html").req)).status).toBe(200);
});

it("bounds every registered Convex write, including Better Auth and operator actions, before invoking handlers", async () => {
  for (const [path, method, action] of router.getRoutes()) {
    if (method !== "POST") continue;
    const { req } = request(MAX_HTTP_BODY_BYTES + 1, "1", "POST", path.replace("*", "sign-in/email"));
    const response = await (action as unknown as { _handler: (ctx: unknown, req: Request) => Promise<Response> })._handler({}, req);
    expect(response.status, path).toBe(413);
    expect(await response.json(), path).toHaveProperty("error");
  }
  const handler = vi.fn(async (_ctx, req: Request) => Response.json({ bytes: (await req.text()).length }));
  const action = httpAction(handler);
  const invoke = (action as unknown as { _handler: (ctx: unknown, req: Request) => Promise<Response> })._handler;
  for (const size of [MAX_HTTP_BODY_BYTES - 1, MAX_HTTP_BODY_BYTES]) expect(await (await invoke({}, request(size).req)).json()).toEqual({ bytes: size });
  expect(handler).toHaveBeenCalledTimes(2);
});

it("rejects exact-body overflow even when transport cancellation fails", async () => {
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2)); }, cancel: () => Promise.reject(new Error("closed")) });
  expect(await readExactBody(body, 1)).toBeNull();
});

it("propagates transport failures through Worker body admission without invoking expensive work", async () => {
  const app = new Hono();
  const work = vi.fn((c: Context) => c.text("parsed"));
  const failed = vi.fn((_error: Error, c: Context) => c.json({ error: "Transport failed" }, 500));
  app.onError(failed);
  app.use("*", bodyAdmission);
  app.put("*", work);
  expect((await app.request(request(MAX_HTTP_BODY_BYTES + 1, undefined, "PUT", "/api/other").req)).status).toBe(413);
  const body = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("transport")); } });
  const response = await app.request(new Request("https://rendro.test/api/other", { method: "PUT", body, duplex: "half" } as RequestInit));
  expect(response.status).toBe(500);
  expect(failed.mock.calls[0][0]).toHaveProperty("message", "transport");
  expect(work).not.toHaveBeenCalled();
});

it("caps standalone auth/management proxy bodies before forwarding and propagates transport failures", async () => {
  const { proxyConvexRequest } = await import("../src/auth-proxy");
  const outgoing = vi.spyOn(globalThis, "fetch");
  outgoing.mockClear();
  expect((await proxyConvexRequest(request(MAX_HTTP_BODY_BYTES + 1).req)).status).toBe(413);
  const body = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("transport")); } });
  await expect(proxyConvexRequest(new Request("https://rendro.test/api/rendro/projects", { method: "POST", body, duplex: "half" } as RequestInit))).rejects.toThrow("transport");
  expect(outgoing).not.toHaveBeenCalled();
});
