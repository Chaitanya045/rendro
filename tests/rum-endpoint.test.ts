import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "@/worker";
import { registerAuthClientIp } from "@/auth-client-ip";
import { dataPoint, sameOriginPost } from "@/rum/route";
import { isRumEvent, parseBeacon, RUM_MAX_BYTES, RUM_MAX_EVENTS, RUM_METRICS, RUM_NAVIGATIONS, RUM_PATH, type RumEvent } from "@/rum/schema";

/*
 * The real-user monitoring beacon (#282): the strict schema, then POST /rum on
 * the real Worker app. Data points carry enumerations, a value and the colo,
 * nothing that names a reader, repository, path, address or session. The
 * in-colo rate limiter is faked: it records the keys it was asked for and
 * answers as each test says.
 */
const site = "http://localhost:3000";
const event: RumEvent = { route: "frame", metric: "switch", value: 42.5, nav: "switch", tier: "memory", preloaded: true };
const beacon = (events: unknown[] = [event]) => JSON.stringify({ v: 1, events });

let points: Array<{ indexes: string[]; blobs: string[]; doubles: number[] }>;
let limited: string[];
let limit: () => Promise<{ success: boolean }>;
const limiter = { limit: ({ key }: { key: string }) => { limited.push(key); return limit(); } };
const env = () => ({ RUM_ANALYTICS: { writeDataPoint: (point: typeof points[number]) => void points.push(point) }, RUM_LIMIT: limiter });

beforeEach(() => {
  points = [];
  limited = [];
  limit = () => Promise.resolve({ success: true });
});

afterEach(() => {
  process.env.SITE_URL = site;
});

function post(body: BodyInit | null, headers: Record<string, string> = {}, bindings: object = env(), cf?: object, ip?: string) {
  const request = new Request(`${site}${RUM_PATH}`, {
    method: "POST", body, duplex: "half",
    headers: { "content-type": "text/plain;charset=UTF-8", "sec-fetch-site": "same-origin", origin: "null", ...headers },
  } as RequestInit);
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  // As the Worker's ingress does with CF-Connecting-IP.
  registerAuthClientIp(request, ip);
  return app.fetch(request, bindings, { waitUntil() {}, passThroughOnException() {}, props: {} });
}

describe("the beacon schema", () => {
  it("accepts every metric on its own routes, with optional tier and preload flags", () => {
    const events: RumEvent[] = [
      { route: "shell", metric: "LCP", value: 812, nav: "cold", tier: "r2" },
      { route: "shell", metric: "CLS", value: 0.02, nav: "bfcache" },
      { route: "shell", metric: "server", value: 3.1, nav: "prerender", tier: "colo" },
      { route: "frame", metric: "load", value: 120, nav: "history", preloaded: false },
      { route: "tree", metric: "response", value: 18, nav: "reload", tier: "shared" },
      { route: "search", metric: "server", value: 9, nav: "back-forward" },
    ];
    expect(parseBeacon(beacon(events))).toEqual(events);
    expect(RUM_METRICS).toContain("switch");
    expect(RUM_NAVIGATIONS).toHaveLength(7);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["another version", JSON.stringify({ v: 2, events: [event] })],
    ["an extra top-level field", JSON.stringify({ v: 1, events: [event], page: "/r/o/r" })],
    ["no events field", JSON.stringify({ v: 1, other: [] })],
    ["events that are not a list", JSON.stringify({ v: 1, events: {} })],
    ["no events", beacon([])],
    ["too many events", beacon(Array.from({ length: RUM_MAX_EVENTS + 1 }, () => event))],
  ])("refuses %s", (_name, text) => {
    expect(parseBeacon(text)).toBeNull();
  });

  it.each([
    ["an unknown field", { ...event, path: "docs/index.md" }],
    ["a prototype key", JSON.parse(`{"route":"frame","metric":"swap","value":1,"nav":"switch","__proto__":{"x":1}}`) as unknown],
    ["a non-object", "frame"],
    ["an array", [event]],
    ["an unknown metric", { ...event, metric: "FID" }],
    ["an unknown route", { ...event, route: "api" }],
    ["a web vital on a frame", { ...event, metric: "LCP" }],
    ["a switch on the shell", { ...event, route: "shell" }],
    ["a response on the shell", { ...event, route: "shell", metric: "response", preloaded: undefined }],
    ["an unknown navigation", { ...event, nav: "soft" }],
    ["a string value", { ...event, value: "42" }],
    ["an infinite value", { ...event, value: Infinity }],
    ["a negative value", { ...event, value: -1 }],
    ["an hour-plus duration", { ...event, value: 3_600_001 }],
    ["an out-of-range CLS", { route: "shell", metric: "CLS", value: 101, nav: "cold" }],
    ["an unknown tier", { ...event, tier: "disk" }],
    ["a non-boolean preload flag", { ...event, preloaded: 1 }],
    ["a preload flag on a request", { route: "tree", metric: "response", value: 1, nav: "cold", preloaded: true }],
  ])("refuses an event with %s", (_name, value) => {
    expect(isRumEvent(value)).toBe(false);
    expect(parseBeacon(beacon([event, value]))).toBeNull();
  });

  it("allows an hour exactly, and a CLS of 100", () => {
    expect(isRumEvent({ ...event, value: 3_600_000 })).toBe(true);
    expect(isRumEvent({ route: "shell", metric: "CLS", value: 100, nav: "cold" })).toBe(true);
  });
});

describe("POST /rum", () => {
  it("writes one data point per event: enumerations, the value and the colo, nothing else", async () => {
    const response = await post(beacon([event, { route: "shell", metric: "TTFB", value: 80, nav: "cold" }]), { cookie: "better-auth.session_token=reader-token.sig" }, env(), { colo: "SIN" }, "203.0.113.9");
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(points).toEqual([
      { indexes: ["switch"], blobs: ["frame", "switch", "switch", "memory", "1", "SIN"], doubles: [42.5] },
      { indexes: ["TTFB"], blobs: ["shell", "TTFB", "cold", "", "", "SIN"], doubles: [80] },
    ]);
    // One token per accepted beacon, keyed on the verified address, which is never written.
    expect(limited).toEqual(["203.0.113.9"]);
    expect(JSON.stringify(points)).not.toContain("203.0.113");
  });

  it("encodes a preloaded=false flag and drops a colo that is not one", () => {
    expect(dataPoint({ ...event, preloaded: false }, "").blobs[4]).toBe("0");
  });

  it("records an empty colo where the platform names none or something unexpected", async () => {
    expect((await post(beacon(), {}, env(), { colo: "../x" })).status).toBe(204);
    expect((await post(beacon())).status).toBe(204);
    expect(points.map(point => point.blobs[5])).toEqual(["", ""]);
  });

  it("accepts and drops the data when the dataset or the limiter is not bound, without reading it or spending a token", async () => {
    const response = await post("not even JSON", {}, {});
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    // Either binding alone is not enough, and a binding of the wrong shape is no binding.
    expect((await post(beacon(), {}, { RUM_LIMIT: limiter })).status).toBe(204);
    expect((await post(beacon(), {}, { RUM_ANALYTICS: env().RUM_ANALYTICS })).status).toBe(204);
    expect((await post(beacon(), {}, { RUM_ANALYTICS: {}, RUM_LIMIT: limiter })).status).toBe(204);
    expect((await post(beacon(), {}, { RUM_ANALYTICS: env().RUM_ANALYTICS, RUM_LIMIT: {} })).status).toBe(204);
    expect(limited).toEqual([]);
    expect((await post(null, {}, {})).status).toBe(204);
    // A body whose cancellation fails is still dropped quietly.
    const stubborn = new ReadableStream<Uint8Array>({ cancel() { throw new Error("cannot cancel"); } });
    expect((await post(stubborn, {}, {})).status).toBe(204);
    expect(points).toEqual([]);
  });

  it.each([
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
    ["a same-site sibling", { "sec-fetch-site": "same-site" }],
    ["a user-typed request", { "sec-fetch-site": "none" }],
    ["a same-origin claim with another origin", { origin: "https://evil.test" }],
    ["no fetch metadata and no origin", { "sec-fetch-site": "", origin: "" }],
    ["no fetch metadata and a null origin", { "sec-fetch-site": "", origin: "null" }],
  ])("refuses %s, with or without a dataset", async (_name, headers) => {
    const cleaned = Object.fromEntries(Object.entries({ "sec-fetch-site": "same-origin", origin: "null", ...headers }).filter(([, value]) => value !== ""));
    for (const bindings of [env(), {}]) {
      const response = await app.fetch(new Request(`${site}${RUM_PATH}`, { method: "POST", body: beacon(), headers: { "content-type": "text/plain", ...cleaned } }), bindings);
      expect(response.status).toBe(403);
    }
    expect(points).toEqual([]);
    expect(limited).toEqual([]);
  });

  it("accepts an exact origin, with or without fetch metadata", async () => {
    expect((await post(beacon(), { origin: site })).status).toBe(204);
    const bare = new Request(`${site}${RUM_PATH}`, { method: "POST", body: beacon(), headers: { "content-type": "application/json", origin: site } });
    expect((await app.fetch(bare, env())).status).toBe(204);
    expect(points).toHaveLength(2);
  });

  it("decides same-origin against SITE_URL, and refuses everything when it is unusable", async () => {
    expect(sameOriginPost(new Request(`${site}/rum`, { headers: { origin: site } }), null)).toBe(false);
    process.env.SITE_URL = "not a url";
    expect((await post(beacon(), { origin: site })).status).toBe(403);
    delete process.env.SITE_URL;
    // Unset, the request's own origin is the site.
    expect((await post(beacon(), { origin: site })).status).toBe(204);
  });

  it("refuses other content types, oversized and unreadable bodies, and malformed beacons", async () => {
    expect((await post(beacon(), { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    const unlabelled = new Request(`${site}${RUM_PATH}`, { method: "POST", body: new Blob([beacon()]), headers: { "sec-fetch-site": "same-origin" } });
    expect((await app.fetch(unlabelled, env())).status).toBe(415);
    expect((await post("x".repeat(RUM_MAX_BYTES + 1))).status).toBe(413);
    expect((await post(beacon(), { "content-length": String(RUM_MAX_BYTES + 1) })).status).toBe(413);
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("reset")); } });
    expect((await post(broken, {})).status).toBe(400);
    expect((await post(beacon([{ ...event, user: "u-1" }]))).status).toBe(400);
    expect((await post("")).status).toBe(400);
    expect(points).toEqual([]);
    // Validation runs first: a beacon that would not be written spends no token.
    expect(limited).toEqual([]);
  });

  it("drops a beacon over the limit (204, nothing written), and one the limiter cannot decide", async () => {
    limit = () => Promise.resolve({ success: false });
    const over = await post(beacon(), {}, env(), undefined, "198.51.100.4");
    expect(over.status).toBe(204);
    expect(over.headers.get("Cache-Control")).toBe("private, no-store");
    limit = () => Promise.reject(new Error("limiter unavailable"));
    expect((await post(beacon(), {}, env(), undefined, "198.51.100.4")).status).toBe(204);
    expect(points).toEqual([]);
    expect(limited).toEqual(["198.51.100.4", "198.51.100.4"]);
  });

  it("puts requests without a verified address in one shared bucket", async () => {
    expect((await post(beacon())).status).toBe(204);
    expect(limited).toEqual(["unverified"]);
    expect(points).toHaveLength(1);
  });

  it("is POST only: other methods are the ordinary 404", async () => {
    expect((await app.fetch(new Request(`${site}${RUM_PATH}`), env())).status).toBe(404);
  });
});
