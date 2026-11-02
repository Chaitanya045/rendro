import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { betterAuth } from "better-auth/minimal";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";
import { createAuthOptions } from "../convex/auth";
import { failure } from "../convex/httpErrors";
import { hasIllFormedText, IllFormedTextError, INVALID_TEXT_MESSAGE, jsonTextHasIllFormedText, requireWellFormedBody } from "../shared/text-input";
import rateLimiterTest from "./convex-rate-limiter";
import worker from "../src/worker";

const origin = "http://localhost:3000";
const transports = ["convex", "worker"] as const;
type Transport = typeof transports[number];
const lone = "a\ud800b";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture() {
  const t = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  t.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  rateLimiterTest.register(t);
  const context = await betterAuth(createAuthOptions({ runQuery: t.query, runMutation: t.mutation } as never)).$context;
  const user = await context.internalAdapter.createUser({ name: "owner", email: "owner@example.test", emailVerified: true });
  const { token } = await context.internalAdapter.createSession(user.id);
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64")}`)}`;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    return t.fetch(`${url.pathname}${url.search}`, init);
  }));
  // Raw text lets a test send an escape sequence no JSON.stringify call would produce.
  function call(transport: Transport, path: string, body?: unknown, raw?: string) {
    const headers: Record<string, string> = { origin, cookie };
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) headers["content-type"] = "application/json";
    const init = { method: payload === undefined ? "GET" : "POST", headers, ...(payload === undefined ? {} : { body: payload }) };
    return transport === "worker" ? worker.request(`${origin}${path}`, init) : t.fetch(path, init);
  }
  const name = async () => (await context.internalAdapter.findUserById(user.id))?.name;
  return { t, call, name };
}

describe("well-formed text helpers", () => {
  it("walks keys, nested arrays and objects without recursion", () => {
    expect(hasIllFormedText("fine 😀")).toBe(false);
    expect(hasIllFormedText(lone)).toBe(true);
    expect(hasIllFormedText(["ok", { deep: ["ok", { [lone]: 1 }] }])).toBe(true);
    expect(hasIllFormedText({ list: ["ok", [lone]] })).toBe(true);
    expect(hasIllFormedText({ ok: [1, true, null, undefined, { more: "text" }] })).toBe(false);
    expect(hasIllFormedText(Array.from({ length: 1_000_000 }, () => 0))).toBe(false);
    let nested: unknown = lone;
    for (let level = 0; level < 200_000; level++) nested = [nested];
    expect(hasIllFormedText(nested)).toBe(true);
  });

  it("flags only surrogate escapes that decode to an unpaired surrogate", () => {
    expect(jsonTextHasIllFormedText('{"a":"\\ud800"}')).toBe(true);
    expect(jsonTextHasIllFormedText('{"a":"\\udc00x"}')).toBe(true);
    expect(jsonTextHasIllFormedText('{"a":"\\ud83d\\ude00"}')).toBe(false);
    // An escaped backslash followed by plain text is not an escape sequence.
    expect(jsonTextHasIllFormedText('{"a":"\\\\ud800"}')).toBe(false);
    expect(jsonTextHasIllFormedText('{"\\ud800":1}')).toBe(true);
    expect(jsonTextHasIllFormedText('{"a":"plain 😀"}')).toBe(false);
    // Text that is not JSON is left for the handler's own parse error.
    expect(jsonTextHasIllFormedText('{"a":"\\ud800"')).toBe(false);
    expect(jsonTextHasIllFormedText("not json \\ud800")).toBe(false);
  });

  it("rejects an ill-formed write body without consuming it and ignores reads and empty bodies", async () => {
    const post = (body?: string) => new Request("https://rendro.test/x", { method: "POST", body });
    const request = post('{"name":"\\ud800"}');
    const error = await requireWellFormedBody(request).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(IllFormedTextError);
    expect(request.bodyUsed).toBe(false);
    const response = (error as IllFormedTextError).response();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: INVALID_TEXT_MESSAGE });
    await expect(requireWellFormedBody(post('{"name":"ok"}'))).resolves.toBeUndefined();
    await expect(requireWellFormedBody(post())).resolves.toBeUndefined();
    await expect(requireWellFormedBody(new Request("https://rendro.test/x"))).resolves.toBeUndefined();
    const get = new Request("https://rendro.test/x?q=%ED%A0%80");
    expect(new URL(get.url).searchParams.get("q")?.isWellFormed()).toBe(true);
    expect(failure(new IllFormedTextError()).status).toBe(400);
  });
});

describe("ill-formed text at the API boundary", () => {
  it.each(transports)("is a 400 validation error, not a backend outage, for account writes and auth (%s)", async (transport) => {
    const f = await fixture();
    const expected = { error: INVALID_TEXT_MESSAGE };
    const bodies: Array<[string, unknown]> = [
      ["/api/auth/update-user", { name: lone }],
      ["/api/auth/update-user", { name: "Fine", image: "a\udc00" }],
      ["/api/auth/sign-up/email", { name: lone, email: "new@example.test", password: "a-long-enough-password" }],
      ["/api/auth/set-initial-password", { newPassword: `password ${lone} long enough` }],
    ];
    for (const [path, body] of bodies) {
      const response = await f.call(transport, path, body);
      expect(response.status, path).toBe(400);
      expect(await response.json(), path).toEqual(expected);
    }
    // Raw escapes, nested keys and a lone low surrogate behave the same way.
    for (const raw of ['{"name":"\\udfff"}', '{"name":"n","\\ud800":1}']) {
      const response = await f.call(transport, "/api/auth/update-user", undefined, raw);
      expect(response.status, raw).toBe(400);
      expect(await response.json(), raw).toEqual(expected);
    }
    expect(await f.name()).toBe("owner");
  });

  it.each(transports)("still accepts valid surrogate pairs, escaped backslashes and malformed JSON keeps its own error (%s)", async (transport) => {
    const f = await fixture();
    const emoji = await f.call(transport, "/api/auth/update-user", { name: "Owner 😀" });
    expect(emoji.status).toBe(200);
    expect(await f.name()).toBe("Owner 😀");
    const literal = await f.call(transport, "/api/auth/update-user", undefined, '{"name":"\\\\ud800"}');
    expect(literal.status).toBe(200);
    expect(await f.name()).toBe("\\ud800");
    const broken = await f.call(transport, "/api/auth/set-initial-password", undefined, '{"newPassword":"\\ud800"');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: "Invalid JSON body" });
  });
});
